import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { collectOfficialModels, diffOfficialModels } from "../dist/model-docs.js";
import { parseOntology } from "../dist/ontology.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const yaml = /** @type {{ load(source: string, options?: object): any, dump(value: unknown, options?: object): string, JSON_SCHEMA: unknown }} */ (createRequire(import.meta.url)("js-yaml"));

function workspacePath(value, label) {
	const resolved = path.resolve(value);
	if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`${label} must be inside workspace`);
	let current = root;
	for (const part of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`${label} must not use a symbolic link`);
	}
	return resolved;
}

function options(args) {
	const values = new Map();
	const flags = new Set(["--fetch", "--check", "--write", "--refresh"]);
	const valued = new Set(["--docs-dir", "--ontology", "--checked-at", "--cache-dir"]);
	for (let index = 0; index < args.length; index++) {
		const name = args[index];
		if ((!flags.has(name) && !valued.has(name)) || values.has(name)) throw new Error("unknown or repeated option");
		if (flags.has(name)) values.set(name, true);
		else {
			const value = args[++index];
			if (!value || value.startsWith("--")) throw new Error("missing option value");
			values.set(name, value);
		}
	}
	if ([...flags].filter((flag) => values.has(flag)).length !== 1) throw new Error(values.has("--fetch") ? "choose exactly one of --check or --write or --fetch" : "choose exactly one of --check or --write");
	if (!values.has("--fetch") && !values.has("--refresh") && values.has("--cache-dir")) throw new Error("--cache-dir requires --fetch or --refresh");
	if (values.has("--fetch") && (values.has("--ontology") || values.has("--checked-at"))) throw new Error("offline options cannot be used with --fetch");
	return values;
}

/** HTTPS 출처와 선택적 상대 리다이렉트를 검증한다.
	* @param {string} value
	* @param {string} [base]
	*/
function sourceUrl(value, base = "") {
	let url;
	try { url = new URL(value, base || undefined); } catch { throw new Error("invalid source URL"); }
	if ((!base && !/^https:\/\//i.test(value)) || url.protocol !== "https:" || url.username || url.password || /\s/.test(value)) throw new Error("source URL requires HTTPS without credentials");
	url.hash = "";
	return url;
}

function digest(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

/** 전체 요청 체인과 본문을 한 시간 제한으로 수집한다.
	* @param {string} url
	* @param {typeof globalThis.fetch} fetchImpl
	* @param {number} timeoutMs
	*/
async function download(url, fetchImpl, timeoutMs, maxBytes = 4 * 1024 * 1024) {
	const controller = new AbortController();
	let rejectTimeout;
	const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
	const timer = setTimeout(() => {
		controller.abort();
		rejectTimeout(new Error("source request timeout"));
	}, timeoutMs);
	/** @type {Response | undefined} */
	let response;
	/** @type {ReadableStreamDefaultReader<Uint8Array> | undefined} */
	let reader;
	const request = async () => {
		let current = sourceUrl(url);
		const visited = new Set();
		for (let redirects = 0; ; redirects++) {
			if (visited.has(current.href)) throw new Error("redirect loop");
			visited.add(current.href);
			response = await fetchImpl(current.href, { redirect: "manual", credentials: "omit", headers: {}, signal: controller.signal });
			if (controller.signal.aborted) { await response.body?.cancel(); throw new Error("source request timeout"); }
			if ([301, 302, 303, 307, 308].includes(response.status)) {
				const location = response.headers.get("location");
				await response.body?.cancel();
				if (!location || redirects === 5) throw new Error("redirect limit or missing location");
				const next = sourceUrl(location, current.href);
				if (next.host !== sourceUrl(url).host || visited.has(next.href)) throw new Error("redirect host or loop is forbidden");
				current = next;
				continue;
			}
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			if (!response.body) return Buffer.alloc(0);
			reader = response.body.getReader();
			/** @type {Buffer[]} */
			const chunks = new Array();
			let bytes = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return Buffer.concat(chunks);
				bytes += value.byteLength;
				if (bytes > maxBytes) throw new Error("document byte limit exceeded");
				chunks.push(Buffer.from(value));
			}
		}
	};
	try {
		return await Promise.race([request(), timeout]);
	} catch (error) {
		if (reader) await reader.cancel().catch(() => {});
		else if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
		throw error;
	} finally {
		clearTimeout(timer);
		reader?.releaseLock();
	}
}

function previousEntries(cacheDir) {
	try {
		const manifest = JSON.parse(fs.readFileSync(path.join(cacheDir, "manifest.json"), "utf8"));
		if (manifest.version !== 1 || !Array.isArray(manifest.entries)) return new Map();
		const entries = new Map();
		for (const entry of manifest.entries) {
			if (typeof entry.url !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256) || entries.has(entry.url)) return new Map();
			if (digest(fs.readFileSync(path.join(cacheDir, `${entry.sha256}.body`))) !== entry.sha256) return new Map();
			entries.set(entry.url, entry.sha256);
		}
		return entries;
	} catch { return new Map(); }
}

export async function fetchDocuments({ docsDir, cacheDir, fetchImpl = globalThis.fetch, timeoutMs = 10000 }) {
	docsDir = workspacePath(docsDir, "docs directory");
	cacheDir = workspacePath(cacheDir, "cache directory");
	if (cacheDir === root) throw new Error("cache directory must be below workspace");
	if (cacheDir === docsDir || cacheDir.startsWith(`${docsDir}${path.sep}`) || docsDir.startsWith(`${cacheDir}${path.sep}`)) throw new Error("cache and source directories must not overlap");
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10000) throw new Error("invalid request timeout");
	const urls = [...new Set(["models-overview.md", "prompt-caching.md", "effort.md", "features.md"].map((name) => {
		const file = workspacePath(path.join(docsDir, name), "source file");
		const value = fs.readFileSync(file, "utf8").match(/^Source-URL:[ \t]*(.*)$/m)?.[1]?.trim();
		if (!value) throw new Error(`missing source metadata: ${name}`);
		return sourceUrl(value).href;
	}))].sort();
	fs.mkdirSync(cacheDir, { recursive: true });
	for (const name of fs.readdirSync(cacheDir)) workspacePath(path.join(cacheDir, name), "cache file");
	const lock = path.join(cacheDir, ".lock");
	let descriptor;
	try { descriptor = fs.openSync(lock, "wx"); }
	catch (error) { if (error.code === "EEXIST") throw new Error("cache busy"); throw error; }
	let stage;
	/** @type {{target: string, backup: string | undefined}[]} */
	const installed = new Array();
	let committed = false;
	try {
		const previous = previousEntries(cacheDir);
		/** @type {{url: string, sha256: string}[]} */
		const entries = new Array();
		const bodies = new Map();
		for (const url of urls) {
			const body = await download(url, fetchImpl, timeoutMs);
			const sha256 = digest(body);
			entries.push({ url, sha256 });
			bodies.set(sha256, body);
		}
		stage = fs.mkdtempSync(path.join(cacheDir, ".stage-"));
		for (const [sha256, bytes] of bodies) fs.writeFileSync(path.join(stage, `${sha256}.body`), bytes, { flag: "wx" });
		fs.writeFileSync(path.join(stage, "manifest.json"), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, { flag: "wx" });
		for (const [sha256] of bodies) {
			const name = `${sha256}.body`;
			const target = path.join(cacheDir, name);
			if (fs.existsSync(target) && digest(fs.readFileSync(target)) === sha256) continue;
			const backup = fs.existsSync(target) ? path.join(stage, `${name}.backup`) : undefined;
			if (backup) fs.copyFileSync(target, backup);
			fs.renameSync(path.join(stage, name), target);
			installed.push({ target, backup });
		}
		fs.renameSync(path.join(stage, "manifest.json"), path.join(cacheDir, "manifest.json"));
		committed = true;
		for (const name of fs.readdirSync(cacheDir)) {
			if (/^[a-f0-9]{64}\.body$/.test(name) && !bodies.has(name.slice(0, 64))) fs.unlinkSync(path.join(cacheDir, name));
		}
		return entries.filter((entry) => previous.get(entry.url) !== entry.sha256).map((entry) => entry.url);
	} finally {
		try {
			if (!committed) for (const { target, backup } of installed.reverse()) {
				if (backup) fs.copyFileSync(backup, target);
				else fs.rmSync(target, { force: true });
			}
		} finally {
			try { if (stage) fs.rmSync(stage, { recursive: true, force: true }); }
			finally { fs.closeSync(descriptor); fs.unlinkSync(lock); }
		}
	}
}

export async function runCollector(args, { fetchImpl = globalThis.fetch } = {}) {
	const values = options(args);
	if (values.has("--refresh")) {
		const result = await refreshDocuments({ ontologyFile: values.get("--ontology") ?? path.join(root, "ontology/ontology.yaml"), cacheDir: values.get("--cache-dir") ?? path.join(root, ".astron-logs/model-docs-cache"), fetchImpl });
		return { output: `${JSON.stringify(result, null, 2)}\n`, exitCode: result.status === "updated" ? 0 : 1 };
	}
	const docsDir = values.get("--docs-dir") ?? path.join(root, "test", "fixtures", "official-docs");
	if (values.has("--fetch")) {
		const changed = await fetchDocuments({ docsDir, cacheDir: values.get("--cache-dir") ?? path.join(root, ".model-docs-cache"), fetchImpl });
		return { output: `${JSON.stringify(changed, null, 2)}\n`, exitCode: 0 };
	}
	const ontologyFile = workspacePath(values.get("--ontology") ?? path.join(root, "ontology", "ontology.yaml"), "ontology path");
	const checkedAt = values.get("--checked-at");
	const write = values.has("--write");
	const check = values.has("--check");
	const collected = collectOfficialModels(docsDir, root);
	if (checkedAt && collected.some((model) => model.sources.some((source) => source.checkedAt !== checkedAt))) throw new Error("fixture Checked-At does not match --checked-at");
	const source = fs.readFileSync(ontologyFile, "utf8");
	const raw = yaml.load(source, { schema: yaml.JSON_SCHEMA });
	const preserved = raw.models.filter((model) => model.platforms?.includes("platform:codex"));
	const current = parseOntology(source);
	const currentOfficial = officialModels(current);
	const diffs = diffOfficialModels(currentOfficial, collected);
	const output = `${JSON.stringify(diffs, null, 2)}\n`;
	if (write && diffs.length > 0) {
		const merged = collected.map((model) => ({ ...raw.models.find((previous) => previous.id === model.id), ...model }));
		const dumpedModels = yaml.dump({ models: [...merged, ...preserved] }, { noRefs: true, sortKeys: true, lineWidth: 120 });
		const modelStart = source.indexOf("models:\n");
		const modelEnd = source.indexOf("efforts:\n", modelStart);
		if (modelStart < 0 || modelEnd < 0) throw new Error("ontology model section is missing");
		const updated = `${source.slice(0, modelStart)}${dumpedModels}${source.slice(modelEnd)}`;
		const temporary = `${ontologyFile}.tmp-${process.pid}`;
		try {
			fs.writeFileSync(temporary, updated, { encoding: "utf8", flag: "wx" });
			parseOntology(updated);
			fs.renameSync(temporary, ontologyFile);
		} finally {
			if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
		}
	}
	return { output, exitCode: check && diffs.length > 0 ? 1 : 0 };
}

/** 공식 문서의 출처와 수집 범위를 검증한다.
 * @param {string} value
 * @param {string} [base]
 */
function officialUrl(value, base = "") {
	const url = sourceUrl(value, base);
	if (url.origin !== "https://platform.claude.com" || !/^\/docs\/(en|ko)\//.test(url.pathname)) throw new Error("unofficial document origin or path");
	url.pathname = url.pathname.replace(/\.md$/, "");
	return url.href;
}

/** 정책 메타데이터를 제외한 공식 모델 사양만 추출한다.
 * @param {import('../dist/ontology.js').Ontology} ontology
 */
function officialModels(ontology) {
	return ontology.models.filter((model) => !model.platforms.includes("platform:codex")).map((model) => {
		if (model.maxOutputTokens === undefined || !model.pricing || !model.sources || model.defaultEffort === "ultra") throw new Error("incomplete or unsupported official model specifications");
		const supportedEfforts = model.supportedEfforts.map((effort) => {
			if (effort === "ultra") throw new Error("unsupported official effort");
			return effort;
		});
		return {
			"@id": model["@id"], id: model.id, name: model.name,
			contextTokens: model.contextTokens, maxOutputTokens: model.maxOutputTokens,
			defaultEffort: model.defaultEffort, supportedEfforts,
			features: model.features, platforms: model.platforms, pricing: model.pricing, sources: model.sources,
		};
	});
}

/** 현행 공식 Markdown 표에서 확인한 사양과 가격을 추출한다.
 * @param {Map<string, {body: string}>} documents
 * @param {import('../dist/ontology.js').Ontology} previous
 * @param {string} checkedAt
 */
function currentOfficialTables(documents, previous, checkedAt) {
	/** @param {string} suffix */
	const find = (suffix) => [...documents].find(([url]) => new URL(url).pathname.endsWith(suffix));
	const overview = find("/models/overview");
	const effort = find("/build-with-claude/effort");
	const caching = find("/build-with-claude/prompt-caching");
	if (!overview || !effort || !caching) throw new Error("missing official model documents");
	/** @param {string} body */
	const cells = (body) => body.split(/\r?\n/).filter((line) => /^\|.*\|$/.test(line.trim())).map((line) => line.trim().slice(1, -1).split("|").map((cell) => cell.trim().replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/<[^>]+>|[`*]/g, "").replace(/\s+/g, " ").trim()));
	const rows = cells(overview[1].body);
	const header = rows.find((row) => row[0] === "Feature");
	const ids = rows.find((row) => row[0] === "Claude API ID");
	if (!header || !ids || ids.length !== header.length) throw new Error("unsupported official table format");
	/** @param {string} label @param {number} index */
	const value = (label, index) => {
		const row = rows.find((row) => row[0] === label);
		if (!row?.[index]) throw new Error("missing official model value");
		return row[index];
	};
	/** @param {string} text */
	const tokens = (text) => {
		const match = text.match(/^(\d+(?:\.\d+)?)\s*([MK])? tokens$/i);
		if (!match) throw new Error("invalid official token count");
		const count = Number(match[1]) * (match[2]?.toLowerCase() === "m" ? 1000000 : match[2]?.toLowerCase() === "k" ? 1000 : 1);
		if (!Number.isSafeInteger(count) || count <= 0) throw new Error("invalid official token count");
		return count;
	};
	/** @param {string} url @param {string} date @param {string[]} labels @param {(string | number)[][]} data */
	const make = (url, date, labels, data) => `Source-URL: ${url}\nChecked-At: ${date}\n\n| ${labels.join(" | ")} |\n|${labels.map(() => "---").join("|")}|\n${data.map((row) => `| ${row.join(" | ")} |`).join("\n")}\n`;
	const models = ids.slice(1).map((id, position) => {
		const old = previous.models.find((model) => model.id === id);
		if (!old || !/^claude-[a-z0-9-]+$/.test(id) || !/^Claude [a-zA-Z0-9. -]+$/.test(header[position + 1])) throw new Error("unsupported official model requires policy assignment");
		const index = position + 1;
		return { old, id, name: header[index], context: tokens(value("Context window", index)), output: tokens(value("Max output", index)), defaultEffort: value("Default effort", index) };
	});
	const priceRows = cells(caching[1].body);
	const efforts = cells(effort[1].body);
	/** @type {(string | number)[][]} */
	const prices = new Array();
	/** @type {string[][]} */
	const effortValues = new Array();
	for (const model of models) {
		const supported = ["low", "medium", "high", "xhigh", "max"].filter((level) => {
			const row = efforts.find((row) => row[0] === level);
			return row && (level === "low" || level === "medium" || level === "high" || row[1]?.includes(model.name));
		});
		if (supported.length < 3 || !supported.includes(model.defaultEffort)) throw new Error("invalid official effort support");
		effortValues.push([model.id, supported.join(",")]);
		const rows = priceRows.filter((row) => row[0] === model.name || row[0].startsWith(`${model.name} (for prompts `));
		if (!rows.length) throw new Error("missing official price tier");
		for (const row of rows) {
			const threshold = row[0].match(/for prompts (up to|over) ([\d,]+) tokens/);
			const tier = threshold ? `${threshold[1] === "up to" ? "<=" : ">"}${threshold[2].replace(/,/g, "")}` : "all";
			const amounts = row.slice(1).map((cell) => {
				const match = cell.match(/^\$(\d+(?:\.\d+)?) \/ MTok(?:\d+)?$/);
				if (!match) throw new Error("invalid official price value");
				return Number(match[1]);
			});
			if (amounts.length !== 5) throw new Error("invalid official price tier");
			prices.push([model.id, tier, ...amounts]);
		}
	}
	const dates = models.flatMap((model) => model.old.sources?.filter((source) => source.fields.includes("features")).map((source) => source.checkedAt) ?? []).sort();
	if (!dates.length) throw new Error("missing verified feature evidence");
	return new Map([
		["models-overview.md", make(overview[0], checkedAt, ["Model", "Model ID", "Context", "Max output", "Default effort", "Features", "Platforms"], models.map((model) => [model.name, model.id, model.context, model.output, model.defaultEffort, model.old.features.filter((feature) => feature !== "adaptive").join(","), model.old.platforms.map((platform) => platform.replace(/^platform:/, "")).join(",")])).replace("\n\n", "\nPreserved-Fields: features,platforms\n\n")],
		["prompt-caching.md", make(caching[0], checkedAt, ["Model ID", "Prompt tier", "Input", "Cache write 5m", "Cache write 1h", "Cache read", "Output"], prices)],
		["effort.md", make(effort[0], checkedAt, ["Model ID", "Supported effort"], effortValues)],
		["features.md", make(overview[0], dates[0], ["Model ID", "Thinking", "Tool use", "Vision"], models.map((model) => [model.id, model.old.features.includes("adaptive") ? "adaptive" : "text", model.old.features.includes("tools") ? "yes" : "no", model.old.features.includes("vision") ? "yes" : "no"]))],
	]);
}

/** 검증 가능한 모델 표만 공개 근거 형식으로 정규화한다.
 * @param {string} body
 * @param {string} header
 * @param {string} url
 * @param {string} checkedAt
 */
function normalizedTable(body, header, url, checkedAt) {
	const text = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<tr\b[^>]*>/gi, "\n| ").replace(/<\/(?:td|th)>/gi, " | ").replace(/<\/tr>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");
	const lines = text.split(/\r?\n/).map((line) => line.trim());
	const start = lines.findIndex((line) => line === header);
	if (start < 0) throw new Error("unsupported official table format");
	const table = [lines[start]];
	for (let index = start + 1; index < lines.length && /^\|.*\|$/.test(lines[index]); index++) table.push(lines[index]);
	if (table.length < 3) throw new Error("missing official model rows");
	for (const line of table.slice(2)) {
		if (!/^[\w\s|.,:>+\/-]+$/.test(line)) throw new Error("unsupported official table value");
	}
	return `Source-URL: ${url}\nChecked-At: ${checkedAt}\n\n${table.join("\n")}\n`;
}

/** 공식 출처의 완전한 검증 결과만 정책·근거·캐시에 반영한다.
 * @param {{ontologyFile: string, cacheDir: string, reportFile?: string, fetchImpl?: typeof fetch, timeoutMs?: number, checkedAt?: string, maxDocuments?: number, maxDocumentBytes?: number, maxTotalBytes?: number}} options
 */
export async function refreshDocuments({ ontologyFile, cacheDir, reportFile = "", fetchImpl = globalThis.fetch, timeoutMs = 10000, checkedAt = new Date().toISOString().slice(0, 10), maxDocuments = 64, maxDocumentBytes = 4 * 1024 * 1024, maxTotalBytes = 64 * 1024 * 1024 }) {
	ontologyFile = workspacePath(ontologyFile, "ontology path");
	cacheDir = workspacePath(cacheDir, "cache directory");
	const evidenceDir = path.dirname(ontologyFile);
	reportFile = workspacePath(reportFile || path.join(evidenceDir, "evidence", `model-docs-refresh-${checkedAt}.json`), "report path");
	const publicDir = workspacePath(path.join(path.dirname(reportFile), "official-docs"), "evidence directory");
	if (cacheDir === root || cacheDir === evidenceDir || cacheDir === publicDir || cacheDir.startsWith(`${publicDir}${path.sep}`) || publicDir.startsWith(`${cacheDir}${path.sep}`) || ontologyFile.startsWith(`${cacheDir}${path.sep}`)) throw new Error("cache and source directories must not overlap");
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10000 || ![maxDocuments, maxDocumentBytes, maxTotalBytes].every((value) => Number.isSafeInteger(value) && value > 0) || maxDocuments > 64 || maxDocumentBytes > 4 * 1024 * 1024 || maxTotalBytes > 64 * 1024 * 1024) throw new Error("invalid refresh limits");
	if (!/^\d{4}-\d{2}-\d{2}$/.test(checkedAt) || !Number.isFinite(Date.parse(checkedAt))) throw new Error("invalid checkedAt");
	const source = fs.readFileSync(ontologyFile, "utf8");
	const raw = yaml.load(source, { schema: yaml.JSON_SCHEMA });
	const seeds = [...new Set((raw.documentSources ?? []).map((url) => officialUrl(url)))].map(String).sort();
	if (!seeds.length) throw new Error("missing official document sources");
	fs.mkdirSync(cacheDir, { recursive: true });
	for (const name of fs.readdirSync(cacheDir)) workspacePath(path.join(cacheDir, name), "cache file");
	const lock = path.join(cacheDir, ".lock");
	let descriptor;
	try { descriptor = fs.openSync(lock, "wx"); } catch (error) { if (error.code === "EEXIST") throw new Error("cache busy"); throw error; }
	/** @type {{attemptedAt: string, status: string, documents: {url: string, status: string, reason?: string, sha256?: string, changed?: boolean}[], changes: ReturnType<typeof diffOfficialModels>, codex: string, reason?: string, preservedFields?: string[]}} */
	const report = { attemptedAt: checkedAt, status: "blocked", documents: new Array(), changes: new Array(), codex: "not rechecked: workspace-only policy; existing evidence and checkedAt preserved", reason: "", preservedFields: new Array() };
	let stage;
	/** @type {{target: string, backup: Buffer | null}[]} */
	const installed = new Array();
	try {
		const previous = previousEntries(cacheDir);
		/** @type {Map<string, {body: string, bytes: Buffer, sha256: string}>} */
		const documents = new Map();
		const pending = new Set(seeds);
		let total = 0;
		while (pending.size) {
			if (documents.size >= maxDocuments) throw new Error("document count limit exceeded");
			const url = [...pending].sort()[0]; pending.delete(url);
			let bytes;
			try { bytes = await download(`${url}.md`, fetchImpl, timeoutMs, maxDocumentBytes); }
			catch (error) { report.documents.push({ url, status: "blocked", reason: /timeout|limit|redirect|HTTP \d+/.exec(error.message)?.[0] ?? "download failed" }); throw error; }
			total += bytes.length;
			if (total > maxTotalBytes) throw new Error("total byte limit exceeded");
			const body = bytes.toString("utf8");
			const sha256 = digest(bytes);
			documents.set(url, { body, bytes, sha256 });
			report.documents.push({ url, status: "downloaded", sha256, changed: previous.get(url) !== sha256 });
			const links = [...body.matchAll(/(?:href=["']([^"']+)["']|\]\(([^)\s]+)\))/g)].map((match) => match[1] ?? match[2]);
			for (const link of links) {
				if (!/(?:choosing-a-model|models\/overview|\/effort|extended-thinking|prompt-caching|\/pricing|batch-processing)(?:[.#/?]|$)/.test(link)) continue;
				const candidate = sourceUrl(link, url);
				if (candidate.origin !== "https://platform.claude.com") continue;
				if (candidate.origin === "https://platform.claude.com" && !/^\/docs\/(en|ko)\//.test(candidate.pathname)) continue;
				const target = officialUrl(link, url);
				if (!documents.has(target)) pending.add(target);
				if (documents.size + pending.size > maxDocuments) throw new Error("document count limit exceeded");
			}
		}
		stage = fs.mkdtempSync(path.join(cacheDir, ".stage-"));
		const tableDefinitions = [
			["models-overview.md", "| Model | Model ID | Context | Max output | Default effort | Features | Platforms |", "/about-claude/models/overview"],
			["prompt-caching.md", "| Model ID | Prompt tier | Input | Cache write 5m | Cache write 1h | Cache read | Output |", "/build-with-claude/prompt-caching"],
			["effort.md", "| Model ID | Supported effort |", "/build-with-claude/effort"],
			["features.md", "| Model ID | Thinking | Tool use | Vision |", "/about-claude/models/overview"],
		];
		const currentFormat = [...documents.values()].some((document) => /^\|\s*Feature\s*\|/m.test(document.body));
		if (currentFormat) report.preservedFields = ["features", "platforms"];
		const normalized = currentFormat ? currentOfficialTables(documents, raw, checkedAt) : new Map();
		for (const [name, header, suffix] of currentFormat ? [] : tableDefinitions) {
			const entry = [...documents].find(([url]) => new URL(url).pathname.endsWith(suffix));
			if (!entry) throw new Error("missing required official document");
			const text = normalizedTable(entry[1].body, header, entry[0], checkedAt);
			normalized.set(name, text);
		}
		for (const [name, text] of normalized) fs.writeFileSync(path.join(stage, name), text);
		const collected = collectOfficialModels(stage, root);
		if (currentFormat) for (const model of collected) {
			const old = raw.models.find((previous) => previous.id === model.id);
			model.features = old.features;
			model.platforms = old.platforms;
			model.sources = model.sources.map((source) => ({ ...source, fields: source.checkedAt === checkedAt ? source.fields.filter((field) => !["features", "platforms"].includes(field)) : source.fields.filter((field) => field === "features") })).filter((source) => source.fields.length);
			model.sources.push(...(old.sources ?? []).map((source) => ({ ...source, fields: source.fields.filter((field) => ["features", "platforms"].includes(field)) })).filter((source) => source.fields.length));
			const sources = new Map();
			for (const source of model.sources) {
				const key = `${source.url}\n${source.checkedAt}`;
				const previous = sources.get(key);
				sources.set(key, { ...source, fields: [...new Set([...(previous?.fields ?? []), ...source.fields])].sort() });
			}
			model.sources = [...sources.values()].sort((a, b) => a.url.localeCompare(b.url) || a.checkedAt.localeCompare(b.checkedAt));
		}
		const before = parseOntology(source);
		const previousOfficial = officialModels(before);
		const preserved = raw.models.filter((model) => model.platforms.includes("platform:codex"));
		const merged = collected.map((model) => ({ ...raw.models.find((old) => old.id === model.id), ...model }));
		const updated = { ...raw, models: [...merged, ...preserved] };
		parseOntology(yaml.dump(updated));
		report.changes = diffOfficialModels(previousOfficial, collected);
		report.status = "updated";
		report.documents.sort((a, b) => a.url.localeCompare(b.url));
		const entries = [...documents].sort(([a], [b]) => a.localeCompare(b)).map(([url, document]) => ({ url, sha256: document.sha256 }));
		const files = new Map([...normalized].map(([name, text]) => [path.join(publicDir, name), text]));
		for (const document of documents.values()) files.set(path.join(cacheDir, `${document.sha256}.body`), document.bytes);
		files.set(path.join(cacheDir, "manifest.json"), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
		files.set(ontologyFile, yaml.dump(updated, { noRefs: true, lineWidth: 140 }));
		files.set(reportFile, `${JSON.stringify(report, null, 2)}\n`);
		for (const [target, body] of files) {
			workspacePath(target, "refresh target");
			fs.mkdirSync(path.dirname(target), { recursive: true });
			const backup = fs.existsSync(target) ? fs.readFileSync(target) : null;
			const temporary = path.join(stage, `install-${installed.length}`);
			fs.writeFileSync(temporary, body); fs.renameSync(temporary, target);
			installed.push({ target, backup });
		}
		for (const name of fs.readdirSync(cacheDir)) if (/^[a-f0-9]{64}\.body$/.test(name) && !entries.some((entry) => name === `${entry.sha256}.body`)) fs.unlinkSync(path.join(cacheDir, name));
		return report;
	} catch (error) {
		for (const { target, backup } of installed.reverse()) { if (backup === null) fs.rmSync(target, { force: true }); else fs.writeFileSync(target, backup); }
		report.status = "blocked"; report.changes = [];
		report.reason = /(?:unsupported official [a-z ]+|unofficial document origin or path|missing official|invalid [a-z ]+|document count limit|document byte limit|total byte limit|source request timeout|HTTP \d+|redirect [a-z ]+)/i.exec(error.message)?.[0] ?? "refresh failed; existing verified catalog preserved";
		report.documents.sort((a, b) => a.url.localeCompare(b.url));
		fs.mkdirSync(path.dirname(reportFile), { recursive: true });
		fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
		return report;
	} finally {
		try { if (stage) fs.rmSync(stage, { recursive: true, force: true }); }
		finally { fs.closeSync(descriptor); fs.unlinkSync(lock); }
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const result = await runCollector(process.argv.slice(2));
		process.stdout.write(result.output);
		process.exitCode = result.exitCode;
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
