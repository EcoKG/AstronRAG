import fs from "node:fs";
import path from "node:path";

export interface OfficialModel {
	"@id": string;
	id: string;
	name: string;
	contextTokens: number;
	maxOutputTokens: number;
	defaultEffort: "low" | "medium" | "high" | "xhigh" | "max";
	supportedEfforts: Array<"low" | "medium" | "high" | "xhigh" | "max">;
	features: string[];
	platforms: string[];
	pricing: Array<{ promptTokens: number | null; input: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number; output: number }>;
	sources: Array<{ url: string; checkedAt: string; fields: string[] }>;
}

export interface ModelDiff {
	path: string;
	kind: "added" | "changed" | "removed";
	previous: unknown;
	current: unknown;
	sourceUrl: string;
	checkedAt: string;
}

const requiredFiles = ["models-overview.md", "prompt-caching.md", "effort.md", "features.md"];

function withinWorkspace(candidate: string, workspace: string): string {
	const root = path.resolve(workspace);
	const resolved = path.resolve(candidate);
	if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("docs directory must be inside workspace");
	return resolved;
}

function parseDocument(file: string): { url: string; checkedAt: string; rows: string[][] } {
	const text = fs.readFileSync(file, "utf8");
	const url = text.match(/^Source-URL:\s*(https:\/\/\S+)$/m)?.[1];
	const checkedAt = text.match(/^Checked-At:\s*(\d{4}-\d{2}-\d{2})$/m)?.[1];
	if (!url || !checkedAt) throw new Error(`missing source metadata: ${path.basename(file)}`);
	const rows = text.split(/\r?\n/).filter((line) => /^\|.*\|$/.test(line)).map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim()));
	if (rows.length < 3) throw new Error(`missing table: ${path.basename(file)}`);
	return { url, checkedAt, rows: rows.slice(2) };
}

function number(value: string, field: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid ${field}`);
	return parsed;
}

function mergeSources(sources: OfficialModel["sources"]): OfficialModel["sources"] {
	const merged = new Map<string, OfficialModel["sources"][number]>();
	for (const source of sources) {
		const key = `${source.url}\n${source.checkedAt}`;
		const current = merged.get(key);
		merged.set(key, { ...source, fields: [...new Set([...(current?.fields ?? []), ...source.fields])] });
	}
	return [...merged.values()].sort((a, b) => a.url.localeCompare(b.url));
}

export function collectOfficialModels(docsDir: string, workspace = process.cwd()): OfficialModel[] {
	const directory = withinWorkspace(docsDir, workspace);
	for (const name of requiredFiles) if (!fs.existsSync(path.join(directory, name))) throw new Error(`missing required fixture: ${name}`);
	const overview = parseDocument(path.join(directory, "models-overview.md"));
	const prices = parseDocument(path.join(directory, "prompt-caching.md"));
	const efforts = parseDocument(path.join(directory, "effort.md"));
	const features = parseDocument(path.join(directory, "features.md"));
	const effortMap = new Map(efforts.rows.map(([model, values]) => [model, values.split(",").map((value) => value.trim())]));
	const featureMap = new Map(features.rows.map(([model, thinking, tools, vision]) => [model, { thinking, tools, vision }]));
	const priceMap = new Map<string, OfficialModel["pricing"]>();
	for (const [model, tier, input, cacheWrite5m, cacheWrite1h, cacheRead, output] of prices.rows) {
		const promptTokens = tier === "all" || tier.startsWith(">") ? null : number(tier.replace(/\D/g, ""), "prompt tier");
		const value = { promptTokens, input: number(input, "input"), cacheWrite5m: number(cacheWrite5m, "cache write 5m"), cacheWrite1h: number(cacheWrite1h, "cache write 1h"), cacheRead: number(cacheRead, "cache read"), output: number(output, "output") };
		priceMap.set(model, [...(priceMap.get(model) ?? []), value]);
	}
	const models = overview.rows.map(([name, id, context, maxOutput, defaultEffort, featureList, platforms]) => {
		const supportedEfforts = effortMap.get(id);
		const featureDetails = featureMap.get(id);
		const pricing = priceMap.get(id);
		if (!supportedEfforts || !featureDetails || !pricing) throw new Error(`incomplete model data: ${id}`);
		return {
			"@id": `model:${id}`,
			id,
			name,
			contextTokens: number(context, "context"),
			maxOutputTokens: number(maxOutput, "max output"),
			defaultEffort: defaultEffort as OfficialModel["defaultEffort"],
			supportedEfforts: supportedEfforts as OfficialModel["supportedEfforts"],
			features: [...new Set([...featureList.split(","), featureDetails.thinking, featureDetails.tools === "yes" ? "tools" : "", featureDetails.vision === "yes" ? "vision" : ""].filter(Boolean))].sort(),
			platforms: platforms.split(",").map((value) => `platform:${value}`).sort(),
			pricing,
			sources: mergeSources([
				{ url: overview.url, checkedAt: overview.checkedAt, fields: ["name", "contextTokens", "maxOutputTokens", "defaultEffort", "features", "platforms"] },
				{ url: prices.url, checkedAt: prices.checkedAt, fields: ["pricing"] },
				{ url: efforts.url, checkedAt: efforts.checkedAt, fields: ["supportedEfforts"] },
				{ url: features.url, checkedAt: features.checkedAt, fields: ["features"] },
			]),
		};
	});
	return models.sort((a, b) => a.id.localeCompare(b.id));
}

function flatten(value: unknown, prefix = ""): Map<string, unknown> {
	const result = new Map<string, unknown>();
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		for (const [key, child] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
			for (const [pathName, item] of flatten(child, prefix ? `${prefix}.${key}` : key)) result.set(pathName, item);
		}
	} else {
		result.set(prefix, value);
	}
	return result;
}

export function diffOfficialModels(previous: OfficialModel[], current: OfficialModel[]): ModelDiff[] {
	const oldValues = flatten(Object.fromEntries(previous.map((model) => [model.id, model])));
	const newValues = flatten(Object.fromEntries(current.map((model) => [model.id, model])));
	const currentById = new Map(current.map((model) => [model.id, model]));
	const diffs: ModelDiff[] = [];
	for (const pathName of [...new Set([...oldValues.keys(), ...newValues.keys()])].sort()) {
		const before = oldValues.get(pathName);
		const after = newValues.get(pathName);
		if (JSON.stringify(before) === JSON.stringify(after)) continue;
		const model = currentById.get(pathName.split(".")[0]) ?? current[0];
		const source = model?.sources.find((item) => item.fields.some((field) => pathName.includes(field))) ?? model?.sources[0];
		if (!source) throw new Error("diff source unavailable");
		diffs.push({ path: pathName, kind: before === undefined ? "added" : after === undefined ? "removed" : "changed", previous: before, current: after, sourceUrl: source.url, checkedAt: source.checkedAt });
	}
	return diffs;
}
