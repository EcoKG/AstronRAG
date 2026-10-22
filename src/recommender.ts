import { isRecommendable, type Ontology } from "./ontology.js";
import { z } from "zod";
import type { RecommendationFeedback, RuleStatistics } from "./stores/memory-store.js";

const count = z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const feedbackInputSchema = z.object({
	event_id: z.string().uuid(),
	policy_version: z.string().regex(/^[a-zA-Z0-9.-]{1,64}$/),
	catalog_revision: z.string().regex(/^[a-zA-Z0-9.-]{1,64}$/),
	rule_id: z.string().regex(/^rule:[a-z0-9-]{1,100}$/),
	model: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,100}$/),
	effort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]),
	role: z.enum(["research", "plan", "impl", "review", "ship", "ops", "coordinator"]),
	size: z.enum(["small", "medium", "large"]).optional(),
	risk: z.enum(["normal", "high"]),
	novelty: z.enum(["new", "existing"]).optional(),
	cross_review_of: z.string().trim().min(1).max(100).optional(),
	input_tokens: count, output_tokens: count,
	cost_usd: z.number().finite().nonnegative().nullable(),
	duration_ms: count, reverts: count,
	verdict: z.enum(["pass", "fail", "inconclusive"]),
}).strict();

export type Role = "research" | "plan" | "impl" | "review" | "ship" | "ops" | "coordinator";

export interface Classification {
	taskType: string;
	difficulty: "normal" | "high";
	risk: "normal" | "high";
}

export interface Recommendation {
	policy_version: string;
	catalog_revision: string;
	rule_id: string;
	model: string;
	effort: string;
	role: Role;
	size: "small" | "medium" | "large";
	novelty: "new" | "existing";
	classification: Classification;
	reasons: string[];
	appliedConstraints: Array<{ id: string; reason: string }>;
	evidence: string[];
	candidates: Array<{ model: string; effort: string }>;
	ruleConfidence: number;
}

export interface StructuredSignals {
	size?: "small" | "medium" | "large";
	risk?: "normal" | "high";
	novelty?: "new" | "existing";
	cross_review_of?: string;
}

type ConditionContext = { description: string; role: Role; classification: Classification; size?: string; novelty: string; cross_family: string; analysis: string };
type ConditionEvaluator = (values: string[], context: ConditionContext) => boolean;

export const conditionEvaluators: Record<string, ConditionEvaluator> = {
	role: (values, context) => values.includes(context.role),
	keyword: (values, context) => values.some((value) => context.description.toLocaleLowerCase().includes(value.toLocaleLowerCase())),
	difficulty: (values, context) => values.includes(context.classification.difficulty),
	risk: (values, context) => values.includes(context.classification.risk),
	size: (values, context) => values.includes(context.size ?? "medium"),
	novelty: (values, context) => values.includes(context.novelty),
	cross_family: (values, context) => values.includes(context.cross_family),
	analysis: (values, context) => values.includes(context.analysis),
};

export function classifyTask(description: string, role: Role, ontology?: Ontology, signals: StructuredSignals = {}): Classification {
	const text = description.toLocaleLowerCase();
	const risky = signals.risk === "high" || ontology?.classification?.securityKeywords.some((keyword) => text.includes(keyword.toLowerCase()));
	const difficult = risky || ontology?.classification?.difficultKeywords.some((keyword) => text.includes(keyword.toLowerCase())) || role === "plan" || role === "review";
	return { taskType: text.includes("code") || text.includes("구현") ? "coding" : "knowledge", difficulty: difficult ? "high" : "normal", risk: risky ? "high" : "normal" };
}

export function recommendModel(ontology: Ontology, description: string, role: Role, platform?: "claude" | "codex", signals: StructuredSignals = {}, statistics: RuleStatistics = {}): Recommendation {
	if (platform !== undefined && platform !== "claude" && platform !== "codex") throw new Error(`unsupported platform: ${platform}`);
	const classification = classifyTask(description, role, ontology, signals);
	const text = description.toLowerCase();
	const includes = (keywords: string[] = []) => keywords.some((keyword) => text.includes(keyword.toLowerCase()));
	const source = signals.cross_review_of ? resolveModel(ontology, signals.cross_review_of) : undefined;
	const sourcePlatform = source ? source.platforms.includes("platform:codex") ? "codex" : "claude" : "none";
	// 작은 작업 키워드는 부분 문자열 일치라 어려운 작업 키워드가 함께 있으면 small 로 보지 않는다.
	const size = signals.size ?? (includes(ontology.classification?.smallKeywords) && !includes(ontology.classification?.difficultKeywords) ? "small" : "medium");
	const novelty = signals.novelty ?? (includes(ontology.classification?.newKeywords) ? "new" : "existing");
	const context: ConditionContext = {
		description, role, classification, size, novelty,
		cross_family: sourcePlatform,
		analysis: includes(ontology.classification?.analysisKeywords) ? "yes" : "no",
	};
	const platformRules = ontology.rules.filter((rule) => platform === undefined ? (rule.platform ?? "claude") === "claude" || (sourcePlatform === "claude" && rule.conditions.some((condition) => condition.type === "cross_family")) : (rule.platform ?? "claude") === platform);
	const matching = platformRules.filter((rule) => rule.conditions.every((condition) => conditionEvaluators[condition.type](condition.values, context)));
	const eligible = matching.filter((rule) => isRecommendable(ontology, rule.model, rule["@id"]));
	const conditional = eligible.filter((rule) => rule.conditions.length > 0);
	const allowed = conditional.length > 0 ? conditional : eligible;
	const confidence = (rule: Ontology["rules"][number]) => calculateRuleConfidence(rule.confidence, statistics[rule["@id"]], ontology.confidencePolicy.minimumSamples, ontology.confidencePolicy.priorWeight);
	allowed.sort((a, b) => b.priority - a.priority || confidence(b) - confidence(a) || a["@id"].localeCompare(b["@id"]));
	const candidates = allowed.filter((rule, index) => allowed.findIndex((other) => other.model === rule.model) === index);
	const selected = candidates[0];
	if (!selected) throw new Error("no allowed recommendation rule");
	const links = new Map(ontology.evidence.map((item) => [item["@id"], item.link]));
	const reasons = [selected.reason];
	if (source && source.platforms.includes("platform:codex") === (selected.platform === "codex")) reasons.push("cross-review unavailable: explicit platform or higher-priority policy");
	return {
		model: selected.model, effort: selected.effort, role, size, novelty, classification, reasons,
		appliedConstraints: ontology.constraints.filter((constraint) => (constraint.kind === "exclude" || constraint.kind === "evidence-required") && matching.some((rule) => constraint.models.includes(rule.model) && !isRecommendable(ontology, rule.model, rule["@id"]))).map((constraint) => ({ id: constraint["@id"], reason: "reason" in constraint ? constraint.reason : "" })).sort((a, b) => a.id.localeCompare(b.id)),
		evidence: selected.evidence.map((ref) => links.get(ref)).filter((link): link is string => Boolean(link)).sort(),
		candidates: candidates.map((rule) => ({ model: rule.model, effort: rule.effort })),
		ruleConfidence: confidence(selected), policy_version: ontology.policy_version, catalog_revision: ontology.catalog_revision, rule_id: selected["@id"],
	};
}

/** 등록된 ID 또는 유일한 별칭을 모델로 해석한다. */
export function resolveModel(ontology: Ontology, name: string): Ontology["models"][number] {
	const matches = ontology.models.filter((model) => [model.id, ...model.aliases].some((alias) => alias.toLowerCase() === name.toLowerCase()));
	if (matches.length !== 1) throw new Error("unknown or ambiguous model identifier");
	return matches[0];
}

/** 결정 표본 하한을 넘으면 사전 신뢰도와 성공 비율을 결합한다. */
export function calculateRuleConfidence(prior: number, stats: { samples: number; successes: number } = { samples: 0, successes: 0 }, minimumSamples = 20, priorWeight = 20): number {
	return stats.samples < minimumSamples ? prior : (priorWeight * prior + stats.successes) / (priorWeight + stats.samples);
}

/** 현재 정책의 규칙·모델·effort·조건과 피드백 식별자를 검증한다. */
export function validateFeedback(ontology: Ontology, value: unknown): RecommendationFeedback {
	const event = feedbackInputSchema.parse(value);
	if (event.policy_version !== ontology.policy_version || event.catalog_revision !== ontology.catalog_revision) throw new Error("feedback version mismatch");
	const rule = ontology.rules.find((rule) => rule["@id"] === event.rule_id);
	if (!rule || rule.model !== event.model || rule.effort !== event.effort || !isRecommendable(ontology, rule.model, rule["@id"])) throw new Error("feedback rule/model/effort mismatch");
	if (event.cross_review_of) event.cross_review_of = resolveModel(ontology, event.cross_review_of).id;
	const source = event.cross_review_of ? resolveModel(ontology, event.cross_review_of) : undefined;
	const context: ConditionContext = { description: "", role: event.role, classification: { taskType: "knowledge", risk: event.risk, difficulty: "normal" }, size: event.size, novelty: event.novelty ?? "existing", cross_family: source ? source.platforms.includes("platform:codex") ? "codex" : "claude" : "none", analysis: "no" };
	for (const condition of rule.conditions) {
		if (["keyword", "difficulty", "analysis"].includes(condition.type)) continue;
		if (!conditionEvaluators[condition.type](condition.values, context)) throw new Error("feedback structured signals mismatch");
	}
	return event;
}
