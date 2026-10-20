import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { SqliteStore } from "../dist/stores/sqlite-store.js";
import { collectVaultSnapshot, runMigration } from "./migrate-vault-to-store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(root, ".astron-logs", "export-test-"));
const cli = path.join(root, "scripts", "export-store-to-vault.mjs");
const stamp = "2026-01-01T00:00:00.000Z";
let failed = 0;

async function test(name, run) {
	try {
		await run();
		console.log(`ok ${name}`);
	} catch (error) {
		failed++;
		console.error(`not ok ${name}: ${error instanceof Error ? error.stack : String(error)}`);
	}
}

function record(slug = "기억", overrides = {}) {
	return {
		id: `mem-${slug}`, slug, title: "한글 / 제목: \"인용\" CON", description: "export fixture",
		type: "semantic", tags: ["둘", "하나"], confidence: 0.8123456789, storageStrength: 2.123456789,
		status: "active", created: stamp, updated: stamp, lastAccessed: stamp, lastReinforced: stamp,
		accessCount: 7, source: "자료", project: "project", links: ["z", "a"], derivedFrom: ["b", "a"],
		reviewAfter: "2026-11-01", supersedes: "old", supersededBy: "new", archiveReason: "보관 사유",
		history: ["둘째", "첫째"], body: "본문\n---\n특수문자 \\ / :", ...overrides,
	};
}

function raw(item) {
	const fm = { ...item };
	delete fm.slug;
	delete fm.body;
	for (const [from, to] of Object.entries({ storageStrength: "storage_strength", lastAccessed: "last_accessed", lastReinforced: "last_reinforced", accessCount: "access_count", derivedFrom: "derived_from", reviewAfter: "review_after", supersededBy: "superseded_by", archiveReason: "archive_reason" })) {
		if (fm[from] !== undefined) { fm[to] = fm[from]; delete fm[from]; }
	}
	return matter.stringify(`\n${item.body}\n`, fm);
}

function setup(name, records = [record()]) {
	const dir = path.join(temp, name);
	fs.mkdirSync(dir);
	const storePath = path.join(dir, "source", "store.sqlite");
	const store = new SqliteStore(path.join(dir, "vault"), storePath);
	try { for (const item of records) store.write(item, item.status === "archived"); } finally { store.close(); }
	return { dir, storePath, out: path.join(dir, "out") };
}

function sql(storePath, run) {
	const db = new DatabaseSync(storePath);
	try { return run(db); } finally { db.close(); }
}

function hash(fp) { return crypto.createHash("sha256").update(fs.readFileSync(fp)).digest("hex"); }

async function exporter() { return import("./export-store-to-vault.mjs"); }

function options(item, extra = {}) { return { storePath: item.storePath, out: item.out, cwd: item.dir, env: {}, ...extra }; }

function snapshot(dir) {
	const result = collectVaultSnapshot(dir);
	assert.deepEqual(result.issues, []);
	return result.snapshot;
}

await test("test_store_export_roundtrip_snapshot_equivalence", async () => {
	const { exportStoreToVault } = await exporter();
	const item = setup("roundtrip", []);
	const source = path.join(item.dir, "input");
	fs.mkdirSync(path.join(source, "memories"), { recursive: true });
	fs.mkdirSync(path.join(source, "archive", "revisions"), { recursive: true });
	fs.writeFileSync(path.join(source, "memories", "기억.md"), raw(record()));
	fs.writeFileSync(path.join(source, "archive", "보관.md"), raw(record("보관", { status: "archived" })));
	fs.writeFileSync(path.join(source, "archive", "revisions", "기억.2026-01-01T00-00-00-000Z.md"), raw(record("기억", { body: "이전 본문" })));
	fs.writeFileSync(path.join(source, ".bbm-usage.jsonl"), [1, 2].map((n) => JSON.stringify({ ts: stamp, event: "recall", slug: "기억", ok: true, n })).join("\n") + "\n");
	const values = new Float32Array([0.25, -0.5, 1, 0]);
	const bytes = Buffer.from(values.buffer);
	fs.mkdirSync(path.join(source, ".bbm-index"));
	fs.writeFileSync(path.join(source, ".bbm-index", "vectors.v1.bin"), bytes);
	fs.writeFileSync(path.join(source, ".bbm-index", "vectors.v1.meta.json"), JSON.stringify({ version: 1, model: "model", dim: 2, keys: [["m:기억", "h1"], ["a:보관", "h2"]], bin: crypto.createHash("sha256").update(bytes).digest("hex") }));
	const expected = snapshot(source);
	runMigration({ vault: source, storePath: item.storePath, backupPath: path.join(item.dir, "backup"), dryRun: false, merge: false, verify: false });
	const result = exportStoreToVault(options(item));
	assert.equal(result.status, "exported");
	assert.deepEqual(snapshot(item.out), expected);
	assert.deepEqual(result.counts, { memories: 1, archive: 1, revisions: 1, usageEvents: 2, embeddings: 2 });
});

await test("test_store_export_rejects_nonempty_target", async () => {
	const { exportStoreToVault } = await exporter();
	const item = setup("nonempty");
	fs.mkdirSync(item.out);
	const keep = path.join(item.out, "keep.txt");
	fs.writeFileSync(keep, "preserve");
	const before = hash(item.storePath);
	assert.throws(() => exportStoreToVault(options(item)), /비어|empty/i);
	assert.equal(fs.readFileSync(keep, "utf8"), "preserve");
	assert.equal(hash(item.storePath), before);
});

await test("test_store_export_rejects_protected_or_escaping_target", async () => {
	const { exportStoreToVault } = await exporter();
	const item = setup("paths");
	for (const out of [item.storePath, path.dirname(item.storePath), path.join(path.dirname(item.storePath), "nested"), item.dir, path.join(item.dir, "..", "escape")]) {
		assert.throws(() => exportStoreToVault(options(item, { out })), /경로|보호|boundary|protected/i);
	}
	const protectedVault = path.join(item.dir, "protected-vault");
	fs.mkdirSync(protectedVault);
	assert.throws(() => exportStoreToVault(options(item, { out: path.join(protectedVault, "child"), env: { BIGBRAIN_VAULT: protectedVault } })), /경로|보호/i);
	assert.throws(() => exportStoreToVault(options(item, { out: "D:\\BigBrainMemory\\vault\\export" })), /경로|보호/i);
	const linked = path.join(item.dir, "link");
	fs.symlinkSync(path.dirname(item.storePath), linked, process.platform === "win32" ? "junction" : "dir");
	assert.throws(() => exportStoreToVault(options(item, { out: path.join(linked, "out") })), /경로|링크|link/i);
	assert.deepEqual(fs.readdirSync(linked), ["store.sqlite"]);
	const vaultRoot = path.join(item.dir, "original-vault");
	const defaultDb = path.join(vaultRoot, ".bbm", "store.sqlite");
	const store = new SqliteStore(vaultRoot, defaultDb);
	store.close();
	assert.throws(() => exportStoreToVault(options(item, { storePath: defaultDb, out: path.join(vaultRoot, "export") })), /경로|보호/i);
});

await test("test_store_export_dry_run_has_no_writes", async () => {
	const { exportStoreToVault, parseCli } = await exporter();
	const item = setup("dry");
	const before = hash(item.storePath);
	const files = fs.readdirSync(item.dir);
	const result = exportStoreToVault(options(item, { dryRun: true }));
	assert.equal(result.status, "dry_run");
	assert.equal(result.counts.memories, 1);
	assert.equal(hash(item.storePath), before);
	assert.deepEqual(fs.readdirSync(item.dir), files);
	const defaults = parseCli(["--store-path", item.storePath, "--dry-run"], {}, item.dir);
	assert.equal(path.dirname(defaults.out), item.dir);
	assert.notEqual(parseCli(["--store-path", item.storePath], {}, item.dir).out, defaults.out);
	assert.equal(fs.existsSync(defaults.out), false);
	assert.throws(() => exportStoreToVault(options(item, { out: path.join(item.dir, "missing", "nested"), dryRun: true })), /부모.*경로/);
});

await test("test_store_export_rejects_corrupt_rows_before_writing", async () => {
	const { exportStoreToVault } = await exporter();
	const cases = [
		(db) => db.exec("UPDATE memories SET type='invalid'"),
		(db) => db.exec("UPDATE memories SET status='invalid'"),
		(db) => db.exec("UPDATE memories SET confidence=2"),
		(db) => db.exec("UPDATE memories SET created='invalid'"),
		(db) => db.exec("UPDATE memories SET access_count=-1"),
		(db) => db.exec("INSERT INTO memory_revisions(slug,created,record_json) VALUES('기억','2026-01-01','{')"),
		(db) => db.exec("INSERT INTO memory_revisions(slug,created,record_json) VALUES('기억','2026-01-01','null')"),
		(db) => db.exec("INSERT INTO usage_events(ts,payload) VALUES('2026-01-01','{')"),
		(db) => db.exec("INSERT INTO usage_events(ts,payload) VALUES('2026-01-01','[]')"),
		(db) => db.exec("INSERT INTO embeddings VALUES('model','m:기억','h',2,x'00000000',0)"),
		(db) => db.exec("INSERT INTO embeddings VALUES('model','m:기억','h',0,x'',0)"),
		(db) => db.exec("INSERT INTO embeddings VALUES('model','m:기억','h',1,x'0000c07f',0)"),
	];
	for (const [index, corrupt] of cases.entries()) {
		const item = setup(`corrupt-${index}`);
		sql(item.storePath, corrupt);
		const before = hash(item.storePath);
		assert.throws(() => exportStoreToVault(options(item)), /손상|invalid|JSON|vector|벡터|record|기억/i);
		assert.equal(fs.existsSync(item.out), false);
		assert.equal(hash(item.storePath), before);
		assert.equal(fs.readdirSync(item.dir).some((name) => /export-|\.lock/.test(name)), false);
		if (index === 0) {
			const result = spawnSync(process.execPath, [cli, "--store-path", item.storePath, "--out", item.out], { cwd: item.dir, encoding: "utf8" });
			assert.equal(result.status, 2);
			const failure = result.stderr.split(/\r?\n/).find((line) => line.startsWith("{"));
			assert(failure);
			assert.equal(JSON.parse(failure).reason, "invalid_store_data");
		}
	}
});

await test("test_store_export_unicode_special_titles_preserve_records", async () => {
	const { exportStoreToVault } = await exporter();
	const records = [record("한글"), record("same-2"), record("con_", { title: "CON" })];
	const item = setup("unicode", records);
	exportStoreToVault(options(item));
	assert.deepEqual(fs.readdirSync(path.join(item.out, "memories")).sort(), records.map((r) => `${r.slug}.md`).sort());
	assert.deepEqual(snapshot(item.out).records.map((r) => r.record).sort((a, b) => a.slug.localeCompare(b.slug)), records.sort((a, b) => a.slug.localeCompare(b.slug)));
	for (const [index, slug] of ["../escape", "CON", "con.txt", "trailing.", "bad:stream", "bad\u0001", "a".repeat(256)].entries()) {
		const bad = setup(`slug-${index}`);
		sql(bad.storePath, (db) => {
			db.exec("PRAGMA foreign_keys=OFF");
			db.prepare("UPDATE memories SET slug=?").run(slug);
			for (const table of ["memory_tags", "memory_links", "memory_history", "memory_derived_from"]) db.prepare(`UPDATE ${table} SET slug=?`).run(slug);
		});
		assert.throws(() => exportStoreToVault(options(bad)), /slug|손상/i);
		assert.equal(fs.existsSync(bad.out), false);
	}
	const collision = setup("collision", [record("Same"), record("same")]);
	assert.throws(() => exportStoreToVault(options(collision)), /충돌|collision/i);
});

await test("test_store_export_closes_resources_on_success_and_failure", async () => {
	const { exportStoreToVault } = await exporter();
	for (const mode of ["success", "serialize", "permission", "commit", "occupied", "partial", "late-content", "cleanup"]) {
		const item = setup(`cleanup-${mode}`, mode === "partial" ? [record(), record("second")] : [record()]);
		const close = SqliteStore.prototype.close;
		const write = fs.writeFileSync;
		const mkdir = fs.mkdirSync;
		const link = fs.linkSync;
		const mkdtemp = fs.mkdtempSync;
		const rm = fs.rmSync;
		let linked = 0;
		let closes = 0;
		SqliteStore.prototype.close = function () { closes++; return close.call(this); };
		if (mode === "serialize") sql(item.storePath, (db) => db.exec("UPDATE memories SET body=' trailing '"));
		if (mode === "permission") fs.writeFileSync = function (fp, ...args) {
			if (String(fp).endsWith(".md")) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
			return write.call(this, fp, ...args);
		};
		if (mode === "commit") fs.mkdirSync = function (fp, ...args) {
			if (fp === item.out) throw Object.assign(new Error("commit failed"), { code: "EACCES" });
			return mkdir.call(this, fp, ...args);
		};
		if (mode === "occupied") fs.mkdirSync = function (fp, ...args) {
			if (fp === item.out) {
				mkdir.call(this, fp);
				write.call(fs, path.join(item.out, "other.txt"), "other owner");
			}
			return mkdir.call(this, fp, ...args);
		};
		if (mode === "partial") fs.linkSync = function (from, to) {
			if (++linked === 2) {
				write.call(fs, path.join(item.out, "other.txt"), "other owner");
				throw Object.assign(new Error("publish failed"), { code: "EACCES" });
			}
			return link.call(this, from, to);
		};
		if (mode === "late-content") {
			mkdir.call(fs, item.out);
			fs.mkdtempSync = function (...args) {
				const stage = mkdtemp.call(this, ...args);
				write.call(fs, path.join(item.out, "other.txt"), "other owner");
				return stage;
			};
		}
		if (mode === "cleanup") fs.rmSync = function (fp, ...args) {
			if (String(fp).includes(".vault-export-")) throw Object.assign(new Error("cleanup failed"), { code: "EACCES" });
			return rm.call(this, fp, ...args);
		};
		try {
			if (mode === "success") exportStoreToVault(options(item));
			else assert.throws(() => exportStoreToVault(options(item)));
		} finally {
			SqliteStore.prototype.close = close;
			fs.writeFileSync = write;
			fs.mkdirSync = mkdir;
			fs.linkSync = link;
			fs.mkdtempSync = mkdtemp;
			fs.rmSync = rm;
		}
		assert.equal(closes, 1);
		assert.equal(fs.readdirSync(item.dir).some((name) => /\.lock/.test(name)), false);
		if (mode !== "cleanup") assert.equal(fs.readdirSync(item.dir).some((name) => /export-/.test(name)), false);
		if (["occupied", "partial", "late-content"].includes(mode)) assert.deepEqual(fs.readdirSync(item.out), ["other.txt"]);
		sql(item.storePath, (db) => { db.exec("BEGIN EXCLUSIVE; ROLLBACK"); });
		fs.renameSync(item.storePath, `${item.storePath}.moved`);
		fs.renameSync(`${item.storePath}.moved`, item.storePath);
	}
});

await test("test_store_export_rejects_invalid_cli_and_handles_empty_store", async () => {
	const { exportStoreToVault, parseCli } = await exporter();
	for (const args of [[], ["--unknown"], ["--store-path"], ["--store-path", ""], ["--store-path", " "], ["--store-path", "db", "--out"], ["--store-path", "db", "--out", ""], ["--store-path", "db", "extra"], ["--store-path", "db", "--store-path", "other"]]) {
		assert.throws(() => parseCli(args, {}, temp));
		const result = spawnSync(process.execPath, [cli, ...args], { cwd: temp, encoding: "utf8" });
		assert.equal(result.status, 2);
	}
	const item = setup("empty", []);
	const result = exportStoreToVault(options(item));
	assert.deepEqual(result.counts, { memories: 0, archive: 0, revisions: 0, usageEvents: 0, embeddings: 0 });
	assert.deepEqual(snapshot(item.out), { records: [], revisions: [], usageEvents: [], embeddings: [] });
	const good = setup("cli", []);
	const run = spawnSync(process.execPath, [cli, "--store-path", good.storePath, "--out", good.out], { cwd: good.dir, encoding: "utf8", env: { ...process.env, BIGBRAIN_VAULT: "" } });
	assert.equal(run.status, 0, run.stderr);
	assert.equal(JSON.parse(run.stdout).status, "exported");
});

await test("test_store_export_uses_consistent_snapshot_during_writes", async () => {
	const { exportStoreToVault } = await exporter();
	const item = setup("consistent");
	sql(item.storePath, (db) => db.exec("PRAGMA journal_mode=WAL"));
	const writer = new DatabaseSync(item.storePath);
	const prepare = DatabaseSync.prototype.prepare;
	let updated = false;
	DatabaseSync.prototype.prepare = function (query, ...args) {
		const statement = prepare.call(this, query, ...args);
		if (/SELECT \* FROM memories/i.test(query)) {
			const all = statement.all.bind(statement);
			statement.all = (...params) => {
				const rows = all(...params);
				writer.exec("BEGIN; UPDATE memories SET title='new title'; UPDATE memory_tags SET value='new tag'; COMMIT");
				updated = true;
				return rows;
			};
		}
		return statement;
	};
	try { exportStoreToVault(options(item)); } finally { DatabaseSync.prototype.prepare = prepare; writer.close(); }
	assert.equal(updated, true);
	const actual = snapshot(item.out).records[0].record;
	assert.equal(actual.title, record().title);
	assert.deepEqual(actual.tags, record().tags);
	assert.equal(sql(item.storePath, (db) => db.prepare("SELECT title FROM memories").get()).title, "new title");
});

await test("test_store_export_rejects_unrepresentable_vector_models", async () => {
	const { exportStoreToVault } = await exporter();
	for (const mode of ["none", "one", "multi", "mixed"]) {
		const item = setup(`vectors-${mode}`);
		const store = new SqliteStore(path.join(item.dir, "vault"), item.storePath);
		try {
			if (mode !== "none") store.replaceEmbeddings("model", [{ key: "m:기억", hash: "h", vector: new Float32Array([1, 2]) }]);
			if (mode === "multi") store.replaceEmbeddings("other", [{ key: "m:기억", hash: "h", vector: new Float32Array([3, 4]) }]);
			if (mode === "mixed") store.replaceEmbeddings("model", [{ key: "m:기억", hash: "h", vector: new Float32Array([1, 2]) }, { key: "m:other", hash: "h2", vector: new Float32Array([3]) }]);
		} finally { store.close(); }
		if (mode === "multi" || mode === "mixed") {
			assert.throws(() => exportStoreToVault(options(item)), /vault.*(모델|차원)|모델.*vault|차원/i);
			assert.equal(fs.existsSync(item.out), false);
		} else {
			exportStoreToVault(options(item));
			assert.equal(snapshot(item.out).embeddings.length, mode === "none" ? 0 : 1);
		}
	}
});

await test("test_store_export_preserves_precision_revision_times_and_order", async () => {
	const { exportStoreToVault } = await exporter();
	const item = setup("precision");
	const created = "2026-02-03T04:05:06.789Z";
	sql(item.storePath, (db) => {
		for (let n = 0; n < 12; n++) {
			db.prepare("INSERT INTO memory_revisions(slug,created,record_json) VALUES(?,?,?)").run("기억", created, JSON.stringify(record("기억", { body: `revision ${n}` })));
			db.prepare("INSERT INTO usage_events(ts,payload) VALUES(?,?)").run(stamp, JSON.stringify({ event: "recall", n }));
		}
	});
	exportStoreToVault(options(item));
	const actual = snapshot(item.out);
	assert.equal(actual.records[0].record.storageStrength, record().storageStrength);
	assert.equal(actual.records[0].record.confidence, record().confidence);
	assert.deepEqual(actual.revisions.map((r) => r.record.body), Array.from({ length: 12 }, (_, n) => `revision ${n}`));
	assert.deepEqual(actual.usageEvents.map((e) => e.n), Array.from({ length: 12 }, (_, n) => n));
	const names = fs.readdirSync(path.join(item.out, "archive", "revisions")).sort();
	assert.equal(names.length, 12);
	assert(names.every((name) => name.startsWith("기억.2026-02-03T04-05-06-789Z")));
	assert(actual.revisions.every((revision) => revision.record.updated === stamp));
	const store = new SqliteStore(path.join(item.dir, "vault"), item.storePath, { readOnly: true });
	try { assert(store.exportVaultSnapshot().revisions.every((revision) => revision.created === created)); } finally { store.close(); }
});

assert(withinTemp(temp));
fs.rmSync(temp, { recursive: true, force: true });
console.log(`store export: 11 tests, ${failed} failures`);
process.exitCode = failed ? 1 : 0;

function withinTemp(candidate) {
	const absolute = path.resolve(candidate);
	const boundary = path.join(root, ".astron-logs") + path.sep;
	return absolute.startsWith(boundary) && fs.realpathSync(absolute) === absolute;
}
