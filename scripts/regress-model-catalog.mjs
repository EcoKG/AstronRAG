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
		const data = ontology();
		const unknown = data.models.find((model) => model.id === "gpt-6-luna");
		for (const field of ["pricing", "maxOutputTokens", "sources", "defaultEffort"]) delete unknown[field];
		const offline = catalog.modelCatalog(catalog.ontologySchema.parse(data)).models.find((model) => model.id === "gpt-6-luna");
		assert.deepEqual([offline?.maxOutputTokens, offline?.pricing, offline?.sourceUrls, offline?.checkedAt], [null, null, [], null]);
		const haiku = models.find((model) => model.id === "claude-haiku-5-5");
		assert.deepEqual(haiku.pricing, ontology().models.find((model) => model.id === haiku.id).pricing);
		assert.ok(haiku.pricing.length > 1);
		assert.equal(haiku.recommendable, false);
		assert.equal(models.find((model) => model.id === "gpt-6-luna").recommendable, false);
	});
	await test("test_model_catalog_codex_values_match_official_docs", async () => {
		const models = payload(await call("model_catalog")).models;
		const efforts = ["low", "medium", "high", "xhigh", "max"];
		/** @type {Record<string, [string[], [number, number, number, number, number]]>} */
		const expected = {
			"gpt-6.1-sol": [efforts, [2, 0.1, 2.5, 5, 10]],
			"gpt-6-sol": [["none", ...efforts], [2, 0.2, 2.5, 5, 10]],
			"gpt-6-luna": [["none", ...efforts], [0.1, 0.01, 0.125, 0.25, 0.5]],
			"gpt-5.6-sol": [["none", ...efforts], [4, 0.4, 5, 10, 20]],
			"gpt-6-astra": [efforts, [10, 1, 12.5, 25, 50]],
		};
		for (const id of Object.keys(expected)) {
			const [supported, [input, cacheRead, cacheWrite30m, cacheWrite12h, output]] = expected[id];
			const model = models.find((item) => item.id === id);
			assert.deepEqual([model.platform, model.contextTokens, model.maxOutputTokens, [...model.supportedEfforts].sort(), model.checkedAt], ["codex", 1050000, 128000, [...supported].sort(), "2026-10-22"], id);
			assert.deepEqual(model.pricing, [
				{ promptTokens: 272000, input, cacheRead, cacheWrite30m, cacheWrite12h, output },
				{ promptTokens: null, input: input * 2, cacheRead: cacheRead * 2, cacheWrite30m: cacheWrite30m * 2, cacheWrite12h: cacheWrite12h * 2, output: output * 1.5 },
			], id);
			assert.deepEqual(model.sourceUrls, [`https://developers.openai.com/api/docs/models/${id}`, "https://developers.openai.com/api/docs/guides/prompt-caching", "https://developers.openai.com/api/docs/pricing"].sort(), id);
			assert.ok(!model.supportedEfforts.includes("minimal") && !model.supportedEfforts.includes("ultra"), id);
		}
		const data = ontology();
		assert.equal(data.models.find((model) => model.id === "gpt-6-astra").defaultEffort, undefined);
		for (const id of ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol"]) assert.equal(data.models.find((model) => model.id === id).defaultEffort, "medium", id);
	});
	await test("test_model_catalog_marks_cli_observation_with_lower_confidence", async () => {
		const models = payload(await call("model_catalog")).models;
		const observed = {
			"gpt-6.1-sol": [500000, "low", true], "gpt-6-astra": [272000, "medium", true], "gpt-6-sol": [272000, "medium", true],
			"gpt-6-luna": [272000, "medium", false], "gpt-5.6-sol": [272000, "low", true],
		};
		for (const [id, [contextTokens, defaultEffort, ultra]] of Object.entries(observed)) {
			const model = models.find((item) => item.id === id);
			assert.equal(model.observed.evidence, "ontology/evidence/codex-catalog-2026-10-20.md", id);
			assert.ok(model.observed.confidence > 0 && model.observed.confidence <= 0.3, id);
			assert.deepEqual([model.observed.contextTokens, model.observed.defaultEffort, model.observed.supportedEfforts.includes("ultra")], [contextTokens, defaultEffort, ultra], id);
		}
		for (const model of models.filter((item) => item.platform === "claude")) assert.equal(model.observed, null, model.id);
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
	assert.equal(first.catalog_revision, "2026-10-22.1");
	assert.deepEqual(first.models.map((model) => model.id), first.models.map((model) => model.id).sort());
});
await test("test_policy_tools_do_not_use_credentials_or_network", async () => {
	const marker = "credential-regression-sentinel";
	await server(async ({ call }) => {
		for (const [name, args] of [["recommend", { description: "ordinary", role: "impl" }], ["model_catalog", {}], ["record_recommendation_feedback", { event_id: randomUUID(), policy_version: "2026-10-22.1", catalog_revision: "2026-10-22.1", rule_id: "rule:default-sonnet", model: "claude-sonnet-5-5", effort: "high", role: "impl", risk: "normal", input_tokens: 0, output_tokens: 0, cost_usd: null, duration_ms: 0, reverts: 0, verdict: "pass" }]]) {
			assert.doesNotMatch(JSON.stringify(payload(await call(name, args))), new RegExp(marker));
		}
	}, { ANTHROPIC_API_KEY: marker, OPENAI_API_KEY: marker, HTTPS_PROXY: "http://127.0.0.1:1" }, true);
});
