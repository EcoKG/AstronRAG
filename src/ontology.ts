import fs from "node:fs";
import { createRequire } from "node:module";
import { z } from "zod";

const require = createRequire(import.meta.url);

interface YamlModule {
	JSON_SCHEMA: unknown;
	load(source: string, options: { schema: unknown }): unknown;
}

const id = z.string().min(1);
const namedNode = z.object({ "@id": id, name: z.string().min(1) }).strict();
const evidenceNode = z.object({ "@id": id, label: z.string().min(1), link: z.string().min(1) }).strict();
const sourceNode = z.object({
	url: z.string().url(),
	checkedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	fields: z.array(z.string().min(1)).min(1),
}).strict();
const priceTier = z.object({
	promptTokens: z.number().int().positive().nullable(),
	input: z.number().nonnegative(),
	cacheWrite5m: z.number().nonnegative(),
	cacheWrite1h: z.number().nonnegative(),
	cacheRead: z.number().nonnegative(),
	output: z.number().nonnegative(),
}).strict();
const modelNode = z.object({
	"@id": id,
	id: z.string().min(1),
	name: z.string().min(1),
	aliases: z.array(z.string().trim().min(1)).default([]),
	family: z.string().min(1).optional(),
	latest: z.boolean().default(false),
	evidence: z.array(id).optional(),
	checkedAt: z.string().date().optional(),
	contextTokens: z.number().int().positive(),
	maxOutputTokens: z.number().int().positive().optional(),
	defaultEffort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]),
	supportedEfforts: z.array(z.enum(["low", "medium", "high", "xhigh", "max", "ultra"])).min(1),
	features: z.array(z.string().min(1)).min(1),
	platforms: z.array(id).min(1),
	pricing: z.array(priceTier).min(1).optional(),
	sources: z.array(sourceNode).min(1).optional(),
}).strict().superRefine((model, context) => {
	const codexOnly = model.platforms.length === 1 && model.platforms[0] === "platform:codex";
	if (!codexOnly) for (const field of ["pricing", "maxOutputTokens", "sources"] as const) {
		if (model[field] === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is required for non-Codex models` });
	}
});
const excludeConstraintNode = z.object({
	"@id": id,
	kind: z.literal("exclude"),
	models: z.array(z.string().min(1)).min(1),
	reason: z.string().min(1),
	evidence: z.array(id).optional(),
}).strict();
const defaultConstraintNode = z.object({
	"@id": id,
	kind: z.literal("default"),
	platform: z.enum(["claude", "codex"]).optional(),
	models: z.array(z.string().min(1)).min(1),
	reason: z.string().min(1),
}).strict();
const ownerExceptionConstraintNode = z.object({
	"@id": id,
	kind: z.literal("owner-exception"),
	rule: id,
	approvedBy: z.literal("p1"),
	approvedAt: z.string().date(),
	link: z.string().url(),
}).strict();
const policyConstraintNode = z.object({
	"@id": id,
	kind: z.enum(["latest-only", "evidence-required"]),
	models: z.array(z.string().min(1)).default([]),
	reason: z.string().min(1),
	evidence: z.array(id).min(1),
}).strict();
const constraintNode = z.discriminatedUnion("kind", [excludeConstraintNode, defaultConstraintNode, ownerExceptionConstraintNode, policyConstraintNode]);
const ruleNode = z.object({
	"@id": id,
	platform: z.enum(["claude", "codex"]).optional(),
	priority: z.number().int(),
	conditions: z.array(z.object({ type: z.enum(["role", "keyword", "difficulty", "risk", "size", "novelty", "cross_family", "analysis"]), values: z.array(z.string().min(1)).min(1) }).strict()),
	model: z.string().min(1),
	effort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]),
	reason: z.string().min(1),
	evidence: z.array(id).min(1),
	confidence: z.number().min(0).max(1),
}).strict();
const graphNode = z.object({ "@id": id, name: z.string().min(1), nodes: z.array(id).min(1) }).strict();

const ontologyNodeSchema = z.object({
	version: z.literal(1),
	policy_version: z.string().min(1).default("legacy"),
	catalog_revision: z.string().min(1).default("legacy"),
	confidencePolicy: z.object({ minimumSamples: z.number().int().positive(), priorWeight: z.number().int().positive() }).strict().default({ minimumSamples: 20, priorWeight: 20 }),
	classification: z.object({ securityKeywords: z.array(z.string().min(1)), difficultKeywords: z.array(z.string().min(1)), smallKeywords: z.array(z.string().min(1)), newKeywords: z.array(z.string().min(1)), analysisKeywords: z.array(z.string().min(1)) }).strict().optional(),
	documentSources: z.array(z.string().url()).optional(),
	taskTypes: z.array(namedNode).min(1),
	difficulties: z.array(namedNode).min(1),
	risks: z.array(namedNode).min(1),
	nodeRoles: z.array(namedNode).min(1),
	models: z.array(modelNode).min(1),
	efforts: z.array(namedNode).min(1),
	platforms: z.array(namedNode).min(1),
	graphs: z.array(graphNode).min(1),
	resultMetrics: z.array(namedNode).min(1),
	evidence: z.array(evidenceNode).min(1),
	constraints: z.array(constraintNode).min(1),
	rules: z.array(ruleNode).min(1),
}).strict();

export const ontologySchema = ontologyNodeSchema.superRefine((ontology, context) => {
	const ruleIds = new Set(ontology.rules.map((rule) => rule["@id"]));
	ontology.constraints.forEach((constraint, index) => {
		if (constraint.kind === "owner-exception" && !ruleIds.has(constraint.rule)) {
			context.addIssue({ code: z.ZodIssueCode.custom, path: ["constraints", index, "rule"], message: `unregistered owner-exception rule: ${constraint.rule}` });
		}
	});
	try {
		validateReferences(ontology);
	} catch (error) {
		context.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : String(error) });
	}
});

export type Ontology = z.infer<typeof ontologyNodeSchema>;

function assertSafeYaml(source: string): void {
	if (/(?:^\s*|[{,]\s*)<<\s*:/m.test(source)) throw new Error("YAML merge keys are not allowed");
	let depth = 0;
	for (const character of source) {
		if (character === "{" || character === "[") depth++;
		if (character === "}" || character === "]") depth--;
		if (depth > 64) throw new Error("YAML depth exceeds 64");
	}
}

function validateReferences(ontology: Ontology): Ontology {
	const ids: string[] = [];
	for (const collection of [ontology.taskTypes, ontology.difficulties, ontology.risks, ontology.nodeRoles, ontology.models, ontology.efforts, ontology.platforms, ontology.graphs, ontology.resultMetrics, ontology.evidence, ontology.constraints, ontology.rules]) {
		ids.push(...collection.map((node) => node["@id"]));
	}
	const duplicates = ids.filter((value, index) => ids.indexOf(value) !== index);
	if (duplicates.length > 0) throw new Error(`duplicate @id: ${[...new Set(duplicates)].join(", ")}`);
	const allIds = new Set(ids);
	const modelIds = new Map(ontology.models.map((model) => [model.id, model]));
	if (modelIds.size !== ontology.models.length) throw new Error("duplicate model id");
	const aliases = new Set<string>();
	const latestFamilies = new Set<string>();
	for (const model of ontology.models) {
		for (const name of [model.id, ...model.aliases]) {
			const key = name.toLowerCase();
			if (aliases.has(key)) throw new Error(`ambiguous model alias: ${name}`);
			aliases.add(key);
		}
		if (model.latest && model.family) {
			if (latestFamilies.has(model.family)) throw new Error(`duplicate latest family: ${model.family}`);
			latestFamilies.add(model.family);
		}
	}
	const roleIds = new Set(ontology.nodeRoles.map((role) => role["@id"].replace(/^role:/, "")));
	const requiredRoles = ["coordinator", "impl", "ops", "plan", "research", "review", "ship"];
	if (JSON.stringify([...roleIds].sort()) !== JSON.stringify(requiredRoles)) throw new Error("node roles must match the registered role set");
	const platformIds = new Set(ontology.platforms.map((platform) => platform["@id"]));
	const evidenceIds = new Set(ontology.evidence.map((evidence) => evidence["@id"]));
	const effortIds = new Set(ontology.efforts.map((effort) => effort["@id"]));
	for (const model of ontology.models) {
		if (model["@id"] !== `model:${model.id}`) throw new Error(`model @id does not match id: ${model.id}`);
		for (const platform of model.platforms) if (!platformIds.has(platform)) throw new Error(`unregistered platform: ${platform}`);
		if (!model.supportedEfforts.includes(model.defaultEffort)) throw new Error(`unsupported default effort for ${model.id}`);
		for (const effort of model.supportedEfforts) if (!effortIds.has(`effort:${effort}`)) throw new Error(`unregistered effort: ${effort}`);
		for (const ref of model.evidence ?? []) if (!evidenceIds.has(ref)) throw new Error(`unresolved model evidence: ${ref}`);
	}
	for (const constraint of ontology.constraints) {
		if ("evidence" in constraint) for (const ref of constraint.evidence ?? []) if (!evidenceIds.has(ref)) throw new Error(`unresolved constraint evidence: ${ref}`);
		if (constraint.kind === "evidence-required") for (const ref of constraint.models) if (!modelIds.has(ref)) throw new Error(`unregistered constrained model: ${ref}`);
		if (constraint.kind === "default") {
			if (constraint.platform && !platformIds.has(`platform:${constraint.platform}`)) throw new Error(`unregistered constraint platform: ${constraint.platform}`);
			for (const id of constraint.models) {
				const model = modelIds.get(id);
				if (!model) throw new Error(`unregistered default model: ${id}`);
				if (model.platforms.includes("platform:codex") !== ((constraint.platform ?? "claude") === "codex")) throw new Error(`default model platform mismatch: ${id}`);
			}
		}
	}
	for (const graph of ontology.graphs) {
		for (const ref of graph.nodes) if (!allIds.has(ref)) throw new Error(`unresolved graph reference: ${ref}`);
	}
	for (const rule of ontology.rules) {
		const model = modelIds.get(rule.model);
		if (!model) throw new Error(`unregistered model: ${rule.model}`);
		if (rule.platform && !platformIds.has(`platform:${rule.platform}`)) throw new Error(`unregistered rule platform: ${rule.platform}`);
		if (model.platforms.includes("platform:codex") !== ((rule.platform ?? "claude") === "codex")) throw new Error(`rule model platform mismatch: ${rule.model}`);
		if (!model.supportedEfforts.includes(rule.effort)) throw new Error(`unsupported effort ${rule.effort} for ${rule.model}`);
		for (const ref of rule.evidence) if (!evidenceIds.has(ref)) throw new Error(`unresolved evidence reference: ${ref}`);
		for (const condition of rule.conditions) {
			if (condition.type === "role") for (const role of condition.values) if (!roleIds.has(role)) throw new Error(`unregistered role: ${role}`);
			const enums: Record<string, string[]> = { risk: ["normal", "high"], difficulty: ["normal", "high"], size: ["small", "medium", "large"], novelty: ["new", "existing"], cross_family: ["claude", "codex", "none"], analysis: ["yes", "no"] };
			if (enums[condition.type]) for (const value of condition.values) if (!enums[condition.type].includes(value)) throw new Error(`invalid ${condition.type}: ${value}`);
		}
	}
	return ontology;
}

export function parseOntology(source: string): Ontology {
	assertSafeYaml(source);
	const yaml = require("js-yaml") as YamlModule;
	const parsed = yaml.load(source, { schema: yaml.JSON_SCHEMA });
	return ontologySchema.parse(parsed);
}

export function loadOntology(file: string): Ontology {
	return parseOntology(fs.readFileSync(file, "utf8"));
}

export const modelCatalogSchema = z.object({
	catalog_revision: z.string().min(1),
	models: z.array(z.object({
		id: z.string().min(1), aliases: z.array(z.string().min(1)), platform: z.enum(["claude", "codex"]),
		contextTokens: z.number().int().positive().nullable(), maxOutputTokens: z.number().int().positive().nullable(),
		supportedEfforts: z.array(z.enum(["low", "medium", "high", "xhigh", "max", "ultra"])).min(1),
		pricing: z.array(priceTier).min(1).nullable(), sourceUrls: z.array(z.string().url()), evidence: z.array(z.string().min(1)),
		checkedAt: z.string().date().nullable(), excluded: z.boolean(), recommendable: z.boolean(),
	}).strict()),
}).strict();

/** 모델에 적용되는 제외·최신성·근거 제약을 검사한다. */
export function isRecommendable(ontology: Ontology, modelId: string, ruleId?: string): boolean {
	const model = ontology.models.find((item) => item.id === modelId);
	if (!model) return false;
	if (ontology.constraints.some((item) => item.kind === "exclude" && item.models.includes(modelId))) return false;
	if (ontology.constraints.some((item) => item.kind === "latest-only") && !model.latest) return false;
	if (ontology.constraints.some((item) => item.kind === "evidence-required" && item.models.includes(modelId))) {
		return ontology.constraints.some((item) => item.kind === "owner-exception" && (!ruleId || item.rule === ruleId) && ontology.rules.some((rule) => rule["@id"] === item.rule && rule.model === modelId && rule.evidence.length > 0));
	}
	return true;
}

/** 같은 온톨로지의 모델 사양과 추천 가능 여부를 반환한다. */
export function modelCatalog(ontology: Ontology): z.infer<typeof modelCatalogSchema> {
	const links = new Map(ontology.evidence.map((item) => [item["@id"], item.link]));
	return modelCatalogSchema.parse({
		catalog_revision: ontology.catalog_revision,
		models: [...ontology.models].sort((a, b) => a.id.localeCompare(b.id)).map((model) => ({
			id: model.id, aliases: model.aliases, platform: model.platforms.includes("platform:codex") ? "codex" : "claude",
			contextTokens: model.contextTokens, maxOutputTokens: model.maxOutputTokens ?? null, supportedEfforts: model.supportedEfforts,
			pricing: model.pricing ?? null, sourceUrls: [...new Set(model.sources?.map((source) => source.url) ?? [])].sort(),
			evidence: (model.evidence ?? []).map((ref) => links.get(ref)).filter((link): link is string => Boolean(link)).sort(),
			checkedAt: model.checkedAt ?? model.sources?.map((source) => source.checkedAt).sort()[0] ?? null,
			excluded: ontology.constraints.some((constraint) => constraint.kind === "exclude" && constraint.models.includes(model.id)),
			recommendable: ontology.rules.some((rule) => rule.model === model.id && isRecommendable(ontology, model.id, rule["@id"])),
		})),
	});
}
