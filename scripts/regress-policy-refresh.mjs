import yaml from "js-yaml";
import { assert, fs, path, root, test } from "./regress-policy-common.mjs";
import * as collector from "./collect-model-docs.mjs";

const base = "https://platform.claude.com";
const choosing = ["/docs/en/about-claude/models/choosing-a-model", "/docs/ko/about-claude/models/choosing-a-model"];
const sources = ["models-overview.md", "prompt-caching.md", "effort.md", "features.md"].map((name) => fs.readFileSync(path.join(root, "test/fixtures/official-docs", name), "utf8"));
const seed = () => {
	const directory = fs.mkdtempSync(path.join(root, ".astron-logs/refresh-test-"));
	const ontologyFile = path.join(directory, "ontology.yaml");
	fs.copyFileSync(path.join(root, "ontology/ontology.yaml"), ontologyFile);
	return { directory, ontologyFile, cacheDir: path.join(directory, "cache"), reportFile: path.join(directory, "report.json") };
};
const fake = async (url, init) => {
	url = url.replace(/\.md$/, "");
	assert.equal(init.credentials, "omit"); assert.deepEqual(init.headers, {});
	if (url.includes("choosing-a-model")) return new Response(sources.map((text) => `[doc](${text.match(/^Source-URL: (.*)$/m)?.[1]})`).join("\n"));
	const matching = sources.filter((text) => text.match(/^Source-URL: (.*)$/m)?.[1]?.replace(/#.*$/, "") === url);
	return new Response(matching.length ? matching.join("\n\n") : "Extended thinking and batch guide");
};
const run = (options) => collector.refreshDocuments({ fetchImpl: fake, checkedAt: "2026-10-21", ...options });
async function temporary(name, action) {
	await test(name, async () => { const options = seed(); try { await action(options); } finally { fs.rmSync(options.directory, { recursive: true, force: true }); } });
}

await temporary("test_refresh_rejects_invalid_urls_and_credentials", async (options) => {
	const credentialUrl = new URL(`${base}/docs/en/a`);
	credentialUrl.username = "fixture";
	credentialUrl.password = "fixture";
	for (const url of ["http://platform.claude.com/docs/en/a", "https://example.test/docs/en/a", credentialUrl.href]) {
		const data = yaml.load(fs.readFileSync(options.ontologyFile, "utf8")); data.documentSources = [url];
		fs.writeFileSync(options.ontologyFile, yaml.dump(data));
		await assert.rejects(run(options));
	}
});
await temporary("test_refresh_enforces_official_origin_and_redirect_limit", async (options) => {
	for (const location of ["https://other.test/doc", `${base}:444/docs/en/a`, choosing[0]]) assert.equal((await run({ ...options, fetchImpl: async () => new Response(null, { status: 302, headers: { location } }) })).status, "blocked");
	let count = 0;
	assert.equal((await collector.refreshDocuments({ ...options, fetchImpl: async () => new Response(null, { status: 302, headers: { location: `/docs/en/build-with-claude/effort?redirect=${++count}` } }) })).status, "blocked");
	assert.ok(count <= 6);
});
await temporary("test_refresh_collects_required_links_once_in_stable_order", async (options) => {
	const result = await run(options);
	assert.equal(result.status, "updated");
	const urls = result.documents.map((doc) => doc.url);
	assert.deepEqual(urls, [...new Set(urls)].sort());
	for (const suffix of [...choosing, "/docs/en/build-with-claude/extended-thinking", "/docs/en/build-with-claude/batch-processing"]) assert.ok(urls.includes(base + suffix));
});
await temporary("test_refresh_ignores_out_of_scope_links_without_fetching_them", async (options) => {
	const result = await run({ ...options, fetchImpl: async (url, init) => {
		assert.equal(new URL(url).origin, base);
		const response = await fake(url, init);
		return new Response(`${await response.text()}\n[External pricing](https://example.test/pricing)`);
	} });
	assert.equal(result.status, "updated");
});
await temporary("test_refresh_enforces_time_document_and_byte_limits", async (options) => {
	const before = fs.readFileSync(options.ontologyFile, "utf8");
	for (const limits of [{ timeoutMs: 5, fetchImpl: () => new Promise(() => {}) }, { maxDocuments: 1 }, { maxDocumentBytes: 2 }, { maxTotalBytes: 2 }]) {
		const result = await collector.refreshDocuments({ ...options, fetchImpl: fake, ...limits });
		assert.equal(result.status, "blocked"); assert.equal(fs.readFileSync(options.ontologyFile, "utf8"), before);
	}
});
await temporary("test_refresh_rejects_path_escape_symlink_and_overlap", async (options) => {
	for (const cacheDir of [path.resolve(root, "../escape"), path.dirname(options.ontologyFile)]) await assert.rejects(run({ ...options, cacheDir }));
	const link = path.join(options.directory, "link");
	fs.symlinkSync(options.directory, link, "junction");
	await assert.rejects(run({ ...options, cacheDir: path.join(link, "cache") }));
	fs.unlinkSync(link);
});
await temporary("test_refresh_parse_failure_preserves_catalog_and_checked_at", async (options) => {
	const before = fs.readFileSync(options.ontologyFile, "utf8");
	for (const body of ["<html>missing table</html>", sources[0].replace("1000000", "invalid"), sources[0]]) {
		const result = await collector.refreshDocuments({ ...options, fetchImpl: async () => new Response(body) });
		assert.equal(result.status, "blocked"); assert.equal(fs.readFileSync(options.ontologyFile, "utf8"), before);
	}
});
await temporary("test_refresh_network_failure_preserves_verified_evidence", async (options) => {
	const before = fs.readFileSync(options.ontologyFile, "utf8");
	const result = await collector.refreshDocuments({ ...options, fetchImpl: async () => new Response(null, { status: 503 }) });
	assert.equal(result.status, "blocked"); assert.equal(fs.readFileSync(options.ontologyFile, "utf8"), before);
	assert.ok(result.documents.some((doc) => doc.status === "blocked"));
});
await temporary("test_refresh_preserves_codex_and_policy_metadata", async (options) => {
	const before = yaml.load(fs.readFileSync(options.ontologyFile, "utf8"));
	const result = await run(options); assert.equal(result.status, "updated");
	const after = yaml.load(fs.readFileSync(options.ontologyFile, "utf8"));
	for (const key of ["policy_version", "catalog_revision", "rules", "constraints", "confidencePolicy"]) assert.deepEqual(after[key], before[key]);
	for (const model of before.models) {
		const updated = after.models.find((item) => item.id === model.id);
		for (const key of ["aliases", "latest", "family"]) assert.deepEqual(updated[key], model[key]);
		if (model.platforms.includes("platform:codex")) assert.deepEqual(updated, model);
	}
});
await temporary("test_refresh_releases_resources_after_success_and_failure", async (options) => {
	for (const fetchImpl of [fake, async () => new Response(null, { status: 500 }), fake]) {
		await collector.refreshDocuments({ ...options, fetchImpl });
		assert.ok(fs.readdirSync(options.cacheDir).every((name) => name !== ".lock" && !name.startsWith(".stage")));
	}
	const before = fs.readFileSync(options.ontologyFile);
	const rename = fs.renameSync;
	fs.renameSync = (source, target) => { if (target === options.ontologyFile) throw new Error("replace denied"); return rename(source, target); };
	try { assert.equal((await run(options)).status, "blocked"); } finally { fs.renameSync = rename; }
	assert.deepEqual(fs.readFileSync(options.ontologyFile), before);
	assert.ok(!fs.existsSync(path.join(options.cacheDir, ".lock")));
});
await temporary("test_refresh_evidence_contains_only_public_verified_fields", async (options) => {
	const result = await collector.refreshDocuments({ ...options, fetchImpl: async (url, init) => {
		const response = await fake(url, init); return new Response(`${await response.text()}\nprivate-sentinel-body`);
	} });
	assert.equal(result.status, "updated");
	assert.doesNotMatch(fs.readFileSync(options.reportFile, "utf8"), /private-sentinel-body/);
	for (const file of fs.readdirSync(path.join(options.directory, "official-docs"))) assert.doesNotMatch(fs.readFileSync(path.join(options.directory, "official-docs", file), "utf8"), /private-sentinel-body/);
});

await temporary("test_refresh_normalizes_current_official_markdown_without_rechecking_unverified_fields", async (options) => {
	const before = yaml.load(fs.readFileSync(options.ontologyFile, "utf8"));
	const models = before.models.filter((model) => !model.platforms.includes("platform:codex"));
	const row = (label, values) => `| ${label} | ${values.join(" | ")} |`;
	const overview = [row("Feature", models.map((model) => model.name)), row("---", models.map(() => "---")), row("Claude API ID", models.map((model) => `\`${model.id}\``)), row("Context window", models.map(() => "2M tokens")), row("Max output", models.map(() => "128K tokens")), row("Default effort", models.map((model) => model.defaultEffort)), row("Thinking", models.map(() => "Adaptive"))].join("\n");
	const effort = ["| Effort | Description |", "|---|---|", ...["low", "medium", "high", "xhigh", "max"].map((level) => `| \`${level}\` | Available on ${models.map((model) => model.name).join(", ")} |`)].join("\n");
	const pricing = ["| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |", "|---|---|---|---|---|---|", ...models.flatMap((model) => model.pricing.map((price, index) => row(`${model.name}${model.pricing.length > 1 ? index === 0 ? " (for prompts up to 100,000 tokens)" : " (for prompts over 100,000 tokens)" : ""}`, [price.input, price.cacheWrite5m, price.cacheWrite1h, price.cacheRead, price.output].map((value) => `$${value} / MTok`))))].join("\n");
	const fetchCurrent = async (url) => {
		if (url.includes("models/overview")) return new Response(overview);
		if (url.includes("prompt-caching")) return new Response(pricing);
		if (url.includes("/effort")) return new Response(effort);
		return new Response("[overview](/docs/en/models/overview#latest-models-comparison)\n[한국어](/docs/ko/about-claude/models/choosing-a-model)\n[German](/docs/de/about-claude/models/choosing-a-model)\n[login](/login?returnTo=/docs/en/about-claude/models/choosing-a-model)");
	};
	const result = await run({ ...options, fetchImpl: fetchCurrent });
	assert.equal(result.status, "updated");
	const after = yaml.load(fs.readFileSync(options.ontologyFile, "utf8"));
	assert.deepEqual(result.preservedFields, ["features", "platforms"]);
	assert.match(fs.readFileSync(path.join(options.directory, "official-docs/models-overview.md"), "utf8"), /^Preserved-Fields: features,platforms$/m);
	for (const model of after.models.filter((model) => !model.platforms.includes("platform:codex"))) {
		assert.equal(model.contextTokens, 2000000);
		assert.ok(model.sources.some((source) => source.checkedAt === "2026-10-21" && source.fields.includes("contextTokens")));
		assert.ok(model.sources.filter((source) => source.fields.includes("features")).every((source) => source.checkedAt === "2026-10-19"));
	}
	const repeated = await run({ ...options, fetchImpl: fetchCurrent });
	assert.equal(repeated.changes.length, 0);
	assert.deepEqual(yaml.load(fs.readFileSync(options.ontologyFile, "utf8")), after);
});
