import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { assert, fs, os, path, ontology, payload, server, test } from "./regress-policy-common.mjs";
import * as recommender from "../dist/recommender.js";
import { SqliteStore } from "../dist/stores/sqlite-store.js";

/** @param {Record<string, unknown>} [overrides] @returns {import('../dist/stores/memory-store.js').RecommendationFeedback} */
const event = (overrides = {}) => ({ event_id: crypto.randomUUID(), policy_version: "2026-10-22.1", catalog_revision: "2026-10-22.1", rule_id: "rule:default-sonnet", model: "claude-sonnet-5-5", effort: "high", role: "impl", risk: "normal", input_tokens: 0, output_tokens: 0, cost_usd: null, duration_ms: 0, reverts: 0, verdict: "pass", ...overrides });
await server(async ({ call, env }) => {
	const record = (args) => call("record_recommendation_feedback", args);
	await test("test_feedback_rejects_free_text_unknown_fields_and_invalid_ids", async () => {
		for (const patch of [{ event_id: "invalid" }, { description: "private body" }, { body: "private body" }, { reason: "free text" }, { user: "private" }]) assert.equal((await record(event(patch))).isError, true);
	});
	await test("test_feedback_validates_numeric_boundaries_and_unknown_cost", async () => {
		for (const field of ["input_tokens", "output_tokens", "duration_ms", "reverts"]) for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal((await record(event({ [field]: value }))).isError, true);
		for (const value of [-1, NaN, Infinity]) assert.equal(recommender.feedbackInputSchema.safeParse(event({ cost_usd: value })).success, false);
		for (const value of [null, 0, 0.125]) payload(await record(event({ cost_usd: value })));
	});
	await test("test_feedback_rejects_mismatched_policy_rule_and_model", async () => {
		for (const patch of [{ policy_version: "other" }, { catalog_revision: "other" }, { rule_id: "rule:unknown" }, { model: "gpt-6-astra" }, { effort: "medium" }, { cross_review_of: "unknown" }, { rule_id: "rule:high-risk-opus", model: "claude-opus-5-5", risk: "normal" }]) assert.equal((await record(event(patch))).isError, true);
	});
	await test("test_feedback_concurrent_duplicate_events_are_idempotent", async () => {
		const value = event();
		const results = await Promise.all(Array.from({ length: 8 }, () => record(value)));
		assert.equal(results.map(payload).filter((result) => !result.duplicate).length, 1);
		assert.equal((await record({ ...value, reverts: 1 })).isError, true);
	});
	await test("test_feedback_persists_only_numeric_and_validated_identifier_fields", async () => {
		const db = new DatabaseSync(env.ASTRONRAG_SQLITE_PATH);
		try {
			const columns = db.prepare("PRAGMA table_info(recommendation_feedback)").all().map((row) => row.name);
			assert.deepEqual(columns, ["event_id", "created_at", "policy_version", "catalog_revision", "rule_id", "model", "effort", "role", "size", "risk", "novelty", "cross_review_of", "input_tokens", "output_tokens", "cost_usd", "duration_ms", "reverts", "verdict"]);
			assert.equal(db.prepare("SELECT count(*) n FROM recommendation_feedback WHERE cost_usd IS NULL").get()?.n, 2);
			for (const sql of ["UPDATE recommendation_feedback SET input_tokens = -1", "UPDATE recommendation_feedback SET input_tokens = 0.5", "UPDATE recommendation_feedback SET verdict = 'other'", "UPDATE recommendation_feedback SET risk = 'low'", "UPDATE recommendation_feedback SET role = 'other'"]) assert.throws(() => db.exec(sql));
		} finally { db.close(); }
	});
});

await server(async ({ call, client, env }) => {
	for (const { name, args, rule, size, novelty } of [
		{ name: "test_feedback_round_trip_keyword_small_claude", args: { description: "한 파일 수정", role: "impl" }, rule: "rule:small-confirmed-claude", size: "small", novelty: "existing" },
		{ name: "test_feedback_round_trip_keyword_small_codex", args: { description: "작업함 분류 한 파일 수정", role: "impl", platform: "codex" }, rule: "rule:small-confirmed-codex", size: "small", novelty: "existing" },
		{ name: "test_feedback_round_trip_keyword_new_large", args: { description: "새로운 설계", role: "impl", size: "large" }, rule: "rule:large-structure-opus", size: "large", novelty: "new" },
		{ name: "test_feedback_round_trip_structured_small_claude", args: { description: "작업", role: "impl", size: "small", novelty: "existing" }, rule: "rule:small-confirmed-claude", size: "small", novelty: "existing" },
		{ name: "test_feedback_round_trip_structured_small_codex", args: { description: "작업", role: "impl", platform: "codex", size: "small", novelty: "existing" }, rule: "rule:small-confirmed-codex", size: "small", novelty: "existing" },
		{ name: "test_feedback_round_trip_structured_new_large", args: { description: "작업", role: "impl", size: "large", novelty: "new" }, rule: "rule:large-structure-opus", size: "large", novelty: "new" },
		{ name: "test_feedback_round_trip_explicit_signals_override_keywords", args: { description: "한 파일 수정 새로운 설계", role: "impl", size: "medium", novelty: "existing" }, rule: "rule:default-sonnet", size: "medium", novelty: "existing" },
	]) {
		await test(name, async () => {
			const recommendation = payload(await call("recommend", args));
			assert.equal(recommendation.rule_id, rule);
			const { policy_version, catalog_revision, rule_id, model, effort, role, classification } = recommendation;
			const value = event({ policy_version, catalog_revision, rule_id, model, effort, role, risk: classification.risk, size: recommendation.size, novelty: recommendation.novelty });
			const db = new DatabaseSync(env.ASTRONRAG_SQLITE_PATH);
			const feedbackStore = new SqliteStore(env.ASTRONRAG_VAULT, env.ASTRONRAG_SQLITE_PATH, { readOnly: true });
			try {
				const stats = () => feedbackStore.recommendationFeedbackStats(policy_version, catalog_revision)[rule_id] ?? { samples: 0, successes: 0 };
				const before = stats();
				const recorded = payload(await call("record_recommendation_feedback", value));
				assert.equal(recorded.recorded, true);
				assert.equal(recorded.duplicate, false);
				const expected = { samples: before.samples + 1, successes: before.successes + 1 };
				assert.deepEqual(stats(), expected);
				assert.deepEqual({ ...db.prepare("SELECT rule_id, size, novelty FROM recommendation_feedback WHERE event_id = ?").get(value.event_id) }, { rule_id: rule, size, novelty });
				assert.equal(payload(await call("record_recommendation_feedback", value)).duplicate, true);
				assert.deepEqual(stats(), expected);
			} finally { feedbackStore.close(); db.close(); }
		});
	}
	await test("test_recommend_output_schema_exposes_effective_signals", async () => {
		const tool = (await client.listTools()).tools.find((tool) => tool.name === "recommend");
		assert.equal(tool.outputSchema?.type, "object");
		for (const field of ["size", "novelty"]) assert.ok(tool.outputSchema.required.includes(field));
		assert.deepEqual(tool.outputSchema.properties.size.enum, ["small", "medium", "large"]);
		assert.deepEqual(tool.outputSchema.properties.novelty.enum, ["new", "existing"]);
		const result = await call("recommend", { description: "한 파일 수정", role: "impl" });
		assert.deepEqual(result.structuredContent, payload(result));
	});
});

await test("test_rule_confidence_switches_at_twenty_decisive_samples", () => {
	for (const samples of [0, 19]) assert.equal(recommender.calculateRuleConfidence(0.2, { samples, successes: 0 }, 20, 20), 0.2);
	assert.equal(recommender.calculateRuleConfidence(0.2, { samples: 20, successes: 20 }, 20, 20), 0.6);
	assert.equal(recommender.calculateRuleConfidence(0.2, { samples: 20, successes: 0 }, 20, 20), 0.1);
});

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "astron-feedback-"));
const database = path.join(directory, "store.sqlite");
const vault = path.join(directory, "vault");
/** @type {SqliteStore | undefined} */
let store;
try {
	await test("test_feedback_schema_upgrade_preserves_existing_store", () => {
		store = new SqliteStore(vault, database);
		store.setMeta("sentinel", "preserved"); store.close();
		const db = new DatabaseSync(database);
		db.prepare(`INSERT INTO memories (slug,id,title,description,type,confidence,storage_strength,status,created,updated,last_accessed,last_reinforced,access_count,body)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("upgrade-memory", "upgrade-memory-id", "compatibility fixture", "fixture", "semantic", 0.7, 1, "active", "2026-10-19", "2026-10-19", "2026-10-19", "2026-10-19", 0, "compatibility fixture body");
		const before = db.prepare("SELECT * FROM store_meta ORDER BY key").all();
		const memories = db.prepare("SELECT * FROM memories ORDER BY slug").all();
		db.exec("DROP TABLE IF EXISTS recommendation_feedback"); db.close();
		store = new SqliteStore(vault, database); store.close();
		const after = new DatabaseSync(database);
		try { assert.deepEqual(after.prepare("SELECT * FROM store_meta ORDER BY key").all(), before); assert.deepEqual(after.prepare("SELECT * FROM memories ORDER BY slug").all(), memories); assert.ok(after.prepare("SELECT name FROM sqlite_master WHERE name='recommendation_feedback'").get()); }
		finally { after.close(); }
	});
	await test("test_feedback_readonly_legacy_store_is_not_modified", () => {
		const db = new DatabaseSync(database); db.exec("DROP TABLE IF EXISTS recommendation_feedback"); db.close();
		const before = fs.readFileSync(database);
		store = new SqliteStore(vault, database, { readOnly: true });
		assert.deepEqual(store.recommendationFeedbackStats("old", "old"), {});
		assert.throws(() => store.recordRecommendationFeedback(event()), /read.only/i);
		store.close(); assert.deepEqual(fs.readFileSync(database), before);
	});
	await test("test_feedback_concurrent_store_initialization_is_safe", async () => {
		const value = event({ policy_version: "worker-fixture" });
		const results = new Array();
		await Promise.all(Array.from({ length: 4 }, (_, index) => new Promise((resolve, reject) => {
			const worker = new Worker(`import { parentPort } from 'node:worker_threads'; import { SqliteStore } from ${JSON.stringify(new URL("../dist/stores/sqlite-store.js", import.meta.url).href)}; const store = new SqliteStore(${JSON.stringify(vault)}, ${JSON.stringify(database)}); parentPort.postMessage(store.recordRecommendationFeedback(${JSON.stringify(value)})); store.close();`, { eval: true });
			worker.once("message", (result) => results.push(result));
			worker.once("error", reject); worker.once("exit", (code) => code ? reject(new Error(`worker ${index}: ${code}`)) : resolve(undefined));
		})));
		assert.equal(results.filter((result) => !result.duplicate).length, 1);
	});
	await test("test_rule_confidence_isolates_versions_rules_and_inconclusive_results", () => {
		store = new SqliteStore(vault, database);
		for (const value of [event(), event({ verdict: "inconclusive" }), event({ policy_version: "other" }), event({ catalog_revision: "other" }), event({ rule_id: "rule:other" })]) store.recordRecommendationFeedback(value);
		assert.deepEqual(store.recommendationFeedbackStats("2026-10-22.1", "2026-10-22.1")["rule:default-sonnet"], { samples: 1, successes: 1 });
		store.close();
	});
	await test("test_feedback_changes_confidence_after_restart_without_overriding_policy", () => {
		store = new SqliteStore(vault, database);
		for (let i = 0; i < 20; i++) store.recordRecommendationFeedback(event({ rule_id: "rule:high-risk-opus", model: "claude-opus-5-5", verdict: "fail" }));
		const before = store.recommendationFeedbackStats("2026-10-22.1", "2026-10-22.1"); store.close();
		store = new SqliteStore(vault, database);
		const after = store.recommendationFeedbackStats("2026-10-22.1", "2026-10-22.1");
		assert.deepEqual(after, before);
		const result = recommender.recommendModel(ontology(), "보안 검토", "review", undefined, {}, after);
		assert.equal(result.model, "claude-opus-5-5"); assert.equal(result.ruleConfidence, 0.1);
		store.close();
	});
} finally { store?.close(); fs.rmSync(directory, { recursive: true, force: true }); }

await test("test_feedback_file_store_returns_unsupported_without_writes", async () => {
	await server(async ({ call, directory, env }) => {
		const files = () => fs.readdirSync(directory, { recursive: true }).sort();
		const before = files();
		const result = await call("record_recommendation_feedback", event());
		assert.equal(result.isError, true); assert.match(result.content[0].text, /unsupported/i);
		assert.deepEqual(files(), before); assert.equal(fs.existsSync(env.ASTRONRAG_SQLITE_PATH), false);
		assert.equal(payload(await call("recommend", { description: "ordinary", role: "impl" })).ruleConfidence, 0.2);
	}, { ASTRONRAG_STORE: "file" });
});
