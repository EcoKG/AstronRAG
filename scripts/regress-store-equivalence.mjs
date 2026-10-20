import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runMigration } from "./migrate-vault-to-store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "eval", "fixture-vault");
const goldenPath = path.join(root, "eval", "golden.jsonl");
const tempRoot = fs.mkdtempSync(path.join(process.env.ASTRONRAG_TEST_TMPDIR || os.tmpdir(), "bbm-equivalence-"));
const frozenNow = Date.parse("2026-07-01T00:00:00.000Z");
export const NORMALIZED_FIELDS = [];

process.env.ASTRONRAG_FLUSH_EVERY_ACCESS = "1";
const distUrl = (relative) => pathToFileURL(path.join(root, "dist", relative)).href;
const { FileStore } = await import(distUrl("stores/file-store.js"));
const { SqliteStore } = await import(distUrl("stores/sqlite-store.js"));
const { MemoryStore } = await import(distUrl("store.js"));

let failed = 0;
const test = (name, run) => {
	try { run(); console.log(`ok ${name}`); }
	catch (error) { failed++; console.error(`not ok ${name}: ${error instanceof Error ? error.message : String(error)}`); }
};
const hash = (fp) => crypto.createHash("sha256").update(fs.readFileSync(fp)).digest("hex");

function copyFixture(name, source = fixture) {
	const dir = path.join(tempRoot, name);
	fs.cpSync(source, dir, { recursive: true });
	return dir;
}

function migrate(name, source) {
	const db = path.join(tempRoot, `${name}.sqlite`);
	runMigration({ vault: source, storePath: db, backupPath: path.join(tempRoot, `${name}-backup`), dryRun: false, merge: false, verify: false });
	return db;
}

function serialize(outcome) {
	return JSON.stringify({
		totalMatched: outcome.totalMatched,
		results: outcome.results.map((item) => ({
			slug: item.record.slug,
			score: item.score,
			activation: item.activation,
			inhibited: item.inhibited ?? false,
			inhibitedBy: item.inhibitedBy ?? null,
			associations: item.snippet.startsWith("(연상"),
			age_days: Math.max(0, Math.floor((frozenNow - Date.parse(item.record.updated)) / 86_400_000)),
		})),
	});
}

function pair(name, input = fixture) {
	const source = copyFixture(`${name}-source`, input);
	const sqliteSource = copyFixture(`${name}-sqlite`, source);
	const db = migrate(name, sqliteSource);
	if (name.startsWith("operational") && process.env.ASTRONRAG_TEST_EQUIVALENCE_CORRUPT_SQLITE === "1") {
		const corrupt = new DatabaseSync(db);
		corrupt.exec("DELETE FROM memories WHERE slug = (SELECT slug FROM memories ORDER BY slug LIMIT 1)");
		corrupt.close();
	}
	const fileBackend = new FileStore(source);
	const sqliteBackend = new SqliteStore(sqliteSource, db);
	return {
		fileBackend,
		sqliteBackend,
		file: new MemoryStore(fileBackend, undefined, () => frozenNow),
		sqlite: new MemoryStore(sqliteBackend, undefined, () => frozenNow),
		close: () => { fileBackend.close(); sqliteBackend.close(); },
	};
}

function treeFingerprint(rootPath) {
	const rows = [""];
	rows.length = 0;
	/** @param {string} relative */
	const walk = (relative = "") => {
		for (const entry of fs.readdirSync(path.join(rootPath, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const child = path.join(relative, entry.name);
			if (entry.isDirectory()) walk(child);
			else if (entry.isFile()) rows.push(`${child.replace(/\\/g, "/")}\u0000${hash(path.join(rootPath, child))}`);
		}
	};
	walk();
	return rows;
}

test("test_store_equivalence_matches_all_eval_queries_byte_for_byte", () => {
	const stores = pair("golden");
	try {
		const rows = fs.readFileSync(goldenPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
		for (const row of rows) {
			const left = Buffer.from(serialize(stores.file.searchDetailed(row.query, { limit: 5 })));
			const right = Buffer.from(serialize(stores.sqlite.searchDetailed(row.query, { limit: 5 })));
			assert.equal(left.equals(right), true, row.query);
		}
	} finally { stores.close(); }
});

test("test_store_equivalence_matches_inhibition_association_scope_and_staleness", () => {
	const stores = pair("boundaries");
	try {
		for (const [query, options] of [["배포", { limit: 5, includeLinked: true }], ["프로젝트", { limit: 5, project: "eval-other" }], ["JWT", { limit: 5 }]]) {
			assert.equal(serialize(stores.file.searchDetailed(query, options)), serialize(stores.sqlite.searchDetailed(query, options)));
		}
	} finally { stores.close(); }
});

test("test_store_equivalence_normalizes_only_declared_fields", () => {
	assert.deepEqual(NORMALIZED_FIELDS, []);
	assert.notEqual(JSON.stringify({ value: 1 }), JSON.stringify({ value: 2 }));
});

test("test_store_equivalence_matches_single_reinforcement_state", () => {
	const stores = pair("reinforcement");
	try {
		const firstLine = fs.readFileSync(goldenPath, "utf8").split(/\r?\n/).find(Boolean);
		assert.ok(firstLine);
		const query = JSON.parse(firstLine).query;
		const fileResult = stores.file.searchDetailed(query, { limit: 1 });
		const sqliteResult = stores.sqlite.searchDetailed(query, { limit: 1 });
		assert.equal(fileResult.results[0]?.record.slug, sqliteResult.results[0]?.record.slug);
		const slug = fileResult.results[0].record.slug;
		const state = (backend) => {
			const row = backend.find(slug).record;
			return [row.storageStrength, row.lastReinforced, row.accessCount, row.lastAccessed];
		};
		assert.equal(JSON.stringify(state(stores.fileBackend)), JSON.stringify(state(stores.sqliteBackend)));
	} finally { stores.close(); }
});

test("test_sqlite_eval_retrieval_keeps_exact_recall_at_least_0_933", () => {
	const result = spawnSync(process.execPath, [path.join(root, "scripts", "eval-retrieval.mjs"), "--min-exact-r1", "0.933"], {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, ASTRONRAG_STORE: "sqlite" },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(fs.readFileSync(path.join(root, "scripts", "eval-retrieval.mjs"), "utf8"), /SqliteStore/);
});

test("test_store_equivalence_operational_copy_does_not_modify_source", () => {
	const arg = process.argv.indexOf("--vault");
	if (arg === -1) return;
	const source = path.resolve(process.argv[arg + 1]);
	const before = treeFingerprint(source);
	const stores = pair("operational", source);
	try {
		const rows = fs.readFileSync(goldenPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
		for (const row of rows) {
			assert.equal(serialize(stores.file.searchDetailed(row.query, { limit: 5 })), serialize(stores.sqlite.searchDetailed(row.query, { limit: 5 })), row.query);
		}
	} finally { stores.close(); }
	const reinforcement = pair("operational-reinforcement", source);
	try {
		const first = fs.readdirSync(path.join(source, "memories")).find((name) => name.endsWith(".md"));
		assert.ok(first, "운영 사본에 활성 기억이 필요합니다");
		const slug = path.basename(first, ".md");
		const title = reinforcement.fileBackend.find(slug).record.title;
		const left = reinforcement.file.searchDetailed(title, { limit: 1 });
		const right = reinforcement.sqlite.searchDetailed(title, { limit: 1 });
		assert.equal(left.results[0]?.record.slug, right.results[0]?.record.slug);
		const reinforced = left.results[0].record.slug;
		const state = (backend) => {
			const row = backend.find(reinforced).record;
			return [row.storageStrength, row.lastReinforced, row.accessCount, row.lastAccessed];
		};
		assert.equal(JSON.stringify(state(reinforcement.fileBackend)), JSON.stringify(state(reinforcement.sqliteBackend)));
	} finally { reinforcement.close(); }
	assert.deepEqual(treeFingerprint(source), before);
});

test("test_store_equivalence_operational_copy_detects_recall_mismatch", () => {
	if (process.env.ASTRONRAG_TEST_EQ_CHILD === "1") return;
	const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--vault", fixture], {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, ASTRONRAG_TEST_EQ_CHILD: "1", ASTRONRAG_TEST_EQUIVALENCE_CORRUPT_SQLITE: "1" },
	});
	assert.equal(result.status, 1, result.stdout + result.stderr);
});

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log(`NORMALIZED_FIELDS=${JSON.stringify(NORMALIZED_FIELDS)}`);
if (failed > 0) process.exitCode = 1;
