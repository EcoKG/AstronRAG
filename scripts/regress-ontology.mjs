import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import yaml from "js-yaml";
import { collectOfficialModels, diffOfficialModels } from "../dist/model-docs.js";
import { ontologySchema, parseOntology } from "../dist/ontology.js";
import { buildOntologyCache } from "./build-ontology.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(root, "test", "fixtures", "official-docs");
const testTmpDir = path.resolve(process.env.BBM_TEST_TMPDIR ?? os.tmpdir());
fs.mkdirSync(testTmpDir, { recursive: true });
let failures = 0;

function makeTemp(prefix) {
	return fs.mkdtempSync(path.join(testTmpDir, prefix));
}

function removeTree(directory) {
	if (!fs.existsSync(directory)) return;
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const target = path.join(directory, entry.name);
		if (entry.isDirectory()) removeTree(target);
		else fs.unlinkSync(target);
	}
	fs.rmdirSync(directory);
}

async function test(name, fn) {
	try {
		await fn();
		console.log(`PASS ${name}`);
	} catch (error) {
		failures++;
		console.error(`FAIL ${name}: ${error instanceof Error ? error.stack : error}`);
	}
}

await test("test_ontology_temp_directories_use_selected_base", () => {
	const temp = makeTemp("tmp-base-probe-");
	try {
		assert.equal(path.dirname(temp), testTmpDir);
	} finally {
		removeTree(temp);
	}
});

await test("test_npm_test_without_repository_temp_directory", () => {
	assert.notEqual(path.resolve(os.tmpdir()), path.join(root, ".astron-logs"));
});

await test("test_npm_test_with_bbm_test_tmpdir", () => {
	assert.equal(testTmpDir, path.resolve(process.env.BBM_TEST_TMPDIR ?? os.tmpdir()));
	assert.equal(fs.existsSync(testTmpDir), true);
});

await test("test_ontology_requires_unique_ids_and_resolved_graph_refs", () => {
	const source = fs.readFileSync(path.join(root, "ontology", "ontology.yaml"), "utf8");
	const parsed = parseOntology(source);
	const duplicate = source.replace("role:plan", "role:research");
	assert.throws(() => parseOntology(duplicate), /duplicate/i);
	assert.ok(parsed.rules.length > 0);
});

await test("test_ontology_rejects_unsafe_yaml_and_unknown_shape", () => {
	assert.throws(() => parseOntology("version: 1\nunknown: true\n"));
	assert.throws(() => parseOntology("version: 1\nversion: 2\n"), /duplicate/i);
	assert.throws(() => parseOntology("version: !!js/function 'x'\n"));
	assert.throws(() => parseOntology("version: 1\nbase: &base {x: 1}\ncopy: {<<: *base}\n"), /merge/i);
	assert.throws(() => parseOntology(`version: 1\n${"x: {".repeat(70)}x: 1${"}".repeat(70)}\n`), /depth/i);
});

await test("test_ontology_schema_rejects_owner_exception_missing_required_fields", () => {
	const ontology = JSON.parse(fs.readFileSync(path.join(root, "ontology", "ontology.json"), "utf8"));
	const complete = { "@id": "constraint:test-owner-exception", kind: "owner-exception", rule: ontology.rules[0]["@id"], approvedBy: "p1", approvedAt: "2026-10-19", link: "https://example.test/approval" };
	const accepted = structuredClone(ontology);
	accepted.constraints.push(complete);
	assert.doesNotThrow(() => ontologySchema.parse(accepted));
	for (const field of ["rule", "approvedBy", "approvedAt", "link"]) {
		const candidate = structuredClone(ontology);
		const incomplete = { ...complete };
		delete incomplete[field];
		candidate.constraints.push(incomplete);
		assert.throws(() => ontologySchema.parse(candidate), field);
	}
});

await test("test_ontology_schema_rejects_invalid_owner_exception_metadata", () => {
	const ontology = JSON.parse(fs.readFileSync(path.join(root, "ontology", "ontology.json"), "utf8"));
	const complete = { "@id": "constraint:test-owner-exception", kind: "owner-exception", rule: ontology.rules[0]["@id"], approvedBy: "p1", approvedAt: "2026-10-19", link: "https://example.test/approval" };
	const accepted = structuredClone(ontology);
	accepted.constraints.push(complete);
	assert.doesNotThrow(() => ontologySchema.parse(accepted));
	for (const invalid of [
		{ approvedBy: "p2" },
		{ approvedBy: "" },
		{ approvedAt: "2026-13-40" },
		{ approvedAt: "" },
		{ link: "not-a-url" },
		{ link: "" },
	]) {
		const candidate = structuredClone(ontology);
		candidate.constraints.push({ ...complete, ...invalid });
		assert.throws(() => ontologySchema.parse(candidate));
	}
});

await test("test_ontology_schema_rejects_owner_exception_for_unknown_rule", () => {
	const ontology = JSON.parse(fs.readFileSync(path.join(root, "ontology", "ontology.json"), "utf8"));
	ontology.constraints.push({ "@id": "constraint:test-owner-exception", kind: "owner-exception", rule: "rule:missing", approvedBy: "p1", approvedAt: "2026-10-19", link: "https://example.test/approval" });
	assert.throws(() => ontologySchema.parse(ontology), /rule:missing/);
});

await test("test_repository_ontology_contains_no_owner_exceptions", () => {
	const source = fs.readFileSync(path.join(root, "ontology", "ontology.yaml"), "utf8");
	const fromYaml = yaml.load(source);
	const fromJson = JSON.parse(fs.readFileSync(path.join(root, "ontology", "ontology.json"), "utf8"));
	assert.equal(fromYaml.constraints.filter((constraint) => constraint.kind === "owner-exception").length, 0);
	assert.equal(fromJson.constraints.filter((constraint) => constraint.kind === "owner-exception").length, 0);
});

await test("test_official_doc_fixtures_are_versioned_and_attributed", () => {
	for (const name of ["models-overview.md", "prompt-caching.md", "effort.md", "features.md"]) {
		const text = fs.readFileSync(path.join(fixtures, name), "utf8");
		assert.match(text, /^Source-URL: https:\/\//);
		assert.match(text, /^Checked-At: 2026-10-19/m);
	}
});

await test("test_official_doc_fixtures_remain_minimal", () => {
	const files = fs.readdirSync(fixtures);
	assert.equal(files.length, 4);
	assert.ok(files.every((name) => fs.statSync(path.join(fixtures, name)).size < 3000));
});

await test("test_collector_extracts_offline_model_catalog", () => {
	const models = collectOfficialModels(fixtures, root);
	assert.deepEqual(models.map((model) => model.id), ["claude-fable-5-1", "claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
	assert.equal(models.find((model) => model.id === "claude-opus-5-5")?.contextTokens, 1000000);
	assert.equal(models.find((model) => model.id === "claude-opus-5-5")?.maxOutputTokens, 128000);
	assert.equal(models.find((model) => model.id === "claude-opus-5-5")?.defaultEffort, "medium");
	assert.ok(models.every((model) => model.features.includes("tools")));
});

await test("test_collector_preserves_haiku_price_tiers", () => {
	const haiku = collectOfficialModels(fixtures, root).find((model) => model.id === "claude-haiku-5-5");
	assert.deepEqual(haiku?.pricing.map((tier) => tier.promptTokens), [100000, null]);
	assert.deepEqual(haiku?.pricing.map((tier) => tier.input), [0.1, 0.5]);
});

await test("test_diff_added_model_uses_current_source_and_serializes_all_fields", () => {
	const added = structuredClone(collectOfficialModels(fixtures, root)[0]);
	added.sources = [{ url: "https://example.test/current", checkedAt: "2026-10-19", fields: ["id"] }];
	const diffs = diffOfficialModels([], [added]);
	assert.ok(diffs.length > 0);
	for (const diff of diffs) {
		assert.equal(diff.sourceUrl, "https://example.test/current");
		assert.equal(diff.checkedAt, "2026-10-19");
		assert.equal(diff.previous, null);
		assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(diff))), ["path", "kind", "previous", "current", "sourceUrl", "checkedAt"]);
	}
});

await test("test_diff_removed_middle_model_uses_previous_source_and_serializes_all_fields", () => {
	const previous = structuredClone(collectOfficialModels(fixtures, root));
	const removed = previous[1];
	removed.sources = [{ url: "https://example.test/previous-middle", checkedAt: "2026-10-18", fields: ["id"] }];
	const current = previous.filter((model) => model.id !== removed.id);
	const diffs = diffOfficialModels(previous, current).filter((diff) => diff.path.startsWith(`${removed.id}.`));
	assert.ok(diffs.length > 0);
	for (const diff of diffs) {
		assert.equal(diff.sourceUrl, "https://example.test/previous-middle");
		assert.equal(diff.checkedAt, "2026-10-18");
		assert.equal(diff.current, null);
		assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(diff))), ["path", "kind", "previous", "current", "sourceUrl", "checkedAt"]);
	}
});

await test("test_diff_removed_last_model_uses_previous_source_and_serializes_all_fields", () => {
	const removed = structuredClone(collectOfficialModels(fixtures, root)[0]);
	removed.sources = [{ url: "https://example.test/previous-last", checkedAt: "2026-10-17", fields: ["id"] }];
	const diffs = diffOfficialModels([removed], []);
	assert.ok(diffs.length > 0);
	for (const diff of diffs) {
		assert.equal(diff.sourceUrl, "https://example.test/previous-last");
		assert.equal(diff.checkedAt, "2026-10-17");
		assert.equal(diff.current, null);
		assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(diff))), ["path", "kind", "previous", "current", "sourceUrl", "checkedAt"]);
	}
});

await test("test_collector_reports_sorted_field_diffs", () => {
	const current = collectOfficialModels(fixtures, root);
	const previous = structuredClone(current);
	previous[0].contextTokens = 200000;
	previous.pop();
	const diffs = diffOfficialModels(previous, current);
	assert.deepEqual(diffs.map((diff) => diff.path), [...diffs.map((diff) => diff.path)].sort());
	assert.ok(diffs.some((diff) => diff.kind === "changed" && diff.previous === 200000 && diff.current === 1000000));
	assert.ok(diffs.every((diff) => diff.sourceUrl.startsWith("https://") && diff.checkedAt === "2026-10-19"));
});

await test("test_collector_rejects_missing_or_malformed_sources_without_overwrite", () => {
	const temp = makeTemp("bbm-docs-");
	const target = path.join(temp, "ontology.yaml");
	try {
		fs.writeFileSync(target, "sentinel", "utf8");
		const result = spawnSync(process.execPath, [path.join(root, "scripts", "collect-model-docs.mjs"), "--docs-dir", temp, "--write", "--ontology", target, "--checked-at", "2026-10-19"], { cwd: root });
		assert.notEqual(result.status, 0);
		assert.equal(fs.readFileSync(target, "utf8"), "sentinel");
	} finally {
		removeTree(temp);
	}
});

await test("test_collector_records_source_url_and_checked_date", () => {
	const models = collectOfficialModels(fixtures, root);
	assert.ok(models.every((model) => model.sources.every((source) => source.url.startsWith("https://") && source.checkedAt === "2026-10-19" && source.fields.length > 0)));
});

await test("test_collector_does_not_copy_unrecognized_document_text", () => {
	const temp = makeTemp("docs-");
	try {
		for (const name of fs.readdirSync(fixtures)) fs.copyFileSync(path.join(fixtures, name), path.join(temp, name));
		fs.appendFileSync(path.join(temp, "features.md"), "\nUNRECOGNIZED TOKEN-LIKE-ABCDEFGHIJKLMNOPQRSTUV\n");
		assert.doesNotMatch(JSON.stringify(collectOfficialModels(temp, temp)), /UNRECOGNIZED|TOKEN-LIKE/);
	} finally {
		removeTree(temp);
	}
});

await test("test_collector_rejects_docs_directory_outside_workspace", () => {
	assert.throws(() => collectOfficialModels(path.resolve(root, ".."), root), /workspace/i);
});

await test("test_collector_and_recommend_use_no_network_or_auth", () => {
	const source = ["src/model-docs.ts", "src/recommender.ts"].map((name) => fs.readFileSync(path.join(root, name), "utf8")).join("\n");
	assert.doesNotMatch(source, /fetch\(|node:https|node:http|authorization|api[_-]?key|process\.env/i);
});

await test("test_cache_build_is_atomic_and_removes_temp_files", async () => {
	const before = fs.readFileSync(path.join(root, "ontology", "ontology.json"), "utf8");
	const builds = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve) => {
		const child = spawn(process.execPath, [path.join(root, "scripts", "build-ontology.mjs")], { cwd: root, stdio: "ignore" });
		child.once("exit", (code) => resolve(code));
	})));
	assert.ok(builds.every((code) => code === 0));
	assert.equal(fs.readFileSync(path.join(root, "ontology", "ontology.json"), "utf8"), before);
	assert.equal(fs.readdirSync(path.join(root, "ontology")).filter((name) => name.includes(".tmp-")).length, 0);
	const temp = makeTemp("cache-failure-");
	try {
		const source = path.join(temp, "bad.yaml");
		const target = path.join(temp, "ontology.json");
		fs.writeFileSync(source, "version: 1\nunknown: true\n", "utf8");
		fs.writeFileSync(target, before, "utf8");
		assert.throws(() => buildOntologyCache({ source, target }));
		assert.equal(fs.readFileSync(target, "utf8"), before);
		assert.equal(fs.readdirSync(temp).filter((name) => name.includes(".tmp-")).length, 0);
	} finally {
		removeTree(temp);
	}
});

const built = yaml.load(fs.readFileSync(path.join(root, "ontology", "ontology.yaml"), "utf8"));
assert.ok(built);
if (failures > 0) process.exit(1);
