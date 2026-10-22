import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import * as collector from "./collect-model-docs.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(root, "test/fixtures/official-docs");
const names = ["models-overview.md", "prompt-caching.md", "effort.md", "features.md"];
const scratch = fs.mkdtempSync(path.join(root, ".astron-logs/collect-test-"));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("external network forbidden"); };
process.exitCode = 0;
let failed = 0;
let serial = 0;

function setup(urls = ["https://docs.test/z", "https://docs.test/a", "https://docs.test/z", "https://docs.test/a"]) {
	const directory = path.join(scratch, String(++serial));
	const docsDir = path.join(directory, "docs");
	fs.mkdirSync(docsDir, { recursive: true });
	for (const [index, name] of names.entries()) fs.writeFileSync(path.join(docsDir, name), `Source-URL: ${urls[index]}\n`);
	return { docsDir, cacheDir: path.join(directory, "cache") };
}

function hash(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function snapshot(directory) {
	if (!fs.existsSync(directory)) return {};
	return Object.fromEntries(fs.readdirSync(directory).sort().map((name) => [name, fs.readFileSync(path.join(directory, name)).toString("hex")]));
}

function verifyCache(directory) {
	const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
	for (const item of manifest.entries) assert.equal(hash(fs.readFileSync(path.join(directory, `${item.sha256}.body`))), item.sha256);
	assert.ok(fs.readdirSync(directory).every((name) => name === "manifest.json" || /^[a-f0-9]{64}\.body$/.test(name)));
	return manifest;
}

function ontologyVariant({ eol, at = "original", finalEol = true, effortsKey = "efforts", effortsFirst = false }) {
	const source = fs.readFileSync(path.join(root, "ontology/ontology.yaml"), "utf8").replace(/\r\n/g, "\n").replace(/contextTokens: \d+/, "contextTokens: 42");
	const blocks = Object.fromEntries(source.replace(/\n$/, "").split(/\n(?=\S)/).map((block) => [block.split(":", 1)[0], block]));
	const middle = Object.keys(blocks).filter((key) => key !== "models" && key !== "efforts");
	const order = effortsFirst ? ["efforts", ...middle, "models"] : at === "start" ? ["models", "efforts", ...middle] : at === "end" ? [...middle, "models", "efforts"] : Object.keys(blocks);
	const text = order.map((key) => blocks[key].replace(/^efforts:/, `${effortsKey}:`)).join("\n") + (finalEol ? "\n" : "");
	return text.replace(/\n/g, eol);
}

async function writeVariant(text, name) {
	const target = path.join(scratch, name);
	fs.writeFileSync(target, text);
	const result = await collector.runCollector(["--write", "--ontology", target]);
	return { result, written: fs.readFileSync(target, "utf8"), target };
}

function assertSectionRewritten(text, written, eol) {
	const headEnd = text.indexOf(`models:${eol}`);
	const tailStart = text.indexOf(`efforts:${eol}`);
	assert.ok(headEnd >= 0 && tailStart > headEnd);
	assert.equal(written.slice(0, headEnd), text.slice(0, headEnd));
	assert.equal(written.slice(written.length - (text.length - tailStart)), text.slice(tailStart));
	assert.equal(yaml.load(written).models[0].contextTokens === 42, false);
	assert.ok(written.slice(headEnd).startsWith(`models:${eol}`));
	if (eol === "\r\n") assert.ok(!/(?<!\r)\n/.test(written) && !/\r(?!\n)/.test(written));
	else assert.ok(!written.includes("\r"));
}

async function test(name, body) {
	try {
		await body();
		console.log(`PASS ${name}`);
	} catch (error) {
		failed++;
		console.error(`FAIL ${name}\n${error.stack}`);
	}
}

try {
	await test("test_fetch_reports_unchanged_changed_and_first_seen_urls", async () => {
		const options = setup();
		let body = "first";
		/** @type {string[]} */
		const calls = new Array();
		const fetchImpl = async (url) => { calls.push(url); return new Response(url.endsWith("/z") ? body : "stable"); };
		assert.deepEqual(await collector.fetchDocuments({ ...options, fetchImpl }), ["https://docs.test/a", "https://docs.test/z"]);
		assert.equal(calls.length, 2);
		assert.deepEqual(await collector.fetchDocuments({ ...options, fetchImpl }), []);
		body = "second";
		assert.deepEqual(await collector.fetchDocuments({ ...options, fetchImpl }), ["https://docs.test/z"]);
		assert.equal(fs.readdirSync(options.cacheDir).length, 3);
		verifyCache(options.cacheDir);
	});

	await test("test_fetch_http_error_and_timeout_preserve_cache", async () => {
		const options = setup();
		await collector.fetchDocuments({ ...options, fetchImpl: async () => new Response("old") });
		const before = snapshot(options.cacheDir);
		let canceled = 0;
		const badResponse = () => new Response(new ReadableStream({ cancel() { canceled++; } }), { status: 503 });
		await assert.rejects(collector.fetchDocuments({ ...options, fetchImpl: async () => badResponse() }), /HTTP 503/);
		assert.equal(canceled, 1);
		for (const fetchImpl of [async () => { await new Promise(() => {}); return new Response(); }, async () => new Response(new ReadableStream({ cancel() { canceled++; } }))]) {
			await assert.rejects(collector.fetchDocuments({ ...options, fetchImpl, timeoutMs: 25 }), /timeout/i);
			assert.deepEqual(snapshot(options.cacheDir), before);
		}
		assert.equal(canceled, 2);
		let calls = 0;
		await assert.rejects(collector.fetchDocuments({ ...options, timeoutMs: 25, fetchImpl: async () => {
			await new Promise((resolve) => setTimeout(resolve, 15));
			return ++calls === 1 ? new Response(null, { status: 302, headers: { location: "/next" } }) : new Response("late");
		} }), /timeout/i);
		assert.deepEqual(snapshot(options.cacheDir), before);
	});

	await test("test_fetch_enforces_https_same_host_redirect_limit", async () => {
		for (const url of ["http://docs.test/a", "file:///test", "not a URL"]) {
			let calls = 0;
			await assert.rejects(collector.fetchDocuments({ ...setup(Array(4).fill(url)), fetchImpl: async () => { calls++; return new Response(); } }));
			assert.equal(calls, 0);
		}
		for (const location of ["http://docs.test/b", "https://other.test/b", "https://docs.test:444/b", "/a"]) {
			let calls = 0;
			await assert.rejects(collector.fetchDocuments({ ...setup(Array(4).fill("https://docs.test/a")), fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { location } }); } }));
			assert.equal(calls, 1);
		}
		for (const count of [5, 6]) {
			let calls = 0;
			const run = collector.fetchDocuments({ ...setup(Array(4).fill("https://docs.test/0")), fetchImpl: async () => ++calls <= count ? new Response(null, { status: 302, headers: { location: `/${calls}` } }) : new Response("done") });
			if (count === 5) assert.deepEqual(await run, ["https://docs.test/0"]);
			else await assert.rejects(run, /redirect/i);
			assert.equal(calls, 6);
		}
	});

	await test("test_fetch_cache_boundary_and_failure_cleanup", async () => {
		const options = setup();
		let calls = 0;
		await assert.rejects(collector.fetchDocuments({ ...options, cacheDir: path.resolve(root, "../escape"), fetchImpl: async () => { calls++; return new Response(); } }), /workspace/i);
		assert.equal(calls, 0);
		const link = path.join(path.dirname(options.cacheDir), "link");
		fs.symlinkSync(options.docsDir, link, "junction");
		await assert.rejects(collector.fetchDocuments({ ...options, cacheDir: path.join(link, "nested"), fetchImpl: async () => { calls++; return new Response(); } }), /link/i);
		assert.equal(calls, 0);
		await collector.fetchDocuments({ ...options, fetchImpl: async () => new Response("old") });
		const before = snapshot(options.cacheDir);
		const rename = fs.renameSync;
		fs.renameSync = () => { throw Object.assign(new Error("replace denied"), { code: "EACCES" }); };
		try {
			await assert.rejects(collector.fetchDocuments({ ...options, fetchImpl: async () => new Response("new") }), /replace denied/);
		} finally { fs.renameSync = rename; }
		assert.deepEqual(snapshot(options.cacheDir), before);
		fs.renameSync = (from, to) => {
			if (path.basename(String(from)) === "manifest.json") throw new Error("manifest denied");
			return rename(from, to);
		};
		try { await assert.rejects(collector.fetchDocuments({ ...options, fetchImpl: async () => new Response("new") }), /manifest denied/); }
		finally { fs.renameSync = rename; }
		assert.deepEqual(snapshot(options.cacheDir), before);
		const write = fs.writeFileSync;
		fs.writeFileSync = () => { throw new Error("write denied"); };
		try { await assert.rejects(collector.fetchDocuments({ ...options, fetchImpl: async () => new Response("new") }), /write denied/); }
		finally { fs.writeFileSync = write; }
		assert.deepEqual(snapshot(options.cacheDir), before);
		await assert.rejects(collector.fetchDocuments({ ...options, cacheDir: options.docsDir, fetchImpl: async () => new Response("unsafe") }), /overlap/i);
	});

	await test("test_fetch_preserves_offline_output_and_normalized_sources", async () => {
		assert.equal(typeof collector.runCollector, "function");
		const tracked = [path.join(root, "ontology/ontology.yaml"), path.join(root, "ontology/ontology.json"), ...names.map((name) => path.join(fixtures, name))];
		const before = tracked.map((file) => hash(fs.readFileSync(file)));
		const target = path.join(scratch, "offline-check.yaml");
		fs.copyFileSync(path.join(root, "ontology/ontology.yaml"), target);
		await collector.runCollector(["--write", "--ontology", target]);
		const result = spawnSync(process.execPath, ["scripts/collect-model-docs.mjs", "--check", "--ontology", target], { cwd: root, encoding: "utf8" });
		assert.equal(result.status, 0);
		assert.equal(result.stdout, "[]\n");
		assert.equal(result.stderr, "");
		const options = setup();
		await collector.fetchDocuments({ ...options, fetchImpl: async () => new Response("ok") });
		await assert.rejects(collector.fetchDocuments({ ...options, fetchImpl: async () => new Response(null, { status: 500 }) }));
		assert.deepEqual(tracked.map((file) => hash(fs.readFileSync(file))), before);
	});

	await test("test_fetch_rejects_invalid_cli_and_empty_source_metadata", async () => {
		assert.equal(typeof collector.runCollector, "function");
		let calls = 0;
		const fetchImpl = async () => { calls++; return new Response(""); };
		for (const args of [["--fetch", "--cache-dir"], ["--fetch", "--unknown"], ["--fetch", "--check"], ["--fetch", "--write"], ["--fetch", "--fetch"], ["--cache-dir", "cache"], ["--check", "--cache-dir", "cache"]]) await assert.rejects(collector.runCollector(args, { fetchImpl }));
		for (const url of ["", "invalid", "https://", "https:/docs.test/a", "https://docs.test/a b"]) await assert.rejects(collector.fetchDocuments({ ...setup(Array(4).fill(url)), fetchImpl }));
		assert.equal(calls, 0);
		const options = setup();
		await collector.fetchDocuments({ ...options, fetchImpl });
		assert.ok(verifyCache(options.cacheDir).entries.every((entry) => entry.sha256 === hash("")));
		const result = await collector.runCollector(["--fetch", "--docs-dir", options.docsDir, "--cache-dir", options.cacheDir], { fetchImpl });
		assert.deepEqual(result, { output: "[]\n", exitCode: 0 });
	});

	await test("test_fetch_rejects_url_credentials_and_sends_no_auth", async () => {
		let calls = 0;
		const credentialUrl = new URL("https://docs.test/a");
		credentialUrl.username = "user";
		credentialUrl.password = ["private", "marker"].join("-");
		try {
			await collector.fetchDocuments({ ...setup(Array(4).fill(credentialUrl.href)), fetchImpl: async () => { calls++; return new Response(); } });
			assert.fail("credentials accepted");
		} catch (error) { assert.doesNotMatch(error.message, /user|private-marker/); }
		assert.equal(calls, 0);
		await collector.fetchDocuments({ ...setup(), fetchImpl: async (_url, init) => {
			assert.equal(init.redirect, "manual");
			assert.equal(init.credentials, "omit");
			assert.deepEqual(init.headers, {});
			assert.ok(init.signal instanceof AbortSignal);
			return new Response();
		} });
	});

	await test("test_fetch_concurrent_commits_do_not_mix_snapshots", async () => {
		const options = setup();
		let release = () => {};
		const gate = new Promise((resolve) => { release = () => resolve(undefined); });
		let started = () => {};
		const ready = new Promise((resolve) => { started = () => resolve(undefined); });
		const first = collector.fetchDocuments({ ...options, fetchImpl: async () => { started(); await gate; return new Response("first"); } });
		await ready;
		try { await assert.rejects(collector.fetchDocuments({ ...options, fetchImpl: async () => new Response("second") }), /busy/i); }
		finally { release(); }
		await first;
		assert.ok(verifyCache(options.cacheDir).entries.every((entry) => entry.sha256 === hash("first")));
	});

	await test("test_fetch_recovers_missing_or_corrupt_cache_without_partial_commit", async () => {
		for (const damage of ["missing", "json", "body-missing", "body-corrupt", "manifest-path"]) {
			const options = setup();
			await collector.fetchDocuments({ ...options, fetchImpl: async () => new Response("old") });
			const manifestFile = path.join(options.cacheDir, "manifest.json");
			const bodyFile = path.join(options.cacheDir, `${hash("old")}.body`);
			if (damage === "missing") fs.unlinkSync(manifestFile);
			if (damage === "json") fs.writeFileSync(manifestFile, "broken");
			if (damage === "body-missing") fs.unlinkSync(bodyFile);
			if (damage === "body-corrupt") fs.writeFileSync(bodyFile, "broken");
			if (damage === "manifest-path") fs.writeFileSync(manifestFile, JSON.stringify({ entries: [{ url: "https://docs.test/a", sha256: "../../outside" }] }));
			const before = snapshot(options.cacheDir);
			let calls = 0;
			await assert.rejects(collector.fetchDocuments({ ...options, fetchImpl: async () => ++calls === 1 ? new Response("new") : new Response(null, { status: 500 }) }));
			assert.deepEqual(snapshot(options.cacheDir), before);
			assert.deepEqual(await collector.fetchDocuments({ ...options, fetchImpl: async () => new Response("new") }), ["https://docs.test/a", "https://docs.test/z"]);
			verifyCache(options.cacheDir);
		}
	});

	await test("test_offline_collector_preserves_codex_models_and_legacy_diffs", async () => {
		assert.equal(typeof collector.runCollector, "function");
		const source = fs.readFileSync(path.join(root, "ontology/ontology.yaml"), "utf8");
		let data = yaml.load(source);
		const codex = { "@id": "model:synthetic-codex", id: "synthetic-codex", name: "Synthetic", contextTokens: 500000, defaultEffort: "low", supportedEfforts: ["low"], features: ["text"], platforms: ["platform:codex"] };
		if (!data.platforms.some((platform) => platform["@id"] === "platform:codex")) data.platforms.push({ "@id": "platform:codex", name: "Codex" });
		data.models.push(codex);
		const target = path.join(scratch, "mixed.yaml");
		fs.writeFileSync(target, yaml.dump(data));
		await collector.runCollector(["--write", "--ontology", target]);
		data = yaml.load(fs.readFileSync(target, "utf8"));
		assert.deepEqual(await collector.runCollector(["--check", "--ontology", target]), { output: "[]\n", exitCode: 0 });
		data.models[0].contextTokens = 42;
		fs.writeFileSync(target, yaml.dump(data));
		const result = await collector.runCollector(["--write", "--ontology", target]);
		assert.ok(JSON.parse(result.output).some((diff) => diff.path.endsWith("contextTokens") && diff.previous === 42));
		assert.deepEqual(yaml.load(fs.readFileSync(target, "utf8")).models.find((model) => model.id === codex.id), codex);
		assert.equal((await collector.runCollector(["--check", "--ontology", target])).output, "[]\n");
	});

	await test("test_write_models_section_lf_source", async () => {
		const text = ontologyVariant({ eol: "\n" });
		const { written } = await writeVariant(text, "write-lf.yaml");
		assertSectionRewritten(text, written, "\n");
	});

	await test("test_write_models_section_crlf_source", async () => {
		const text = ontologyVariant({ eol: "\r\n" });
		const { written } = await writeVariant(text, "write-crlf.yaml");
		assertSectionRewritten(text, written, "\r\n");
	});

	await test("test_write_models_section_at_file_edges", async () => {
		for (const eol of ["\n", "\r\n"]) {
			for (const at of ["start", "end"]) {
				for (const finalEol of [true, false]) {
					const text = ontologyVariant({ eol, at, finalEol });
					assert.equal(text.startsWith(`models:${eol}`), at === "start");
					const { written } = await writeVariant(text, `write-${at}-${eol.length}-${finalEol}.yaml`);
					assertSectionRewritten(text, written, eol);
					assert.equal(written.startsWith(`models:${eol}`), at === "start");
					assert.equal(written.endsWith(eol), finalEol);
				}
			}
		}
	});

	await test("test_write_without_efforts_boundary_keeps_error_message", async () => {
		for (const eol of ["\n", "\r\n"]) {
			for (const options of [{ effortsKey: "efforts " }, { effortsFirst: true }]) {
				const text = ontologyVariant({ eol, ...options });
				const target = path.join(scratch, `write-missing-${eol.length}-${Object.keys(options)[0]}.yaml`);
				fs.writeFileSync(target, text);
				await assert.rejects(collector.runCollector(["--write", "--ontology", target]), /^Error: ontology model section is missing$/);
				assert.equal(fs.readFileSync(target, "utf8"), text);
				assert.deepEqual(fs.readdirSync(scratch).filter((name) => name.startsWith(`${path.basename(target)}.tmp-`)), []);
			}
		}
	});

	await test("test_write_crlf_source_result_keeps_crlf_without_lf_mixing", async () => {
		const target = path.join(scratch, "real-crlf.yaml");
		const original = fs.readFileSync(path.join(root, "ontology/ontology.yaml"), "utf8");
		assert.ok(original.includes("\r\n"));
		fs.writeFileSync(target, original.replace(/contextTokens: \d+/, "contextTokens: 42"));
		await collector.runCollector(["--write", "--ontology", target]);
		const written = fs.readFileSync(target, "utf8");
		assert.ok(!/(?<!\r)\n/.test(written));
		assert.equal(written.split("\r\n").length, written.split("\n").length);
		assert.deepEqual(await collector.runCollector(["--check", "--ontology", target]), { output: "[]\n", exitCode: 0 });
	});
} finally {
	globalThis.fetch = originalFetch;
	fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(`15 tests,${failed} failures`);
process.exitCode = failed ? 1 : 0;
