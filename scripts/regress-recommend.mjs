import { assert, fs, path, root, ontology, payload, server, test } from "./regress-policy-common.mjs";
import * as recommender from "../dist/recommender.js";
import { ontologySchema } from "../dist/ontology.js";

/** @param {string} description @param {...any} options */
const rec = (description, ...options) => {
	const [role = "impl", platform, signals = {}, data = ontology()] = options;
	return recommender.recommendModel(data, description, role, platform, signals);
};
export const policyCases = [
	{ description: "UI 지연 근본 원인 분석", role: "research", model: "claude-opus-5-5", effort: "high", rule: "rule:root-cause-opus" },
	{ description: "작업함 분류 한 파일 수정", role: "impl", platform: "codex", signals: { size: "small" }, model: "gpt-6.1-sol", effort: "medium", rule: "rule:small-confirmed-codex" },
	{ description: "Tomcat 서버 정보 노출 조치", role: "impl", model: "claude-opus-5-5", effort: "high", rule: "rule:high-risk-opus" },
	{ description: "어려운 설계", role: "plan", model: "claude-opus-5-5", effort: "high", rule: "rule:design-opus" },
	{ description: "큰 구조 변경", role: "impl", signals: { size: "large", novelty: "new" }, model: "claude-opus-5-5", effort: "xhigh", rule: "rule:large-structure-opus" },
	{ description: "위험한 변경 최종 검토", role: "review", signals: { risk: "high" }, model: "claude-opus-5-5", effort: "high", rule: "rule:high-risk-opus" },
	{ description: "회사 저장소 일반 구현", role: "impl", model: "claude-sonnet-5-5", effort: "high", rule: "rule:default-sonnet" },
	{ description: "문서 검증 시험", role: "impl", model: "claude-sonnet-5-5", effort: "high", rule: "rule:default-sonnet" },
	{ description: "일반 검토", role: "review", model: "claude-sonnet-5-5", effort: "high", rule: "rule:normal-review-sonnet" },
	{ description: "자체 프로젝트 장기 병렬 구현", role: "impl", platform: "codex", model: "gpt-6.1-sol", effort: "high", rule: "rule:codex-high-roles" },
	{ description: "대규모 원인 조사", role: "research", platform: "codex", model: "gpt-6.1-sol", effort: "high", rule: "rule:codex-analysis" },
	{ description: "일반 검토", role: "review", signals: { cross_review_of: "Sonnet" }, model: "gpt-6.1-sol", effort: "high", rule: "rule:cross-review-codex" },
	{ description: "일반 검토", role: "review", signals: { cross_review_of: "Codex" }, model: "claude-sonnet-5-5", effort: "high", rule: "rule:cross-review-claude" },
	{ description: "배송 단순 조회", role: "ship", model: "claude-sonnet-5-5", effort: "medium", rule: "rule:simple-work-sonnet" },
];

await test("test_recommend_owner_policy_cases", () => {
	for (const { description, role, platform, signals, model, effort, rule } of policyCases) {
		const result = rec(description, role, platform, signals);
		assert.deepEqual([result.model, result.effort, result.rule_id, result.policy_version, result.catalog_revision], [model, effort, rule, "2026-10-21.1", "2026-10-21.1"], description);
	}
});
await test("test_recommend_structured_signals_and_keyword_fallback", () => {
	assert.equal(rec("일반 구현").effort, "high");
	assert.equal(rec("한 파일 수정").effort, "medium");
	assert.equal(rec("작업", "impl", "codex", { size: "small" }).effort, "medium");
});
await test("test_recommend_small_existing_and_new_large_boundaries", () => {
	for (const novelty of /** @type {const} */ ([undefined, "existing"])) assert.equal(rec("작업", "impl", "codex", { size: "small", novelty }).effort, "medium");
	for (const signals of /** @type {const} */ ([{ size: "small", novelty: "new" }, { size: "large" }])) assert.equal(rec("작업", "impl", "codex", signals).effort, "high");
});
await test("test_recommend_security_cannot_be_downgraded_by_small", () => {
	for (const platform of /** @type {const} */ ([undefined, "claude", "codex"])) {
		const result = rec("Tomcat 서버 정보 노출 조치", "impl", platform, { size: "small", risk: "normal" });
		assert.equal(result.classification.risk, "high");
		assert.equal(result.effort, "high");
	}
});
await test("test_recommend_filters_non_latest_models", () => {
	const data = ontology();
	data.rules.push({ ...data.rules.find((rule) => rule.platform === "codex"), "@id": "rule:old", conditions: [], model: "gpt-6-sol", priority: 99999, confidence: 1 });
	assert.equal(rec("作業", "impl", "codex", {}, data).model, "gpt-6.1-sol");
});
await test("test_recommend_haiku_requires_evidenced_exception", () => {
	const data = ontology();
	const rule = { ...data.rules.find((rule) => rule.model === "claude-sonnet-5-5"), "@id": "rule:haiku-test", conditions: [], model: "claude-haiku-5-5", priority: 99999 };
	data.rules.push(rule);
	assert.notEqual(rec("ordinary", "impl", undefined, {}, data).model, rule.model);
	data.constraints.push({ "@id": "constraint:test-haiku", kind: "owner-exception", rule: rule["@id"], approvedBy: "p1", approvedAt: "2026-10-21", link: "https://example.test/approval" });
	assert.equal(rec("ordinary", "impl", undefined, {}, data).model, rule.model);
});
await test("test_cross_review_respects_platform_and_security_priority", () => {
	assert.equal(rec("검토", "review", undefined, { cross_review_of: "Sonnet" }).model, "gpt-6.1-sol");
	assert.equal(rec("검토", "review", undefined, { cross_review_of: "Codex" }).model, "claude-sonnet-5-5");
	for (const [platform, source] of /** @type {const} */ ([["claude", "Sonnet"], ["codex", "Codex"]])) {
		const result = rec("검토", "review", platform, { cross_review_of: source });
		assert.ok(result.reasons.some((reason) => reason.includes("cross-review unavailable")));
	}
	const security = rec("보안 검토", "review", undefined, { cross_review_of: "Opus" });
	assert.equal(security.model, "claude-opus-5-5");
	assert.ok(security.reasons.some((reason) => reason.includes("cross-review unavailable")));
});
await test("test_cross_review_rejects_unknown_model_and_ambiguous_alias", () => {
	assert.throws(() => rec("검토", "review", undefined, { cross_review_of: "unknown" }));
	const data = ontology();
	data.models[0].aliases = ["Codex"];
	assert.throws(() => ontologySchema.parse(data));
});
await test("test_recommend_rule_order_and_duplicate_models_are_deterministic", () => {
	const data = ontology();
	const base = data.rules.find((rule) => rule["@id"] === "rule:default-sonnet");
	data.rules = [{ ...base, "@id": "rule:a", effort: "high", confidence: 0.9 }, { ...base, "@id": "rule:b", effort: "medium", confidence: 0.8 }];
	const first = rec("ordinary", "impl", undefined, {}, data);
	data.rules.reverse();
	assert.deepEqual(rec("ordinary", "impl", undefined, {}, data), first);
	assert.deepEqual(first.candidates, [{ model: base.model, effort: "high" }]);
});
await test("test_recommend_fails_when_no_allowed_rule_exists", () => {
	const data = ontology(); data.rules = [];
	assert.throws(() => rec("ordinary", "impl", undefined, {}, data), /no allowed/);
});
await test("test_ontology_validates_policy_catalog_invariants", () => {
	for (const mutate of [
		(data) => data.models.push(structuredClone(data.models[0])),
		(data) => data.models[0].aliases = [data.models[1].id],
		(data) => { data.models[0].family = data.models[1].family; data.models[0].latest = true; },
		(data) => data.rules[0].conditions.push({ type: "size", values: ["huge"] }),
		(data) => data.rules[0].evidence = ["unknown"],
		(data) => data.rules[0].effort = "unknown",
	]) { const data = ontology(); mutate(data); assert.throws(() => ontologySchema.parse(data)); }
});

await server(async ({ call, ontologyPath, env }) => {
	const recommend = (args) => call("recommend", { description: "ordinary", role: "impl", ...args });
	await test("test_recommend_rejects_invalid_structured_signals", async () => {
		for (const [key, value] of [["role", "other"], ["platform", "other"], ["size", "huge"], ["risk", "low"], ["novelty", "old"], ["size", 1]]) assert.equal((await recommend({ [key]: value })).isError, true);
	});
	await test("test_recommend_rejects_blank_description", async () => {
		for (const description of ["", "   ", "\n\t"]) assert.equal((await recommend({ description })).isError, true);
	});
	await test("test_recommend_enforces_description_length_boundary", async () => {
		payload(await recommend({ description: "x".repeat(4000) }));
		assert.equal((await recommend({ description: "x".repeat(4001) })).isError, true);
	});
	await test("test_recommend_treats_special_characters_as_text", async () => {
		assert.equal(payload(await recommend({ description: "'\" \\ ../secret $(echo text); 😀" })).model, "claude-sonnet-5-5");
	});
	await test("test_recommend_parallel_calls_are_identical", async () => {
		const results = await Promise.all(Array.from({ length: 12 }, () => recommend({})));
		assert.equal(new Set(results.map((result) => result.content[0].text)).size, 1);
	});
	await test("test_recommend_recovers_after_invalid_ontology", async () => {
		const before = fs.readFileSync(ontologyPath);
		try { fs.writeFileSync(ontologyPath, "{"); assert.equal((await recommend({})).isError, true); }
		finally { fs.writeFileSync(ontologyPath, before); }
		assert.equal(payload(await recommend({})).model, "claude-sonnet-5-5");
	});
	await test("test_recommend_snapshots_change_only_declared_fields", async () => {
		const snapshots = JSON.parse(fs.readFileSync(path.join(root, "test/fixtures/recommend-output-snapshots.json"), "utf8"));
		for (const snapshot of snapshots) {
			const codex = snapshot.platform === "codex";
			const high = snapshot.output.classification.risk === "high";
			const rule = codex ? (high ? "rule:codex-high-risk" : ["plan", "impl", "review"].includes(snapshot.role) ? "rule:codex-high-roles" : "rule:codex-medium-roles") : high ? "rule:high-risk-opus" : snapshot.role === "impl" ? "rule:default-sonnet" : "rule:simple-work-sonnet";
			const model = codex ? "gpt-6.1-sol" : high ? "claude-opus-5-5" : "claude-sonnet-5-5";
			const effort = codex ? snapshot.output.effort : high || snapshot.role === "impl" ? "high" : "medium";
			const reasons = { "rule:codex-high-risk": "High-risk Codex work uses high effort.", "rule:codex-high-roles": "Codex implementation, planning and review use high effort.", "rule:codex-medium-roles": "Routine Codex research, shipping and coordination use medium effort.", "rule:high-risk-opus": "Security and high-risk work use Opus high.", "rule:default-sonnet": "General implementation, documentation and tests use Sonnet high.", "rule:simple-work-sonnet": "Shipping and simple queries use Sonnet medium." };
			const expected = { ...snapshot.output, model, effort, reasons: [reasons[rule]], appliedConstraints: [], evidence: ["ontology/evidence/owner-policy-2026-10-21.md"], candidates: [{ model, effort }], policy_version: "2026-10-21.1", catalog_revision: "2026-10-21.1", rule_id: rule };
			assert.deepEqual(payload(await recommend({ description: snapshot.description, role: snapshot.role, ...(codex ? { platform: "codex" } : {}) })), expected, snapshot.name);
		}
	});
	await test("test_policy_tests_override_vault_and_sqlite_paths_and_cleanup", () => {
		assert.equal(path.dirname(env.ASTRONRAG_VAULT), path.dirname(env.ASTRONRAG_SQLITE_PATH));
		assert.notEqual(env.ASTRONRAG_STORE, "file");
	});
});
