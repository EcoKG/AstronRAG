import { assert, ontology, payload, server, test } from "./regress-policy-common.mjs";
import * as catalog from "../dist/ontology.js";
import { randomUUID } from "node:crypto";

await server(async ({ client, call }) => {
	await test("test_model_catalog_output_matches_schema_and_text", async () => {
		const result = await call("model_catalog");
		const value = payload(result);
		assert.deepEqual(result.structuredContent, value);
		assert.deepEqual(catalog.modelCatalogSchema.parse(value), value);
		const tool = (await client.listTools()).tools.find((tool) => tool.name === "model_catalog");
		assert.equal(tool.outputSchema.type, "object");
		assert.deepEqual(tool.outputSchema.required, ["catalog_revision", "models"]);
	});
	await test("test_forbidden_models_are_never_recommendable", async () => {
		const models = payload(await call("model_catalog")).models;
		for (const id of ["gpt-6-astra", "claude-fable-5-1"]) {
			assert.deepEqual(models.filter((model) => model.id === id).map((model) => [model.excluded, model.recommendable]), [[true, false]]);
		}
		for (const platform of ["claude", "codex"]) for (const role of ["impl", "research", "review", "ship"]) {
			const result = payload(await call("recommend", { description: "security architecture", role, platform }));
			for (const candidate of [result, ...result.candidates]) assert.ok(!["gpt-6-astra", "claude-fable-5-1"].includes(candidate.model));
		}
	});
	await test("test_model_catalog_preserves_unknown_values_and_price_tiers", async () => {
		const models = payload(await call("model_catalog")).models;
		const codex = models.find((model) => model.id === "gpt-6.1-sol");
		assert.equal(codex.maxOutputTokens, null);
		assert.equal(codex.pricing, null);
		assert.equal(codex.checkedAt, "2026-10-20");
		const haiku = models.find((model) => model.id === "claude-haiku-5-5");
		assert.deepEqual(haiku.pricing, ontology().models.find((model) => model.id === haiku.id).pricing);
		assert.ok(haiku.pricing.length > 1);
		assert.equal(haiku.recommendable, false);
		assert.equal(models.find((model) => model.id === "gpt-6-luna").recommendable, false);
	});
	await test("test_mcp_tools_additions_preserve_existing_contracts", async () => {
		const { tools } = await client.listTools();
		assert.equal(tools.length, 11);
		const recommend = tools.find((tool) => tool.name === "recommend");
		assert.deepEqual(Object.keys(recommend.inputSchema.properties).sort(), ["cross_review_of", "description", "novelty", "platform", "risk", "role", "size"]);
	});
});
await test("test_model_catalog_revision_and_order_survive_restart", async () => {
	/** @type {ReturnType<typeof catalog.modelCatalog> | undefined} */
	let first;
	await server(async ({ call }) => { first = payload(await call("model_catalog")); });
	await server(async ({ call }) => { assert.deepEqual(payload(await call("model_catalog")), first); });
	assert.ok(first);
	assert.equal(first.catalog_revision, "2026-10-21.1");
	assert.deepEqual(first.models.map((model) => model.id), first.models.map((model) => model.id).sort());
});
await test("test_policy_tools_do_not_use_credentials_or_network", async () => {
	const marker = "credential-regression-sentinel";
	await server(async ({ call }) => {
		for (const [name, args] of [["recommend", { description: "ordinary", role: "impl" }], ["model_catalog", {}], ["record_recommendation_feedback", { event_id: randomUUID(), policy_version: "2026-10-21.1", catalog_revision: "2026-10-21.1", rule_id: "rule:default-sonnet", model: "claude-sonnet-5-5", effort: "high", role: "impl", risk: "normal", input_tokens: 0, output_tokens: 0, cost_usd: null, duration_ms: 0, reverts: 0, verdict: "pass" }]]) {
			assert.doesNotMatch(JSON.stringify(payload(await call(name, args))), new RegExp(marker));
		}
	}, { ANTHROPIC_API_KEY: marker, OPENAI_API_KEY: marker, HTTPS_PROXY: "http://127.0.0.1:1" }, true);
});
