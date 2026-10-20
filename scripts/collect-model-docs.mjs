import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import yaml from "js-yaml";
import { collectOfficialModels, diffOfficialModels } from "../dist/model-docs.js";
import { parseOntology } from "../dist/ontology.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
	const flags = new Set(["--fetch", "--check", "--write"]);
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
	if (!values.has("--fetch") && values.has("--cache-dir")) throw new Error("--cache-dir requires --fetch");
	if (values.has("--fetch") && (values.has("--ontology") || values.has("--checked-at"))) throw new Error("offline options cannot be used with --fetch");
	return values;
}

/** HTTPS 출처와 선택적 상대 리다이렉트를 검증한다.
	* @param {string} value
	* @param {string} [base]
	*/
function sourceUrl(value, base = undefined) {
	let url;
	try { url = new URL(value, base); } catch { throw new Error("invalid source URL"); }
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
async function download(url, fetchImpl, timeoutMs) {
	const controller = new AbortController();
	let rejectTimeout;
	const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
	const timer = setTimeout(() => {
		controller.abort();
		rejectTimeout(new Error("source request timeout"));
	}, timeoutMs);
	let response;
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
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return Buffer.concat(chunks);
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
	const preservedIds = new Set(preserved.map((model) => model.id));
	const offline = { ...raw, models: raw.models.filter((model) => !preservedIds.has(model.id)), rules: raw.rules.filter((rule) => !preservedIds.has(rule.model)) };
	const current = parseOntology(preserved.length ? yaml.dump(offline) : source);
	const diffs = diffOfficialModels(current.models, collected);
	const output = `${JSON.stringify(diffs, null, 2)}\n`;
	if (write && diffs.length > 0) {
		const dumpedModels = yaml.dump({ models: [...collected, ...preserved] }, { noRefs: true, sortKeys: true, lineWidth: 120 });
		const modelStart = source.indexOf("models:\n");
		const modelEnd = source.indexOf("efforts:\n", modelStart);
		if (modelStart < 0 || modelEnd < 0) throw new Error("ontology model section is missing");
		const updated = `${source.slice(0, modelStart)}${dumpedModels}${source.slice(modelEnd)}`;
		const temporary = `${ontologyFile}.tmp-${process.pid}`;
		try {
			fs.writeFileSync(temporary, updated, { encoding: "utf8", flag: "wx" });
			parseOntology(yaml.dump({ ...offline, models: collected }));
			fs.renameSync(temporary, ontologyFile);
		} finally {
			if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
		}
	}
	return { output, exitCode: check && diffs.length > 0 ? 1 : 0 };
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
