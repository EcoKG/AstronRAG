import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ontologySchema, parseOntology } from "../dist/ontology.js";
import { recommendModel } from "../dist/recommender.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testTmpDir = path.resolve(process.env.BBM_TEST_TMPDIR ?? os.tmpdir());
fs.mkdirSync(testTmpDir, { recursive: true });
const tempRoot = fs.mkdtempSync(path.join(testTmpDir, "bbm-recommend-"));
const tempVault = path.join(tempRoot, "vault");
const ontologyPath = path.join(tempRoot, "ontology.json");
const repositoryOntologyPath = path.join(root, "ontology", "ontology.json");
const snapshotsPath = path.join(root, "test", "fixtures", "recommend-output-snapshots.json");
const repositoryOntologyBefore = fs.readFileSync(repositoryOntologyPath, "utf8");
fs.mkdirSync(tempVault);
fs.copyFileSync(repositoryOntologyPath, ontologyPath);
let client;
let failures = 0;

async function test(name, fn) {
	try {
		await fn();
		console.log(`PASS ${name}`);
	} catch (error) {
		failures++;
		console.error(`FAIL ${name}: ${error instanceof Error ? error.stack : error}`);
	}
}

function payload(result) {
	return JSON.parse(result.content[0].text);
}

function addOwnerExceptionEvidence(ontology) {
	const id = "evidence:owner-exception";
	ontology.evidence.push({ "@id": id, label: "Owner-approved test exception", link: "https://example.test/owner-exception" });
	return id;
}

function addOwnerException(ontology, rule) {
	ontology.constraints.push({ "@id": `constraint:test-owner-exception:${rule}`, kind: "owner-exception", rule, approvedBy: "p1", approvedAt: "2026-10-19", link: "https://example.test/owner-exception" });
}

async function call(description, role, ...platforms) {
	const [platform] = platforms;
	return client.callTool({ name: "recommend", arguments: { description, role, ...(platform === undefined ? {} : { platform }) } });
}

async function withOntology(update, action) {
	const original = fs.readFileSync(ontologyPath, "utf8");
	const ontology = JSON.parse(original);
	update(ontology);
	fs.writeFileSync(ontologyPath, `${JSON.stringify(ontology, null, 2)}\n`, "utf8");
	try {
		return await action();
	} finally {
		fs.writeFileSync(ontologyPath, original, "utf8");
	}
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

try {
	client = new Client({ name: "regress-recommend", version: "0.0.1" });
	await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist", "index.js")], cwd: root, env: { ...process.env, BIGBRAIN_VAULT: tempVault, BBM_ONTOLOGY_PATH: ontologyPath } }));
	const before = fs.readdirSync(tempVault).sort();

	await test("test_recommend_temp_directory_uses_selected_base", () => {
		assert.equal(path.dirname(tempRoot), testTmpDir);
	});

	await test("test_recommend_uses_injected_ontology_copy", async () => {
		await withOntology((ontology) => {
			const fallback = ontology.rules.find((rule) => rule.conditions.length === 0 && (rule.platform ?? "claude") === "claude");
			fallback.reason = "INJECTED_ONTOLOGY_COPY";
		}, async () => {
			assert.ok(payload(await call("ordinary task", "impl")).reasons.includes("INJECTED_ONTOLOGY_COPY"));
		});
	});

	await test("test_recommend_uses_default_ontology_when_override_is_empty", async () => {
		const defaultClient = new Client({ name: "regress-recommend-default", version: "0.0.1" });
		try {
			await defaultClient.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist", "index.js")], cwd: root, env: { ...process.env, BIGBRAIN_VAULT: tempVault, BBM_ONTOLOGY_PATH: "" } }));
			const result = await defaultClient.callTool({ name: "recommend", arguments: { description: "ordinary task", role: "impl" } });
			assert.equal(payload(result).model, "claude-opus-5-5");
		} finally {
			await defaultClient.close();
		}
	});

	await test("test_recommend_accepts_valid_description_and_role", async () => {
		const result = payload(await call("Implement a small Claude feature", "impl"));
		assert.equal(result.model, "claude-opus-5-5");
		assert.equal(result.effort, "medium");
		assert.ok(result.reasons.length > 0);
	});

	await test("test_recommend_treats_special_characters_as_text", async () => {
		const result = payload(await call("따옴표 ' \" 😀 \\ ../ \\0 를 텍스트로 분류", "research"));
		assert.equal(result.model, "claude-opus-5-5");
		assert.equal(payload(await call("따옴표 ' \" \\ \u0000\n", "research", "codex")).model, "gpt-6.1-sol");
	});

	await test("test_recommend_rejects_blank_description", async () => {
		assert.equal((await call("   ", "impl")).isError, true);
		for (const description of ["", "   "]) assert.equal((await call(description, "impl", "codex")).isError, true);
	});

	await test("test_recommend_rejects_unknown_role", async () => {
		assert.equal((await call("valid", "")).isError, true);
		assert.equal((await call("valid", "unknown")).isError, true);
	});

	await test("test_recommend_enforces_description_length_boundary", async () => {
		assert.equal(payload(await call("x".repeat(4000), "impl")).model, "claude-opus-5-5");
		assert.equal((await call("x".repeat(4001), "impl")).isError, true);
		assert.equal(payload(await call("x".repeat(4000), "impl", "codex")).model, "gpt-6.1-sol");
		assert.equal((await call("x".repeat(4001), "impl", "codex")).isError, true);
	});

	await test("test_recommend_filters_constraints_before_candidate_limit", async () => {
		await withOntology((ontology) => {
			const rule = ontology.rules.find((item) => item.platform === "codex");
			assert.ok(rule);
			ontology.rules.push(...Array.from({ length: 8 }, (_, index) => ({ ...rule, "@id": `rule:excluded-${index}`, conditions: [], model: "gpt-6-astra", confidence: 1, priority: 999 })));
		}, async () => {
			assert.deepEqual(payload(await call("ordinary task", "ops", "codex")).candidates, [{ model: "gpt-6.1-sol", effort: "medium" }]);
		});
		await withOntology((ontology) => {
			ontology.rules = [
				{ "@id": "rule:test-fable", priority: 999, conditions: [{ type: "role", values: ["impl"] }], model: "claude-fable-5-1", effort: "high", reason: "test forbidden rule", evidence: ["evidence:official-models"], confidence: 1 },
				{ "@id": "rule:test-sonnet-after-filter", priority: 100, conditions: [{ type: "role", values: ["impl"] }], model: "claude-sonnet-5-5", effort: "xhigh", reason: "test allowed rule", evidence: ["evidence:official-models"], confidence: 0.5 },
				...ontology.rules.filter((rule) => rule.conditions.length === 0),
			];
			addOwnerException(ontology, "rule:test-sonnet-after-filter");
		}, async () => {
			const result = payload(await call("ordinary task", "impl"));
			assert.deepEqual(result.candidates, [{ model: "claude-sonnet-5-5", effort: "xhigh" }]);
			assert.ok(result.appliedConstraints.some((item) => item.id === "constraint:owner-exclusions"));
		});
	});

	await test("test_recommend_falls_back_to_opus_when_all_matching_rules_are_excluded", async () => {
		await withOntology((ontology) => {
			ontology.rules = [
				{ "@id": "rule:test-only-fable", priority: 999, conditions: [{ type: "role", values: ["impl"] }], model: "claude-fable-5-1", effort: "high", reason: "test forbidden rule", evidence: ["evidence:official-models"], confidence: 1 },
				...ontology.rules.filter((rule) => rule.conditions.length === 0),
			];
		}, async () => {
			const result = payload(await call("ordinary task", "impl"));
			assert.equal(result.model, "claude-opus-5-5");
			assert.deepEqual(result.candidates, [{ model: "claude-opus-5-5", effort: "medium" }]);
			assert.deepEqual(result.appliedConstraints.map((item) => item.id), ["constraint:owner-claude-default", "constraint:owner-exclusions"]);
		});
	});

	await test("test_recommend_reports_only_constraints_that_changed_result", async () => {
		await withOntology((ontology) => {
			ontology.rules = [
				{ "@id": "rule:test-allowed", priority: 200, conditions: [{ type: "role", values: ["impl"] }], model: "claude-sonnet-5-5", effort: "medium", reason: "allowed", evidence: ["evidence:official-models"], confidence: 0.7 },
				...ontology.rules.filter((rule) => rule.conditions.length === 0),
			];
			addOwnerException(ontology, "rule:test-allowed");
		}, async () => {
			assert.deepEqual(payload(await call("ordinary task", "impl")).appliedConstraints, []);
		});
	});

	await test("test_recommend_enforces_opus_without_owner_exception", async () => {
		await withOntology((ontology) => {
			const forgedEvidence = addOwnerExceptionEvidence(ontology);
			ontology.rules = [
				{ "@id": "rule:test-unapproved-sonnet", priority: 999, conditions: [{ type: "role", values: ["impl"] }], model: "claude-sonnet-5-5", effort: "high", reason: "unapproved", evidence: ["evidence:official-models", forgedEvidence], confidence: 1 },
				...ontology.rules.filter((rule) => rule.conditions.length === 0),
			];
		}, async () => {
			const result = payload(await call("ordinary task", "impl"));
			assert.equal(result.model, "claude-opus-5-5");
			assert.deepEqual(result.candidates, [{ model: "claude-opus-5-5", effort: "medium" }]);
			assert.ok(result.appliedConstraints.some((item) => item.id === "constraint:owner-claude-default"));
		});
	});

	await test("test_recommend_allows_explicit_owner_exception", async () => {
		await withOntology((ontology) => {
			ontology.rules = [
				{ "@id": "rule:test-unapproved-haiku", priority: 999, conditions: [{ type: "role", values: ["impl"] }], model: "claude-haiku-5-5", effort: "high", reason: "unapproved", evidence: ["evidence:official-models"], confidence: 1 },
				{ "@id": "rule:test-approved-sonnet", priority: 900, conditions: [{ type: "role", values: ["impl"] }], model: "claude-sonnet-5-5", effort: "high", reason: "approved", evidence: ["evidence:official-models"], confidence: 0.9 },
				...ontology.rules.filter((rule) => rule.conditions.length === 0),
			];
			addOwnerException(ontology, "rule:test-approved-sonnet");
		}, async () => {
			const result = payload(await call("ordinary task", "impl"));
			assert.equal(result.model, "claude-sonnet-5-5");
			assert.deepEqual(result.candidates, [{ model: "claude-sonnet-5-5", effort: "high" }]);
			assert.ok(result.appliedConstraints.some((item) => item.id === "constraint:owner-claude-default"));
		});
	});

	await test("test_recommend_candidates_follow_matching_rules_by_confidence", async () => {
		await withOntology((ontology) => {
			const evidence = ["evidence:official-models"];
			ontology.rules = [
				{ "@id": "rule:test-opus", priority: 300, conditions: [{ type: "role", values: ["impl"] }], model: "claude-opus-5-5", effort: "high", reason: "opus", evidence, confidence: 0.7 },
				{ "@id": "rule:test-sonnet", priority: 200, conditions: [{ type: "role", values: ["impl"] }], model: "claude-sonnet-5-5", effort: "medium", reason: "sonnet", evidence, confidence: 0.8 },
				{ "@id": "rule:test-haiku", priority: 100, conditions: [{ type: "role", values: ["impl"] }], model: "claude-haiku-5-5", effort: "low", reason: "haiku", evidence, confidence: 0.9 },
				{ "@id": "rule:test-unmatched", priority: 999, conditions: [{ type: "role", values: ["review"] }], model: "claude-haiku-5-5", effort: "high", reason: "unmatched", evidence, confidence: 1 },
			];
			addOwnerException(ontology, "rule:test-sonnet");
			addOwnerException(ontology, "rule:test-haiku");
			addOwnerException(ontology, "rule:test-unmatched");
		}, async () => {
			const result = payload(await call("ordinary task", "impl"));
			assert.deepEqual(result.candidates.map((candidate) => candidate.model), ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
			assert.equal(result.model, "claude-opus-5-5");
		});
	});

	await test("test_recommend_returns_single_candidate_for_single_matching_rule", async () => {
		await withOntology((ontology) => {
			ontology.rules = [
				{ "@id": "rule:test-only", priority: 200, conditions: [{ type: "role", values: ["impl"] }], model: "claude-sonnet-5-5", effort: "medium", reason: "only", evidence: ["evidence:official-models"], confidence: 0.8 },
				...ontology.rules.filter((rule) => rule.conditions.length === 0),
			];
			addOwnerException(ontology, "rule:test-only");
		}, async () => {
			assert.deepEqual(payload(await call("ordinary task", "impl")).candidates, [{ model: "claude-sonnet-5-5", effort: "medium" }]);
		});
	});

	await test("test_recommend_defaults_claude_work_to_opus", async () => {
		const result = payload(await call("Write a Claude task", "impl"));
		assert.deepEqual([result.model, result.effort], ["claude-opus-5-5", "medium"]);
		assert.ok(result.appliedConstraints.some((item) => /default/i.test(item.reason)));
	});

	await test("test_recommend_excludes_forbidden_models_everywhere", async () => {
		const result = payload(await call("complex agent work", "plan"));
		assert.doesNotMatch(result.model, /gpt-6-astra|claude-fable-5-1/);
		assert.ok(result.candidates.every((candidate) => !/gpt-6-astra|claude-fable-5-1/.test(candidate.model)));
	});

	await test("test_recommend_returns_evidence_links_and_constraint_reason", async () => {
		const result = payload(await call("ordinary task", "impl"));
		assert.ok(result.evidence.some((link) => link.startsWith("https://") || !path.isAbsolute(link)));
		assert.ok(result.appliedConstraints.length > 0 && result.reasons.length > 0);
	});

	await test("test_recommend_evidence_links_resolve_to_committed_sources", () => {
		const ontology = JSON.parse(fs.readFileSync(ontologyPath, "utf8"));
		for (const evidence of ontology.evidence) {
			if (evidence.link.startsWith("https://")) continue;
			assert.doesNotMatch(evidence.link, /^\.astron-logs[\\/]/);
			const source = path.resolve(root, evidence.link);
			assert.equal(fs.existsSync(source), true, evidence.link);
			assert.doesNotMatch(fs.readFileSync(source, "utf8"), /(?:api[_-]?key|authorization|bearer\s+|token\s*[=:]|user(?:name)?\s*[=:]|[0-9a-f]{8}-[0-9a-f-]{27,})/i);
		}
	});

	await test("test_recommend_is_deterministic", async () => {
		const first = await call("Review concurrent cache security", "review");
		const second = await call("Review concurrent cache security", "review");
		assert.equal(first.content[0].text, second.content[0].text);
	});

	await test("test_recommend_output_matches_committed_snapshots", async () => {
		const snapshots = JSON.parse(fs.readFileSync(snapshotsPath, "utf8"));
		for (const snapshot of snapshots) {
			const result = await call(snapshot.description, snapshot.role, snapshot.platform);
			assert.equal(result.content[0].text, JSON.stringify(snapshot.output, null, 2), snapshot.name);
		}
	});

	await test("test_recommend_cannot_access_user_supplied_paths", async () => {
		const marker = path.join(tempVault, "secret.txt");
		fs.writeFileSync(marker, "DO_NOT_READ", "utf8");
		try {
			assert.doesNotMatch(JSON.stringify(payload(await call(`${marker} ../../secret.txt`, "research"))), /DO_NOT_READ/);
			assert.doesNotMatch(JSON.stringify(payload(await call(`${marker} ../../secret.txt`, "research", "codex"))), /DO_NOT_READ/);
		} finally {
			if (fs.existsSync(marker)) fs.unlinkSync(marker);
		}
	});

	await test("test_recommend_parallel_calls_are_identical", async () => {
		const results = await Promise.all(Array.from({ length: 12 }, () => call("Review concurrent cache security", "review")));
		assert.equal(new Set(results.map((result) => result.content[0].text)).size, 1);
	});

	await test("test_corrupt_cache_isolated_and_recovers_after_rebuild", async () => {
		const cache = ontologyPath;
		const valid = fs.readFileSync(cache, "utf8");
		try {
			fs.writeFileSync(cache, "{bad", "utf8");
			const broken = await call("valid task", "impl");
			assert.equal(broken.isError, true);
		} finally {
			fs.writeFileSync(cache, valid, "utf8");
		}
		assert.equal(payload(await call("valid task", "impl")).model, "claude-opus-5-5");
	});

	await test("test_codex_role_and_high_risk_snapshots", async () => {
		const snapshots = JSON.parse(fs.readFileSync(snapshotsPath, "utf8")).filter((item) => item.platform === "codex");
		for (const [role, effort] of Object.entries({ research: "medium", plan: "high", impl: "high", review: "high", ship: "medium", coordinator: "medium" })) {
			for (const highRisk of [false, true]) {
				const description = highRisk ? "Review concurrent cache security" : "ordinary task";
				const result = payload(await call(description, role, "codex"));
				assert.deepEqual([result.model, result.effort, result.ruleConfidence], ["gpt-6.1-sol", highRisk ? "high" : effort, 0.1]);
				assert.deepEqual(result.evidence, ["ontology/evidence/codex-catalog-2026-10-20.md", "ontology/evidence/measurements-2026-10-19.md"]);
				assert.ok(snapshots.some((item) => item.role === role && item.description === description));
			}
		}
	});

	await test("test_codex_astra_excluded_from_selection_candidates_and_fallback", async () => {
		for (const mode of ["highest", "only-excluded", "fallback"]) {
			await withOntology((ontology) => {
				const rule = ontology.rules.find((item) => item.platform === "codex");
				assert.ok(rule);
				if (mode !== "highest") ontology.rules = ontology.rules.filter((item) => item.platform !== "codex" || item.conditions.length === 0);
				ontology.rules.push({ ...rule, "@id": "rule:test-astra", model: "gpt-6-astra", conditions: mode === "fallback" ? [] : [{ type: "role", values: ["impl"] }], priority: 9999, confidence: 1 });
			}, async () => {
				const result = payload(await call("ordinary task", "impl", "codex"));
				assert.equal(result.model, "gpt-6.1-sol");
				assert.ok(result.candidates.every((item) => item.model !== "gpt-6-astra"));
			});
		}
	});

	await test("test_codex_ignores_claude_default_constraint", async () => {
		const codex = payload(await call("ordinary task", "impl", "codex"));
		assert.equal(codex.model, "gpt-6.1-sol");
		assert.ok(codex.appliedConstraints.every((item) => item.id !== "constraint:owner-claude-default"));
		const claude = payload(await call("ordinary task", "impl", "claude"));
		assert.equal(claude.model, "claude-opus-5-5");
		assert.ok(claude.candidates.every((item) => item.model.startsWith("claude-")));
	});

	await test("test_recommend_rejects_invalid_platform_and_codex_rules", async () => {
		for (const platform of ["unknown", "", "platform:codex"]) assert.equal((await call("ordinary task", "impl", platform)).isError, true);
		const valid = JSON.parse(fs.readFileSync(ontologyPath, "utf8"));
		assert.throws(() => recommendModel(valid, "ordinary task", "impl", "unknown"), /platform/);
		const mutations = [
			(ontology) => { ontology.rules.find((item) => item.platform === "codex").platform = "unknown"; },
			(ontology) => { ontology.rules.find((item) => item.platform === "codex").model = "claude-opus-5-5"; },
			(ontology) => { ontology.rules[0].model = "unregistered"; },
			(ontology) => { ontology.rules[0].evidence = ["evidence:missing"]; },
			(ontology) => { ontology.rules.find((item) => item.platform === "codex").model = "gpt-6-luna"; ontology.rules.find((item) => item.platform === "codex").effort = "ultra"; },
			(ontology) => { ontology.rules[0].conditions = [{ type: "role", values: ["unknown"] }]; },
			(ontology) => { ontology.models.find((item) => item.id === "gpt-6.1-sol").platforms = ["platform:missing"]; },
			(ontology) => { ontology.constraints.find((item) => item.kind === "default").platform = "unknown"; },
		];
		for (const mutate of mutations) {
			const invalid = structuredClone(valid);
			mutate(invalid);
			assert.throws(() => ontologySchema.parse(invalid));
			assert.throws(() => parseOntology(JSON.stringify(invalid)));
			await withOntology(mutate, async () => assert.equal((await call("ordinary task", "impl", "codex")).isError, true));
		}
	});

	await test("test_codex_catalog_omits_unverified_fields_without_weakening_claude", () => {
		const ontology = JSON.parse(fs.readFileSync(ontologyPath, "utf8"));
		const expected = { "gpt-6.1-sol": [500000, "low", "ultra"], "gpt-6-astra": [272000, "medium", "ultra"], "gpt-6-sol": [272000, "medium", "ultra"], "gpt-6-luna": [272000, "medium", "max"], "gpt-5.6-sol": [272000, "low", "ultra"] };
		assert.equal(ontology.models.filter((item) => item.platforms.includes("platform:codex")).length, 5);
		for (const [slug, [contextTokens, defaultEffort, maximumEffort]] of Object.entries(expected)) {
			const model = ontology.models.find((item) => item.id === slug);
			assert.deepEqual([model.contextTokens, model.defaultEffort], [contextTokens, defaultEffort]);
			assert.deepEqual([...model.features].sort(), ["image", "text"]);
			assert.deepEqual([...model.supportedEfforts].sort(), ["low", "medium", "high", "xhigh", "max", ...(maximumEffort === "ultra" ? ["ultra"] : [])].sort());
			for (const field of ["pricing", "maxOutputTokens", "sources"]) assert.equal(Object.prototype.hasOwnProperty.call(model, field), false);
		}
		for (const field of ["pricing", "maxOutputTokens", "sources"]) {
			const invalid = structuredClone(ontology);
			delete invalid.models.find((item) => item.id === "claude-opus-5-5")[field];
			assert.throws(() => ontologySchema.parse(invalid));
			assert.throws(() => parseOntology(JSON.stringify(invalid)));
		}
	});

	await test("test_codex_ops_uses_medium_fallback_and_high_risk_override", async () => {
		for (const [description, effort] of [["ordinary task", "medium"], ["security", "high"]]) {
			const result = payload(await call(description, "ops", "codex"));
			assert.deepEqual([result.model, result.effort, result.ruleConfidence], ["gpt-6.1-sol", effort, 0.1]);
		}
	});

	await test("test_codex_recommendation_remains_isolated_and_deterministic", async () => {
		const results = await Promise.all(Array.from({ length: 12 }, () => call("Review concurrent cache security", "review", "codex")));
		assert.equal(new Set(results.map((result) => result.content[0].text)).size, 1);
		assert.equal(payload(results[0]).model, "gpt-6.1-sol");
		const valid = fs.readFileSync(ontologyPath, "utf8");
		try {
			fs.writeFileSync(ontologyPath, "{bad", "utf8");
			assert.equal((await call("ordinary task", "impl", "codex")).isError, true);
		} finally {
			fs.writeFileSync(ontologyPath, valid, "utf8");
		}
		assert.equal(payload(await call("ordinary task", "impl", "codex")).model, "gpt-6.1-sol");
	});

	await test("test_repository_ontology_hash_unchanged_by_npm_test", () => {
		assert.equal(fs.readFileSync(repositoryOntologyPath, "utf8"), repositoryOntologyBefore);
	});

	await test("test_temp_vault_file_count_unchanged_by_recommend", () => {
		assert.deepEqual(fs.readdirSync(tempVault).sort(), before);
	});
} finally {
	if (client) await client.close();
	removeTree(tempRoot);
}

if (failures > 0) process.exit(1);
