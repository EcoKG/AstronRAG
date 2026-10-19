import type { Ontology } from "./ontology.js";

export type Role = "research" | "plan" | "impl" | "review" | "ship" | "ops" | "coordinator";

export interface Classification {
	taskType: string;
	difficulty: "normal" | "high";
	risk: "normal" | "high";
}

export interface Recommendation {
	model: string;
	effort: string;
	role: Role;
	classification: Classification;
	reasons: string[];
	appliedConstraints: Array<{ id: string; reason: string }>;
	evidence: string[];
	candidates: Array<{ model: string; effort: string }>;
	ruleConfidence: number;
}

type ConditionEvaluator = (values: string[], context: { description: string; role: Role; classification: Classification }) => boolean;

export const conditionEvaluators: Record<string, ConditionEvaluator> = {
	role: (values, context) => values.includes(context.role),
	keyword: (values, context) => values.some((value) => context.description.toLocaleLowerCase().includes(value.toLocaleLowerCase())),
	difficulty: (values, context) => values.includes(context.classification.difficulty),
	risk: (values, context) => values.includes(context.classification.risk),
};

const ownerExceptionEvidenceId = "evidence:owner-exception";

export function classifyTask(description: string, role: Role): Classification {
	const text = description.toLocaleLowerCase();
	const risky = ["security", "보안", "concurrent", "동시", "timing", "타이밍"].some((keyword) => text.includes(keyword));
	const difficult = risky || ["large code", "대형 코드", "architecture", "아키텍처"].some((keyword) => text.includes(keyword)) || role === "plan" || role === "review";
	return { taskType: text.includes("code") || text.includes("구현") ? "coding" : "knowledge", difficulty: difficult ? "high" : "normal", risk: risky ? "high" : "normal" };
}

export function recommendModel(ontology: Ontology, description: string, role: Role): Recommendation {
	const classification = classifyTask(description, role);
	const context = { description, role, classification };
	const conditionalMatches = ontology.rules.filter((rule) => rule.conditions.length > 0 && rule.conditions.every((condition) => conditionEvaluators[condition.type](condition.values, context)));
	const defaultConstraint = ontology.constraints.find((item) => item.kind === "default");
	const defaultRules = ontology.rules.filter((rule) => rule.conditions.length === 0 && defaultConstraint?.models.includes(rule.model));
	const usedDefault = conditionalMatches.length === 0;
	const initialRules = usedDefault ? defaultRules : conditionalMatches;
	const excludeConstraints = ontology.constraints.filter((item) => item.kind === "exclude");
	const excluded = new Set(excludeConstraints.flatMap((item) => item.models));
	const exclusionAllowedRules = initialRules.filter((rule) => !excluded.has(rule.model));
	const blockedByDefault = defaultConstraint
		? exclusionAllowedRules.filter((rule) => rule.model.startsWith("claude-") && !defaultConstraint.models.includes(rule.model) && !rule.evidence.includes(ownerExceptionEvidenceId))
		: [];
	const ownerAllowedRules = exclusionAllowedRules.filter((rule) => !blockedByDefault.includes(rule));
	const usedConstraintFallback = !usedDefault && initialRules.length > 0 && ownerAllowedRules.length === 0;
	const matchedRules = usedConstraintFallback ? defaultRules : ownerAllowedRules;
	const allowedRules = matchedRules.filter((rule) => !excluded.has(rule.model));
	const byCandidateOrder = [...allowedRules].sort((a, b) => b.confidence - a.confidence || b.priority - a.priority || a["@id"].localeCompare(b["@id"]));
	const candidateRules = [...new Map(byCandidateOrder.map((rule) => [rule.model, rule])).values()];
	const selected = [...candidateRules].sort((a, b) => b.priority - a.priority || b.confidence - a.confidence || a["@id"].localeCompare(b["@id"]))[0];
	if (!selected) throw new Error("no allowed recommendation rule");
	const evidenceById = new Map(ontology.evidence.map((item) => [item["@id"], item.link]));
	const appliedConstraints = excludeConstraints
		.filter((constraint) => initialRules.some((rule) => constraint.models.includes(rule.model)))
		.map((constraint) => ({ id: constraint["@id"], reason: constraint.reason }));
	if ((usedDefault || blockedByDefault.length > 0 || usedConstraintFallback) && defaultConstraint) appliedConstraints.push({ id: defaultConstraint["@id"], reason: defaultConstraint.reason });
	appliedConstraints.sort((a, b) => a.id.localeCompare(b.id));
	return {
		model: selected.model,
		effort: selected.effort,
		role,
		classification,
		reasons: [selected.reason],
		appliedConstraints,
		evidence: selected.evidence.map((item) => evidenceById.get(item)).filter((item): item is string => Boolean(item)).sort(),
		candidates: candidateRules.map((rule) => ({ model: rule.model, effort: rule.effort })),
		ruleConfidence: selected.confidence,
	};
}
