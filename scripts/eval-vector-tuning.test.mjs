import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import * as E from "./eval-retrieval.mjs";

const model = "Xenova/multilingual-e5-small";
const base = { exactR1: 1, noneFpr: 0, noneAny: 0, publicR5: 0.5, publicMrr: 0.4, opsR5: 0.5, opsMrr: 0.4 };
const improved = { ...base, publicR5: 0.6, publicMrr: 0.5, opsR5: 0.6, opsMrr: 0.5 };
const candidate = (overrides = {}) => ({ model, fusion: "add", w: 1, tau: 0.8, tune: { ...improved }, ...overrides });

test("sweep includes 0.70 through 0.90 in 0.02 steps for add and rrf", () => {
	const configs = E.grid();
	assert.equal(configs.length, 88);
	for (const fusion of ["add", "rrf"]) {
		assert.deepEqual([...new Set(configs.filter((c) => c.fusion === fusion).map((c) => c.tau))], [0.7, 0.72, 0.74, 0.76, 0.78, 0.8, 0.82, 0.84, 0.86, 0.88, 0.9]);
		assert.ok(configs.some((c) => c.fusion === fusion && c.w === 1));
		assert.ok(configs.some((c) => c.fusion === fusion && c.w > 1));
	}
});

test("selection uses tune only and prefers unchanged model with threshold only", () => {
	const simple = candidate({ holdout: { exactR1: 0, publicR5: 0 } });
	const complex = candidate({ model: "other", tune: { ...improved, publicR5: 1, opsR5: 1 } });
	for (const list of [[complex, candidate({ w: 2 }), simple], [simple, complex]]) assert.equal(E.selectCandidate(list, base, model), simple);
	assert.equal(E.selectCandidate([{ ...simple, holdout: { publicR5: 1 } }], base, model).tau, simple.tau);
	assert.equal(E.selectCandidate([candidate({ tune: { ...improved, exactRates: [1, 0.9] } })], { ...base, exactRates: [1, 1] }, model), null);
});

test("selection rejects exact regression, none increase above two points, or no paraphrase gain", () => {
	for (const change of [{ exactR1: 0.99 }, { noneFpr: 0.02001 }, { publicR5: 0.5 }, { publicMrr: 0.4 }, { opsR5: 0.5 }, { opsMrr: 0.4 }, { opsMrr: Number.NaN }]) {
		assert.equal(E.selectCandidate([candidate({ tune: { ...improved, ...change } })], base, model), null);
	}
	for (const fusion of ["add", "rrf"]) {
		assert.ok(E.selectCandidate([candidate({ fusion, tune: { ...improved, noneAny: 0.02 } })], base, model));
		for (const noneAny of [0.020001, NaN, Infinity]) assert.equal(E.selectCandidate([candidate({ fusion, tune: { ...improved, noneAny } })], base, model), null);
	}
});

test("metrics preserve multiple-answer recall and report none false positives", async () => {
	const result = E.metrics([
		{ row: { expected: ["a", "b"] }, ranked: [{ slug: "a", score: 10 }, { slug: "b", score: 5 }] },
		{ row: { expected: [] }, ranked: [{ slug: "x", score: 9 }] },
		{ row: { expected: [] }, ranked: [] },
	]);
	assert.equal(result.recall1, 0.5);
	assert.equal(result.recall5, 1);
	assert.equal(result.mrr, 1);
	assert.equal(result.noneFpr, 0.5);
	assert.equal(result.noneAny, 0.5);
	assert.equal(E.metrics([]).mrr, null);
	assert.equal(E.metrics([]).noneAny, null);
	const limits = new Array();
	const results = Array.from({ length: 20 }, (_, i) => ({ record: { slug: `answer-${i}` }, score: 20 - i }));
	const store = { searchDetailed: (_q, opts) => { limits.push(opts.limit); return { results: results.slice(0, opts.limit), totalMatched: results.length }; } };
	const positive = { query: "adaptive", expected: ["answer-7"], split: "paraphrase" };
	const ranked = E.rankRow(store, null, positive, [], null);
	assert.deepEqual(limits, [5, 10]); assert.equal(E.judge(positive, ranked).firstRank, 8);
	limits.length = 0;
	const noneRanked = E.rankRow(store, null, { query: "none", expected: [] }, [], null);
	assert.deepEqual(limits, [5]); assert.equal(noneRanked.totalMatched, 20);
	const session = await E.openEvaluationBackend({ corpus: "eval/fixture-vault", corpusKind: "file" });
	try {
		const { MemoryStore } = await import("../dist/store.js"); const live = new MemoryStore(session.backend);
		live.reinforce = () => {}; live.retriever.sync(session.backend); live.retriever.sync = () => {};
		const rows = E.loadGolden(new Set(session.backend.listSlugs(true).map((r) => r.slug)));
		for (const r of rows) {
			const full = E.rankRow(live, null, r, [], null, 1000);
			const adaptive = E.rankRow(live, null, r, [], null);
			assert.deepEqual(adaptive.slice(0, 5).map((x) => x.slug), full.slice(0, 5).map((x) => x.slug));
			assert.deepEqual(E.judge(r, adaptive), E.judge(r, full));
		}
	} finally { await session.cleanup(); }
});

test("private destinations reject repository paths including symlinks", () => {
	withDir((privateRoot) => {
		for (const input of ["eval/private.jsonl", "EVAL/new/private.jsonl", ".astron-logs/ops-eval/../../../private.json", ".astron-logs/ops-eval-other/x"]) {
			assert.throws(() => E.privatePath(input, { privateRoot }), /invalid detail destination/);
		}
		for (const target of [path.resolve("eval"), path.join(privateRoot, "missing")]) {
			const link = path.join(privateRoot, "linked");
			const destination = path.join(link, "new", "private.json");
			fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
			try { assert.throws(() => E.privatePath(destination, { privateRoot }), /linked detail destination/); }
			finally { fs.unlinkSync(link); }
			assert.equal(E.privatePath(destination, { privateRoot }), destination);
			fs.mkdirSync(link);
			try { assert.equal(E.privatePath(destination, { privateRoot }), destination); }
			finally { fs.rmdirSync(link); }
		}
	});
});

test("dataset rejects unknown slugs, duplicate queries, and missing holdout", () => {
	const row = { query: "other words", expected: ["a"], split: "paraphrase", holdout: false };
	assert.equal(E.validateDataset([row], new Set(["a"])).length, 1);
	assert.throws(() => E.validateDataset([row], new Set(["b"])));
	assert.throws(() => E.validateDataset([row, row], new Set(["a"])));
	for (const change of [{ holdout: undefined }, { query: " " }, { query: 3 }, { expected: [3] }, { expected: ["a", "a"] }, { split: "bad" }, { split: "none" }]) assert.throws(() => E.validateDataset([{ ...row, ...change }], new Set(["a"])));
	withDir((dir) => {
		const file = path.join(dir, "bad.jsonl"); fs.writeFileSync(file, "{bad");
		assert.throws(() => E.loadGolden(new Set(["a"]), file));
	});
});

test("model failure is reported without substituting lexical results", async () => {
	const result = await E.runModel({ id: "unavailable" }, async () => { throw new Error("PRIVATE_MARKER"); });
	assert.equal(result.available, false);
	assert.equal(result.model, "unavailable");
	assert.equal(result.configs, undefined);
	assert.ok(!JSON.stringify(result).includes("PRIVATE_MARKER"));
});

function withDir(fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-evaluation-test-"));
	try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

for (const mode of ["public", "private-file", "private-sqlite", "baseline"]) {
	test(`test_eval_${mode.replace(/-/g, "_")}_leaves_clean_repository_unchanged`, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-evaluation-clean-"));
		try {
			const repo = path.join(dir, "repository");
			for (const name of ["package.json", "dist", "eval", "ontology", "scripts/eval-retrieval.mjs", "scripts/migrate-vault-to-store.mjs", "scripts/lib/env.mjs"]) {
				const dest = path.join(repo, name);
				fs.mkdirSync(path.dirname(dest), { recursive: true });
				fs.cpSync(path.resolve(name), dest, { recursive: true });
			}
			fs.symlinkSync(path.resolve("node_modules"), path.join(repo, "node_modules"), process.platform === "win32" ? "junction" : "dir");
			const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ASTRONRAG_|BIGBRAIN_|BBM_)/i.test(key)));
			Object.assign(env, { HOME: dir, USERPROFILE: dir, ASTRONRAG_VAULT: path.join(dir, "unused-vault") });
			const args = [path.join(repo, "scripts/eval-retrieval.mjs")];
			if (mode.startsWith("private-")) {
				const corpus = path.join(dir, "corpus");
				const { FileStore } = await import("../dist/stores/file-store.js");
				const { MemoryStore } = await import("../dist/store.js");
				const backend = new FileStore(corpus);
				try {
					const store = new MemoryStore(backend);
					for (const slug of ["alpha", "beta"]) store.remember({ slug, title: `evaluation ${slug}`, content: `evaluation document ${slug}`, type: "semantic" });
				} finally { backend.close(); }
				const queries = path.join(dir, "queries.jsonl");
				let source = corpus;
				const rows = [
					{ query: "evaluation alpha", expected: ["alpha"], split: "exact", holdout: false },
					{ query: "evaluation beta", expected: ["beta"], split: "exact", holdout: true },
					{ query: "unrelated astronomy", expected: [], split: "none", holdout: false },
					{ query: "unrelated geography", expected: [], split: "none", holdout: true },
				];
				if (mode === "private-sqlite") {
					const { runMigration } = await import("./migrate-vault-to-store.mjs");
					source = path.join(dir, "source.sqlite");
					runMigration({ vault: corpus, storePath: source, backupPath: path.join(dir, "backup"), dryRun: false, merge: false, verify: false });
					const snapshotHash = crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");
					for (const row of rows) Object.assign(row, { snapshotHash });
				}
				fs.writeFileSync(queries, rows.map((row) => JSON.stringify(row)).join("\n"));
				args.push("--queries", queries, "--corpus", source, "--corpus-kind", mode === "private-sqlite" ? "sqlite" : "file", "--private-root", path.join(dir, "private"));
			} else if (mode === "baseline") args.push("--baseline", path.join(repo, "dist"));
			const snapshot = (base) => fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
				const file = path.join(base, entry.name);
				const relative = path.relative(repo, file);
				if (entry.isSymbolicLink()) return [[relative, fs.readlinkSync(file)]];
				if (entry.isDirectory()) return [[relative, "directory"], ...snapshot(file)];
				return [[relative, crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]];
			});
			assert.equal(fs.existsSync(path.join(repo, ".astron-logs")), false);
			const before = snapshot(repo);
			const result = spawnSync(process.execPath, args, { cwd: repo, env, encoding: "utf8", timeout: 600000 });
			assert.equal(result.error, undefined);
			assert.equal(result.status, 0, result.stderr);
			const output = JSON.parse(result.stdout);
			if (mode === "baseline") assert.equal(output.mismatchCount, 0);
			else assert.ok(output.fixture.count > 0);
			assert.equal(fs.existsSync(path.join(repo, ".astron-logs")), false);
			assert.deepEqual(snapshot(repo), before);
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});
}

const row = { query: "다른 표현", expected: ["a"], split: "paraphrase", holdout: false };
test("test_eval_special_characters_are_data", () => {
	withDir((dir) => {
		const file = path.join(dir, "한글 공백 ' 자료.jsonl");
		const query = "한글 ' \\\n 데이터";
		fs.writeFileSync(file, JSON.stringify({ ...row, query }));
		assert.equal(E.loadGolden(new Set(["a"]), file)[0].query, query);
		assert.equal(E.readArgs(["--queries", file, "--corpus", dir]).queries, file);
	});
});
test("test_eval_rejects_empty_inputs", () => {
	for (const rows of [[], [{ ...row, query: "  " }]]) assert.throws(() => E.validateDataset(rows, new Set(["a"])));
	assert.throws(() => E.validateDataset([row], new Set()));
	assert.throws(() => E.readArgs(["--queries", "", "--corpus", ""]));
});
test("test_eval_rejects_invalid_numeric_limits", () => {
	for (const [key, values] of [["min-cos", ["NaN", "Infinity", "1.1", "-1.1"]], ["vector-weight", ["0", "-1", "Infinity", "NaN"]], ["top-k", ["0", "-1", "1.5", "NaN", "Infinity"]]]) for (const value of values) assert.throws(() => E.readArgs(["--vector", `--${key}`, value]));
	assert.equal(E.readArgs(["--vector"]).vector, true);
});
test("test_eval_alts_preserve_answers_and_holdout", () => {
	const alts = new Map([[`${row.split}\u0000${row.query}`, [row.query, "바꾸기", "바꾸기", "둘", "셋", "넷"]]]);
	const rows = E.expandAlts([row], alts, "alts", true);
	assert.equal(rows.length, 3);
	for (const r of rows) { assert.deepEqual(r.expected, row.expected); assert.equal(r.holdout, false); assert.ok(!r.alts.includes(row.query)); assert.ok(!r.alts.includes(r.query)); }
});
test("test_eval_rejects_answer_group_split_leakage", () => {
	assert.throws(() => E.validateDataset([row, { ...row, query: "다른 질문", holdout: true }], new Set(["a"])));
});
test("test_eval_holdout_failure_keeps_defaults_without_retry", () => {
	const first = candidate({ tau: 0.9, holdout: { ...base } });
	const second = candidate({ tau: 0.8, holdout: { ...improved } });
	const result = E.decideCandidate([second, first], { tune: base, holdout: base }, model);
	assert.equal(result.selected, first); assert.equal(result.accepted, null); assert.equal(result.keepDefaults, true);
});
test("test_eval_latency_includes_query_embedding_and_fusion", async () => {
	const calls = new Array();
	const store = { retriever: { entries: () => [] }, searchDetailed: () => { calls.push("fusion"); return { results: [] }; } };
	const vec = { vr: { sync: async () => calls.push("sync"), embedQuery: async () => { calls.push("embed"); return new Float32Array([1]); }, nearest: () => { calls.push("nearest"); return []; } }, mod: { VECTOR_TOP_K: 10 } };
	await E.measureLatency(store, vec, [row], () => [], { fusion: "add", tau: 0.8, w: 1 }, 2);
	assert.deepEqual(calls, Array.from({ length: 3 }, () => ["sync", "embed", "nearest", "fusion"]).flat());
});
test("test_eval_ignores_ambient_paths_and_credentials", () => {
	const env = E.evaluationEnv({ ASTRONRAG_VAULT: "PRIVATE", ASTRONRAG_SQLITE_PATH: "PRIVATE", HF_TOKEN: "PRIVATE", ASTRONRAG_TOKEN: "PRIVATE", PATH: "bin" }, { scorer: "legacy" });
	assert.ok(!JSON.stringify(env).includes("PRIVATE")); assert.equal(env.PATH, "bin");
});
test("test_eval_embedding_inputs_never_enter_network_requests", async () => {
	const { loadEmbedder } = await import("../dist/vector-retriever.js");
	const requests = new Array(); const original = globalThis.fetch;
	globalThis.fetch = async (...args) => { requests.push(JSON.stringify(args)); throw new Error("network forbidden"); };
	try {
		const embed = await loadEmbedder(model, "q8", async (_task, id, options) => {
			assert.equal(id, model); assert.equal(options.dtype, "q8");
			return async (texts) => ({ dims: [texts.length, 2], data: new Float32Array(texts.flatMap(() => [1, 0])) });
		});
		await embed(["PRIVATE_QUERY"], "query"); await embed(["PRIVATE_DOCUMENT"], "passage");
		assert.deepEqual(requests, []);
	} finally { globalThis.fetch = original; }
});
test("test_eval_public_dataset_uses_only_fixture_records", () => {
	assert.throws(() => E.validateDataset([row], new Set(["fixture-only"])));
	assert.throws(() => E.validateDataset([{ ...row, source: "operations" }], new Set(["a"]), { publicOnly: true }));
});
test("test_eval_sensitive_records_excluded_from_queries_but_kept_in_corpus", () => {
	const records = [{ slug: "a", title: "연결 설정", body: "pool maximum 20" }, { slug: "secret", title: "계정", body: ["user", "example.invalid"].join(String.fromCharCode(64)) }];
	assert.equal(E.sensitiveRecord(records[0]), false); assert.equal(E.sensitiveRecord(records[1]), true);
	assert.throws(() => E.validateDataset([{ ...row, expected: ["secret"] }], new Set(records.map((r) => r.slug)), { sourceRecords: records }));
	assert.equal(records.length, 2);
});
test("test_eval_rejects_stale_snapshot_and_measurements", () => {
	assert.throws(() => E.validateProvenance({ snapshotHash: "old" }, "new"));
	assert.throws(() => E.validateProvenance({}, "new"));
	assert.doesNotThrow(() => E.validateProvenance({ snapshotHash: "new" }, "new"));
});
test("test_eval_full_snapshot_corpus_is_not_sanitized", async () => {
	const { SqliteStore } = await import("../dist/stores/sqlite-store.js");
	const { MemoryStore } = await import("../dist/store.js");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-evaluation-full-"));
	try {
		const source = path.join(dir, "source.sqlite"); const backend = new SqliteStore(path.join(dir, "vault"), source);
		const store = new MemoryStore(backend);
		store.remember({ slug: "public", title: "설명", content: "public document", type: "semantic" });
		store.remember({ slug: "sensitive", title: "연결", content: "token=synthetic-secret", type: "semantic" });
		backend.close();
		const session = await E.openEvaluationBackend({ corpus: source, corpusKind: "sqlite", privateInput: false });
		try { assert.deepEqual(E.corpusIdentity(session.backend), ["public", "sensitive"]); assert.match(session.backend.read("sensitive").body, /synthetic-secret/); }
		finally { await session.cleanup(); }
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("test_eval_never_reads_or_writes_usage_event_queries", async () => {
	const { MemoryStore } = await import("../dist/store.js");
	const session = await E.openEvaluationBackend({ corpus: "eval/fixture-vault", corpusKind: "file" });
	const calls = new Array();
	const backend = new Proxy(session.backend, { get(target, key) { calls.push(String(key)); if (/usage|revision/i.test(String(key))) throw new Error("forbidden"); const value = target[key]; return typeof value === "function" ? value.bind(target) : value; } });
	try {
		const store = new MemoryStore(backend); store.reinforce = () => {};
		assert.equal(E.corpusIdentity(backend).length, 160);
		E.rankRow(store, null, { query: "connection pool" }, [], null);
		const first = store.retriever.entries()[0];
		const vec = { qv: new Map([[row, new Float32Array([1])]]), mod: { VECTOR_TOP_K: 10 }, vr: { nearest: () => [{ key: first.key, cos: 0.8 }] } };
		E.rankRow(store, vec, row, [], { fusion: "rrf", w: 1, tau: 0.7 });
		assert.ok(calls.includes("read")); assert.ok(calls.every((k) => !/usage|revision/i.test(k)));
	} finally { await session.cleanup(); }
});
test("test_eval_external_output_contains_aggregates_only", () => {
	const text = JSON.stringify(E.aggregateOutput({ queries: [{ query: "PRIVATE", slug: "PRIVATE" }], fixture: { count: 618, title: "PRIVATE" }, splits: { positive: { all: { n: 40, recall1: 0.5, recall5: 0.8, mrr: 0.7, body: "PRIVATE" } } }, latencyMs: { p50: 1, p95: 2, mode: "PRIVATE" }, path: "PRIVATE" }));
	assert.ok(!text.includes("PRIVATE")); assert.ok(text.includes("recall5"));
});
test("test_eval_external_errors_do_not_echo_private_data", () => {
	const result = spawnSync(process.execPath, ["scripts/eval-retrieval.mjs", "--queries", "PRIVATE_QUERY_PATH", "--corpus", "PRIVATE_CORPUS_PATH"], { encoding: "utf8", timeout: 10000 });
	assert.notEqual(result.status, 0); assert.ok(!`${result.stdout}${result.stderr}`.includes("PRIVATE_"));
});
test("test_eval_private_fallback_is_explicit_and_confined", () => {
	const privateRoot = path.resolve(".astron-logs/ops-eval");
	for (const file of [".astron-logs/ops-eval/results.json", ".astron-logs/ops-snapshot/results.json", "."]) {
		for (const opts of [{}, { privateRoot }]) {
			assert.throws(() => E.privatePath(file, opts), /invalid detail destination|explicit root/);
		}
	}
});
test("test_eval_rejects_removed_private_fallback_option", () => {
	assert.throws(() => E.readArgs(["--private-fallback"]), /Unknown option/);
});
test("test_eval_private_workspace_requires_external_root", async () => {
	for (const opts of [{}, { privateRoot: path.resolve(".astron-logs/ops-eval") }]) {
		await assert.rejects(E.openEvaluationBackend({ corpus: "eval/fixture-vault", privateInput: true, ...opts }), /private workspace required|invalid detail destination/);
	}
});
test("test_eval_external_private_root_confines_destination", () => {
	const privateRoot = path.resolve("..", `rag-evaluation-${process.pid}`);
	const file = path.join(privateRoot, "runs", "results.json");
	assert.equal(E.privatePath(file, { privateRoot }), file);
	for (const input of [privateRoot, path.join(`${privateRoot}-other`, "results.json"), `${privateRoot}/../results.json`, path.resolve("eval/results.json")]) {
		assert.throws(() => E.privatePath(input, { privateRoot }));
	}
});
test("test_eval_snapshot_evaluation_preserves_source_hash", async () => {
	const { SqliteStore } = await import("../dist/stores/sqlite-store.js");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-evaluation-snapshot-"));
	try {
		const source = path.join(dir, "source.sqlite"); const db = new SqliteStore(path.join(dir, "vault"), source); db.close();
		const hash = () => crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex"); const before = hash();
		const session = await E.openEvaluationBackend({ corpus: source, corpusKind: "sqlite", privateInput: false, allowEmpty: true });
		assert.notEqual(session.databasePath, source); await session.cleanup(); assert.equal(hash(), before);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("test_eval_parallel_runs_use_isolated_workspaces", async () => {
	const sessions = await Promise.all([E.openEvaluationBackend({ corpus: "eval/fixture-vault", corpusKind: "file" }), E.openEvaluationBackend({ corpus: "eval/fixture-vault", corpusKind: "file" })]);
	try { assert.notEqual(sessions[0].dir, sessions[1].dir); await sessions[0].cleanup(); assert.ok(fs.existsSync(sessions[1].dir)); } finally { await Promise.all(sessions.map((s) => s.cleanup())); }
});
test("test_eval_cleanup_runs_after_success_and_failure", async () => {
	for (const fail of [false, true]) {
		let cleaned = 0;
		try { await E.withEvaluationBackend({ backend: { loadAll: () => [] }, cleanup: async () => cleaned++ }, async () => { if (fail) throw new Error("failed"); return 1; }); } catch (e) { assert.equal(e.message, "failed"); }
		assert.equal(cleaned, 1);
	}
});

test("test_eval_grid_reuses_identical_runtime_candidates", async () => {
	const { MemoryStore, parseQuery } = await import("../dist/store.js");
	const session = await E.openEvaluationBackend({ corpus: "eval/fixture-vault", corpusKind: "file" });
	try {
		const store = new MemoryStore(session.backend); store.reinforce = () => {};
		store.retriever.sync(session.backend); store.retriever.sync = () => {};
		const rows = E.loadGolden(new Set(session.backend.listSlugs(true).map((r) => r.slug))).filter((r) => !r.holdout).slice(0, 2);
		const entries = store.retriever.entries();
		const hits = rows.map((row) => {
			const lexical = store.retriever.search(parseQuery(row.query), Infinity, {}, "legacy");
			const first = entries.find((e) => e.record.slug === lexical[0].record.slug);
			const extra = entries.find((e) => !lexical.some((c) => c.record.slug === e.record.slug));
			assert.ok(first && extra);
			return [{ key: first.key, cos: 0.85 }, { key: extra.key, cos: 0.79 }];
		});
		const vec = { qv: new Map(rows.map((r, i) => [r, new Float32Array([i])])), mod: { VECTOR_TOP_K: 10 }, vr: { nearest: (v, _filter, k, tau) => hits[v[0]].filter((h) => h.cos >= tau).slice(0, k) } };
		let calls = 0; const search = store.searchDetailed.bind(store);
		store.searchDetailed = (...args) => { calls++; return search(...args); };
		const expected = E.runGrid(rows, (row, cfg) => E.rankRow(store, cfg ? vec : null, row, [], cfg));
		const uncachedCalls = calls; calls = 0;
		const actual = await E.runCachedGrid(store, vec, rows, () => []);
		assert.deepEqual(actual, expected);
		assert.ok(calls < uncachedCalls / 4);
	} finally { await session.cleanup(); }
});

test("test_overlap_preserves_token_semantics_with_linear_normalization", async () => {
	const { overlap, tokenMatch, MIN_OVERLAP_TOKENS, PARTICLES } = await import("../dist/retriever.js");
	const reference = (a, b) => {
		const sa = [...new Set(a)]; const sb = [...new Set(b)];
		if (sa.length < MIN_OVERLAP_TOKENS || sb.length < MIN_OVERLAP_TOKENS) return 0;
		const intersection = sa.filter((t) => sb.some((u) => tokenMatch(t, u))).length;
		return intersection / (sa.length + sb.length - intersection);
	};
	const cases = [[], ["모드를", "모드", "서버", "서버리스"], ["모드는", "모드가", "릴리스노트", "릴리스"], ["자료에서는", "자료에서", "부산", "부산물"], ["가나다", "가나다", "xyz", "abc"]];
	for (const a of cases) for (const b of cases) {
		assert.equal(overlap(a, b), reference(a, b));
		assert.equal(overlap([...a, "수정"], b), reference([...a, "수정"], b));
	}
	const a = Array.from({ length: 40 }, (_, i) => `가나다항목${i}`);
	const b = Array.from({ length: 40 }, (_, i) => `서로다른값${i}`);
	const endsWith = String.prototype.endsWith; let calls = 0;
	String.prototype.endsWith = function (...args) { calls++; return endsWith.apply(this, args); };
	try { assert.equal(overlap(a, b), 0); }
	finally { String.prototype.endsWith = endsWith; }
	assert.ok(calls <= (a.length + b.length) * PARTICLES.length, `normalization checks=${calls}`);
});
