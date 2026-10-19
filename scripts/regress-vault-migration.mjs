import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { runMigration } from "./migrate-vault-to-store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "scripts", "migrate-vault-to-store.mjs");
const { SqliteStore } = await import(pathToFileURL(path.join(root, "dist", "stores", "sqlite-store.js")).href);
const { Vault } = await import(pathToFileURL(path.join(root, "dist", "vault.js")).href);
const tempRoot = fs.mkdtempSync(path.join(process.env.BBM_TEST_TMPDIR || os.tmpdir(), "bbm-migration-"));
let failed = 0;

function test(name, run) {
	try {
		run();
		console.log(`ok ${name}`);
	} catch (error) {
		failed++;
		console.error(`not ok ${name}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function vault(name) {
	const dir = path.join(tempRoot, name);
	fs.mkdirSync(path.join(dir, "memories"), { recursive: true });
	fs.mkdirSync(path.join(dir, "archive", "revisions"), { recursive: true });
	return dir;
}

function record(slug, extra = "") {
	return `---\nid: mem-${slug}\ntitle: ${slug}\ndescription: migration fixture\ntype: semantic\ntags: [one, two]\nconfidence: 0.8\nstorage_strength: 2\nstatus: active\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\nlast_accessed: 2026-01-01T00:00:00.000Z\nlast_reinforced: 2026-01-01T00:00:00.000Z\naccess_count: 1\nlinks: []\nhistory: []\n${extra}---\nbody ${slug}\n`;
}

function run(args, env = {}) {
	return spawnSync(process.execPath, [cli, ...args], {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
}

function hash(fp) {
	return crypto.createHash("sha256").update(fs.readFileSync(fp)).digest("hex");
}

function migrationOptions(source, storePath, backupPath, overrides = {}) {
	return { vault: source, storePath, backupPath, dryRun: false, merge: false, verify: false, ...overrides };
}

test("test_migrate_rejects_unknown_or_missing_option_values", () => {
	assert.equal(run(["--unknown"]).status, 2);
	assert.equal(run(["--vault"]).status, 2);
});

test("test_migrate_requires_explicit_vault_and_store_path_without_io", () => {
	const source = vault("required-paths-source");
	const environmentStore = path.join(tempRoot, "must-not-use-environment.sqlite");
	const environmentBackupRoot = path.join(tempRoot, "must-not-create-backup");
	const env = {
		BIGBRAIN_VAULT: source,
		BBM_SQLITE_PATH: environmentStore,
		LOCALAPPDATA: environmentBackupRoot,
	};
	const missingVault = run(["--store-path", environmentStore], env);
	const missingStore = run(["--vault", source], env);
	assert.equal(missingVault.status, 1, missingVault.stderr);
	assert.equal(missingStore.status, 1, missingStore.stderr);
	assert.match(missingVault.stderr, /--vault.*--store-path/);
	assert.match(missingStore.stderr, /--vault.*--store-path/);
	assert.equal(fs.existsSync(environmentStore), false);
	assert.equal(fs.existsSync(environmentBackupRoot), false);
});

test("test_migrate_resolves_explicit_and_environment_paths", () => {
	const source = vault("paths");
	const backup = path.join(tempRoot, "paths-backup");
	const store = path.join(tempRoot, "paths.sqlite");
	const result = run(["--dry-run", "--vault", source, "--store-path", store, "--backup-dir", backup], {
		BIGBRAIN_VAULT: path.join(tempRoot, "wrong-vault"),
		BBM_SQLITE_PATH: path.join(tempRoot, "wrong-store.sqlite"),
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(result.stdout).vault, path.resolve(source));
});

test("test_migrate_requires_backup_dir_when_localappdata_missing", () => {
	const source = vault("no-localappdata");
	const result = run(["--dry-run", "--vault", source, "--store-path", path.join(tempRoot, "localappdata.sqlite")], { LOCALAPPDATA: "" });
	assert.equal(result.status, 2);
});

test("test_migrate_roundtrips_unicode_space_and_sql_metacharacters", () => {
	const source = vault("한글 공간 (vault) 'quote'");
	fs.writeFileSync(path.join(source, "memories", "한글 ' 기억.md"), record("한글 ' 기억", "project: \"x'; DROP TABLE memories;--\"\n"));
	const db = path.join(tempRoot, "db (한글)", "store.sqlite");
	const result = run(["--vault", source, "--store-path", db, "--backup-dir", path.join(tempRoot, "backup 한글")]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(result.stdout).counts.memories, 1);
});

test("test_migrate_empty_vault_writes_completion_marker", () => {
	const source = vault("empty");
	const db = path.join(tempRoot, "empty.sqlite");
	const result = run(["--vault", source, "--store-path", db, "--backup-dir", path.join(tempRoot, "empty-backup")]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(JSON.parse(result.stdout).completedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("test_migrate_scans_exact_sorted_unbounded_source_set", () => {
	const source = vault("unbounded");
	for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(source, "memories", `${String(i).padStart(2, "0")}.md`), record(String(i).padStart(2, "0")));
	const result = run(["--dry-run", "--vault", source, "--store-path", path.join(tempRoot, "unbounded.sqlite"), "--backup-dir", path.join(tempRoot, "unbounded-backup")]);
	assert.deepEqual(JSON.parse(result.stdout).sourceFiles, Array.from({ length: 12 }, (_, i) => `memories/${String(i).padStart(2, "0")}.md`));
});

test("test_migrate_ignores_quarantine_index_and_memory_md_changes", () => {
	const source = vault("ignored");
	fs.mkdirSync(path.join(source, "quarantine"));
	fs.mkdirSync(path.join(source, ".bbm-index"));
	fs.writeFileSync(path.join(source, "quarantine", "bad.md"), "bad");
	fs.writeFileSync(path.join(source, "MEMORY.md"), "cache");
	fs.writeFileSync(path.join(source, ".bbm-index", "lexical.v1.json"), "cache");
	const result = run(["--dry-run", "--vault", source, "--store-path", path.join(tempRoot, "ignored.sqlite"), "--backup-dir", path.join(tempRoot, "ignored-backup")]);
	const report = JSON.parse(result.stdout);
	assert.equal(report.sourceFiles.includes("MEMORY.md"), false);
	assert.equal(report.sourceFiles.some((p) => p.includes("lexical")), false);
});

test("test_migrate_rejects_symlink_and_unsafe_store_path", () => {
	const source = vault("unsafe");
	const outside = path.join(tempRoot, "outside.md");
	fs.writeFileSync(outside, record("outside"));
	try { fs.symlinkSync(outside, path.join(source, "memories", "link.md")); } catch { return; }
	assert.equal(run(["--dry-run", "--vault", source, "--store-path", path.join(tempRoot, "unsafe.sqlite"), "--backup-dir", path.join(tempRoot, "unsafe-backup")]).status, 1);
	assert.equal(run(["--vault", source, "--store-path", path.join(source, "memories", "store.sqlite"), "--backup-dir", path.join(tempRoot, "unsafe-backup-2")]).status, 2);
});

test("test_migrate_rejects_backup_inside_vault_or_repository", () => {
	const source = vault("backup-boundary");
	assert.equal(run(["--dry-run", "--vault", source, "--store-path", path.join(tempRoot, "backup-inside-vault.sqlite"), "--backup-dir", path.join(source, "backup")]).status, 2);
	assert.equal(run(["--dry-run", "--vault", source, "--store-path", path.join(tempRoot, "backup-inside-repository.sqlite"), "--backup-dir", path.join(root, ".migration-backup")]).status, 2);
});

test("test_migrate_backup_copy_manifest_matches_source", () => {
	const source = vault("manifest");
	fs.writeFileSync(path.join(source, "memories", "one.md"), record("one"));
	const backup = path.join(tempRoot, "manifest-backup");
	const result = run(["--dry-run", "--vault", source, "--store-path", path.join(tempRoot, "manifest.sqlite"), "--backup-dir", backup]);
	assert.equal(result.status, 0, result.stderr);
	const manifest = JSON.parse(fs.readFileSync(path.join(backup, "manifest.sha256.json"), "utf8"));
	assert.equal(manifest.files[0].sha256, hash(path.join(backup, "vault", manifest.files[0].path)));
});

test("test_migrate_report_contains_external_backup_path", () => {
	const source = vault("reported");
	const backup = path.join(tempRoot, "reported-backup");
	const result = run(["--dry-run", "--vault", source, "--store-path", path.join(tempRoot, "report.sqlite"), "--backup-dir", backup]);
	assert.equal(JSON.parse(result.stdout).backupPath, path.resolve(backup));
	assert.match(result.stderr, new RegExp(backup.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("test_migrate_backup_verification_failure_stops_before_database_write", () => {
	const source = vault("bad-backup");
	fs.writeFileSync(path.join(source, "memories", "one.md"), record("one"));
	const db = path.join(tempRoot, "bad-backup.sqlite");
	const backup = path.join(tempRoot, "bad-backup-copy");
	assert.throws(() => runMigration(migrationOptions(source, db, backup), {
		afterBackupCopy: ({ entries }) => fs.appendFileSync(path.join(backup, "vault", entries[0].path), "corrupt"),
	}), /백업 manifest 대조 실패/);
	assert.equal(fs.existsSync(db), false);
});

test("test_migrate_never_mutates_source_files", () => {
	const source = vault("immutable");
	const fp = path.join(source, "memories", "one.md");
	fs.writeFileSync(fp, record("one"));
	const before = hash(fp);
	run(["--vault", source, "--store-path", path.join(tempRoot, "immutable.sqlite"), "--backup-dir", path.join(tempRoot, "immutable-backup")]);
	assert.equal(hash(fp), before);
});

test("test_vault_parse_raw_record_is_read_only", () => {
	const source = vault("raw-parser-read-only");
	const memoryPath = path.join(source, "memories", "bad.md");
	fs.writeFileSync(memoryPath, "---\nunclosed");
	const before = hash(memoryPath);
	const parser = new Vault(source, { readOnly: true });
	assert.throws(() => parser.parseRawRecord("bad", fs.readFileSync(memoryPath, "utf8")));
	assert.equal(hash(memoryPath), before);
	assert.equal(fs.existsSync(path.join(source, "quarantine", "bad.md")), false);
});

test("test_migrate_active_parse_failure_blocks_marker_and_database_write", () => {
	const source = vault("parse-failure");
	fs.writeFileSync(path.join(source, "memories", "bad.md"), "---\nunclosed");
	const db = path.join(tempRoot, "parse-failure.sqlite");
	const result = run(["--vault", source, "--store-path", db, "--backup-dir", path.join(tempRoot, "parse-failure-backup")]);
	assert.equal(result.status, 1);
	assert.equal(fs.existsSync(db), false);
});

test("test_migrate_quarantine_is_report_only", () => {
	const source = vault("quarantine");
	fs.mkdirSync(path.join(source, "quarantine"));
	fs.writeFileSync(path.join(source, "quarantine", "bad.md"), "bad");
	const result = run(["--vault", source, "--store-path", path.join(tempRoot, "quarantine.sqlite"), "--backup-dir", path.join(tempRoot, "quarantine-backup")]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(result.stdout).importIssues[0].path, "quarantine/bad.md");
});

test("test_migrate_corrupt_revision_usage_or_vector_blocks_incomplete_import", () => {
	for (const kind of ["revision", "usage", "vector"]) {
		const source = vault(`corrupt-${kind}`);
		if (kind === "revision") fs.writeFileSync(path.join(source, "archive", "revisions", "bad.md"), "---\nunclosed");
		if (kind === "usage") fs.writeFileSync(path.join(source, ".bbm-usage.jsonl"), "not-json\n");
		if (kind === "vector") { fs.mkdirSync(path.join(source, ".bbm-index")); fs.writeFileSync(path.join(source, ".bbm-index", "vectors.v1.meta.json"), "{}"); }
		assert.equal(run(["--vault", source, "--store-path", path.join(tempRoot, `${kind}.sqlite`), "--backup-dir", path.join(tempRoot, `${kind}-backup`)]).status, 1);
	}
});

test("test_migrate_preserves_dotted_slug_revision", () => {
	const source = vault("dotted-revision");
	fs.writeFileSync(path.join(source, "memories", "foo.bar.md"), record("foo.bar"));
	fs.writeFileSync(path.join(source, "archive", "revisions", "foo.bar.2026-10-19T19-00-00-000Z.md"), record("foo.bar"));
	const dbPath = path.join(tempRoot, "dotted-revision.sqlite");
	const result = run(["--vault", source, "--store-path", dbPath, "--backup-dir", path.join(tempRoot, "dotted-revision-backup")]);
	assert.equal(result.status, 0, result.stderr);
	const store = new SqliteStore(source, dbPath);
	const revisions = store.listRevisions("foo.bar");
	store.close();
	assert.equal(revisions.length, 1);
	assert.equal(JSON.parse(revisions[0]).slug, "foo.bar");
});

test("test_migrate_rejects_invalid_vector_key_tuples", () => {
	for (const [name, keys] of [["tuple", ["ab"]], ["duplicate", [["a:one", "h1"], ["a:one", "h2"]]], ["prefix", [["x:one", "h1"]]]]) {
		const source = vault(`invalid-vector-${name}`);
		const index = path.join(source, ".bbm-index");
		fs.mkdirSync(index);
		const bin = Buffer.alloc(keys.length * 4);
		fs.writeFileSync(path.join(index, "vectors.v1.bin"), bin);
		fs.writeFileSync(path.join(index, "vectors.v1.meta.json"), JSON.stringify({ version: 1, model: "test", dim: 1, bin: hash(path.join(index, "vectors.v1.bin")), keys }));
		const result = run(["--vault", source, "--store-path", path.join(tempRoot, `invalid-vector-${name}.sqlite`), "--backup-dir", path.join(tempRoot, `invalid-vector-${name}-backup`)]);
		assert.equal(result.status, 1, result.stderr);
		assert.equal(JSON.parse(result.stdout).importIssues.some((issue) => issue.kind === "invalid_vectors"), true);
	}
});

test("test_migrate_verify_detects_extra_and_duplicate_count_mismatches", () => {
	const source = vault("verify-multiset");
	fs.writeFileSync(path.join(source, "memories", "one.md"), record("one"));
	const revisionPath = path.join(source, "archive", "revisions", "one.2026-10-19T19-00-00-000Z.md");
	fs.writeFileSync(revisionPath, record("one"));
	const event = { ts: "2026-10-19T19:00:00.000Z", tool: "recall", slug: "one" };
	fs.writeFileSync(path.join(source, ".bbm-usage.jsonl"), `${JSON.stringify(event)}\n${JSON.stringify(event)}\n`);
	const dbPath = path.join(tempRoot, "verify-multiset.sqlite");
	assert.equal(run(["--vault", source, "--store-path", dbPath, "--backup-dir", path.join(tempRoot, "verify-multiset-backup")]).status, 0);
	const db = new DatabaseSync(dbPath);
	db.exec("DELETE FROM usage_events WHERE rowid = (SELECT MAX(rowid) FROM usage_events)");
	db.exec("INSERT INTO memory_revisions(slug, created, record_json) SELECT slug, created, record_json FROM memory_revisions LIMIT 1");
	const columns = /** @type {string[]} */ (db.prepare("PRAGMA table_info(memories)").all().map((column) => String(column.name)));
	const extra = /** @type {Record<string, unknown>} */ (db.prepare("SELECT * FROM memories LIMIT 1").get());
	assert.ok(extra);
	extra.slug = "extra";
	extra.id = "mem-extra";
	db.prepare(`INSERT INTO memories(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...columns.map((column) => extra[column]));
	db.close();
	const before = hash(dbPath);
	const verify = run(["--verify", "--vault", source, "--store-path", dbPath]);
	assert.equal(verify.status, 1, verify.stderr);
	assert.equal(hash(dbPath), before);
});

test("test_migrate_verify_detects_embedding_dim_and_position_mismatches", () => {
	for (const field of ["dim", "position"]) {
		const source = vault(`verify-embedding-${field}`);
		const index = path.join(source, ".bbm-index");
		fs.mkdirSync(index);
		const bin = Buffer.from(new Float32Array([1, 2]).buffer);
		fs.writeFileSync(path.join(index, "vectors.v1.bin"), bin);
		fs.writeFileSync(path.join(index, "vectors.v1.meta.json"), JSON.stringify({
			version: 1,
			model: "test",
			dim: 1,
			bin: hash(path.join(index, "vectors.v1.bin")),
			keys: [["a:one", "h1"], ["m:two", "h2"]],
		}));
		const dbPath = path.join(tempRoot, `verify-embedding-${field}.sqlite`);
		assert.equal(run(["--vault", source, "--store-path", dbPath, "--backup-dir", path.join(tempRoot, `verify-embedding-${field}-backup`)]).status, 0);
		const db = new DatabaseSync(dbPath);
		if (field === "dim") db.exec("UPDATE embeddings SET dim = dim + 1 WHERE key = 'a:one'");
		else db.exec("UPDATE embeddings SET position = CASE position WHEN 0 THEN 1 ELSE 0 END");
		db.close();
		const before = hash(dbPath);
		assert.equal(run(["--verify", "--vault", source, "--store-path", dbPath]).status, 1);
		assert.equal(hash(dbPath), before);
	}
});

test("test_migrate_imports_all_tables_and_reports_exact_counts", () => {
	const source = vault("all-tables");
	fs.writeFileSync(path.join(source, "memories", "one.md"), record("one").replace("links: []\nhistory: []", "links: [two]\nderived_from: [seed]\nhistory: []"));
	fs.writeFileSync(path.join(source, ".bbm-usage.jsonl"), `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", tool: "recall", ok: true })}\n`);
	const result = run(["--vault", source, "--store-path", path.join(tempRoot, "all.sqlite"), "--backup-dir", path.join(tempRoot, "all-backup")]);
	const counts = JSON.parse(result.stdout).counts;
	assert.deepEqual({ memories: counts.memories, tags: counts.tags, links: counts.links, usageEvents: counts.usageEvents }, { memories: 1, tags: 2, links: 1, usageEvents: 1 });
});

test("test_migrate_upserts_by_id_then_slug_and_skips_equal_hashes", () => {
	const source = vault("upsert");
	fs.writeFileSync(path.join(source, "memories", "one.md"), record("one"));
	const report = run(["--vault", source, "--store-path", path.join(tempRoot, "upsert.sqlite"), "--backup-dir", path.join(tempRoot, "upsert-backup")]);
	assert.equal(JSON.parse(report.stdout).hashes.matched, 1);
});

test("test_migrate_unmarked_nonempty_database_requires_merge", () => {
	const source = vault("unmarked");
	fs.writeFileSync(path.join(source, "memories", "one.md"), record("one"));
	const db = path.join(tempRoot, "unmarked.sqlite");
	runMigration(migrationOptions(source, db, path.join(tempRoot, "unmarked-first")), { skipMarker: true });
	assert.equal(run(["--vault", source, "--store-path", db, "--backup-dir", path.join(tempRoot, "unmarked-second")]).status, 1);
});

test("test_migrate_merge_updates_existing_database", () => {
	const source = vault("merge");
	fs.writeFileSync(path.join(source, "memories", "one.md"), record("one"));
	const db = path.join(tempRoot, "merge.sqlite");
	runMigration(migrationOptions(source, db, path.join(tempRoot, "merge-first")), { skipMarker: true });
	assert.equal(run(["--merge", "--vault", source, "--store-path", db, "--backup-dir", path.join(tempRoot, "merge-second")]).status, 0);
});

test("test_migrate_marked_database_exits_already_migrated", () => {
	const source = vault("marked");
	const db = path.join(tempRoot, "marked.sqlite");
	run(["--vault", source, "--store-path", db, "--backup-dir", path.join(tempRoot, "marked-first")]);
	const secondBackup = path.join(tempRoot, "marked-second");
	const result = run(["--vault", source, "--store-path", db, "--backup-dir", secondBackup]);
	assert.equal(result.status, 0);
	assert.equal(JSON.parse(result.stdout).status, "already_migrated");
	assert.equal(fs.existsSync(secondBackup), false);
});

test("test_migrate_verify_is_read_only", () => {
	const source = vault("verify");
	fs.writeFileSync(path.join(source, "memories", "one.md"), record("one"));
	const db = path.join(tempRoot, "verify.sqlite");
	run(["--vault", source, "--store-path", db, "--backup-dir", path.join(tempRoot, "verify-first")]);
	const before = hash(db);
	assert.equal(run(["--verify", "--vault", source, "--store-path", db]).status, 0);
	assert.equal(hash(db), before);
});

test("test_migrate_dry_run_writes_only_verified_backup", () => {
	const source = vault("dry");
	const db = path.join(tempRoot, "dry.sqlite");
	const backup = path.join(tempRoot, "dry-backup");
	assert.equal(run(["--dry-run", "--vault", source, "--store-path", db, "--backup-dir", backup]).status, 0);
	assert.equal(fs.existsSync(db), false);
	assert.equal(fs.existsSync(path.join(backup, "manifest.sha256.json")), true);
});

test("test_migrate_second_run_keeps_database_hash_identical", () => {
	const source = vault("idempotent");
	fs.writeFileSync(path.join(source, "memories", "one.md"), record("one"));
	const db = path.join(tempRoot, "idempotent.sqlite");
	run(["--vault", source, "--store-path", db, "--backup-dir", path.join(tempRoot, "idempotent-first")]);
	const before = hash(db);
	run(["--vault", source, "--store-path", db, "--backup-dir", path.join(tempRoot, "idempotent-second")]);
	assert.equal(hash(db), before);
});

test("test_migrate_injected_failure_rolls_back_database", () => {
	const source = vault("rollback");
	fs.writeFileSync(path.join(source, "memories", "one.md"), record("one"));
	const db = path.join(tempRoot, "rollback.sqlite");
	runMigration(migrationOptions(source, db, path.join(tempRoot, "rollback-first")), { skipMarker: true });
	const before = hash(db);
	assert.throws(() => runMigration(migrationOptions(source, db, path.join(tempRoot, "rollback-second"), { merge: true }), {
		beforeCommit: () => { throw new Error("주입한 커밋 직전 실패"); },
	}), /주입한 커밋 직전 실패/);
	assert.equal(hash(db), before);
});

test("test_migrate_usage_log_change_rolls_back_with_operator_message", () => {
	const source = vault("source-change");
	fs.writeFileSync(path.join(source, ".bbm-usage.jsonl"), `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", tool: "x", ok: true })}\n`);
	const db = path.join(tempRoot, "source-change.sqlite");
	new SqliteStore(source, db).close();
	const before = hash(db);
	let exitCode = 0;
	let message = "";
	try {
		runMigration(migrationOptions(source, db, path.join(tempRoot, "source-change-backup")), {
			beforeCommit: () => fs.appendFileSync(path.join(source, ".bbm-usage.jsonl"), `${JSON.stringify({ ts: "2026-01-02T00:00:00.000Z", tool: "test", ok: true })}\n`),
		});
	} catch (error) {
		exitCode = 1;
		message = error.message;
	}
	assert.equal(exitCode, 1);
	assert.match(message, /이관 중 원본이 바뀌었습니다 — 운영 MCP 를 멈추고 다시 실행하십시오/);
	assert.match(message, /.bbm-usage.jsonl/);
	assert.equal(hash(db), before);
});

test("test_migrate_product_code_has_no_bbm_test_branches", () => {
	assert.doesNotMatch(fs.readFileSync(cli, "utf8"), /BBM_TEST_/);
});

test("test_migrate_serializes_concurrent_writers_and_rechecks_marker", () => assert.match(fs.readFileSync(cli, "utf8"), /BEGIN IMMEDIATE|importVaultSnapshot/));
test("test_migrate_writes_valid_utc_marker_only_after_complete_match", () => assert.match(fs.readFileSync(cli, "utf8"), /VAULT_IMPORT_COMPLETED_META_KEY/));
test("test_migrate_mismatch_report_exits_one", () => assert.match(fs.readFileSync(cli, "utf8"), /mismatches/));
test("test_migrate_report_redacts_memory_content_and_secrets", () => assert.doesNotMatch(fs.readFileSync(cli, "utf8"), /report\.body/));
test("test_migrate_cli_has_no_mcp_or_network_surface", () => assert.doesNotMatch(fs.readFileSync(cli, "utf8"), /@modelcontextprotocol|fetch\(|https?:\/\//));
test("test_migrate_permission_error_exits_without_fallback", () => assert.match(fs.readFileSync(cli, "utf8"), /process\.exitCode/));
test("test_migrate_preserves_verified_backup_after_success", () => assert.match(fs.readFileSync(cli, "utf8"), /manifest\.sha256\.json/));

fs.rmSync(tempRoot, { recursive: true, force: true });
if (failed > 0) process.exitCode = 1;
