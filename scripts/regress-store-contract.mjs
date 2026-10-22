import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const distUrl = (name) => pathToFileURL(path.join(root, "dist", name)).href;
for (const key of Object.keys(process.env)) {
	if (/^(?:ASTRONRAG_|BIGBRAIN_|BBM_)/.test(key)) delete process.env[key];
}
const tmpRoot = path.resolve(os.tmpdir());
fs.mkdirSync(tmpRoot, { recursive: true });

const tests = /** @type {{ name: string, run: () => unknown | Promise<unknown> }[]} */ (Array());
const test = (name, run) => tests.push({ name, run });
const temp = (name) => fs.mkdtempSync(path.join(tmpRoot, `bbm-${name}-`));
const record = (slug, extra = {}) => {
	const now = "2026-01-02T03:04:05.000Z";
	return {
		id: `mem-${slug}`,
		slug,
		title: slug,
		description: `description ${slug}`,
		type: "semantic",
		tags: [],
		confidence: 0.8,
		storageStrength: 1,
		status: "active",
		created: now,
		updated: now,
		lastAccessed: now,
		lastReinforced: now,
		accessCount: 0,
		links: [],
		history: [],
		body: `body ${slug}`,
		...extra,
	};
};

const stores = await import(distUrl("stores/index.js"));
const { MemoryService } = await import(distUrl("store.js"));
const { Vault } = await import(distUrl("vault.js"));

/** @type {any} */
let concurrentResult;
async function verifyConcurrentWrites() {
	if (concurrentResult) return concurrentResult;
	const dir = temp("concurrent-writes");
	new stores.SqliteStore(dir).close();
	const childCode = `
		import { SqliteStore } from ${JSON.stringify(distUrl("stores/sqlite-store.js"))};
		const [dir, worker] = process.argv.slice(1);
		const store = new SqliteStore(dir);
		for (let n = 0; n < 20; n++) {
			const now = "2026-01-02T03:04:05.000Z";
			store.createNew({ id: "mem-" + worker + "-" + n, slug: "worker-" + worker + "-" + n, title: "worker", description: "worker", type: "semantic", tags: [], confidence: 0.8, storageStrength: 1, status: "active", created: now, updated: now, lastAccessed: now, lastReinforced: now, accessCount: 0, links: [], history: [], body: "worker" });
		}
		store.close();
	`;
	/** @type {{ code: number | null, stdout: string, stderr: string }[]} */
	const outcomes = await Promise.all(Array.from({ length: 4 }, (_, worker) => new Promise((resolve) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", childCode, dir, String(worker)]);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	})));
	const store = new stores.SqliteStore(dir);
	concurrentResult = {
		outcomes,
		count: store.listSlugs(true).length,
		integrity: store.integrityCheck(),
	};
	store.close();
	fs.rmSync(dir, { recursive: true, force: true });
	return concurrentResult;
}

async function verifyConcurrentSlugAllocation() {
	const dir = temp("concurrent-slugs");
	new stores.SqliteStore(dir).close();
	const childCode = `
		import { SqliteStore } from ${JSON.stringify(distUrl("stores/sqlite-store.js"))};
		const [dir, worker] = process.argv.slice(1);
		const now = "2026-01-02T03:04:05.000Z";
		const store = new SqliteStore(dir);
		store.createNew({ id: "mem-" + worker, slug: "same-slug", title: "worker " + worker, description: "worker", type: "semantic", tags: [], confidence: 0.8, storageStrength: 1, status: "active", created: now, updated: now, lastAccessed: now, lastReinforced: now, accessCount: 0, links: [], history: [], body: "worker " + worker });
		store.close();
	`;
	const outcomes = await Promise.all(Array.from({ length: 4 }, (_, worker) => new Promise((resolve) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", childCode, dir, String(worker)]);
		let stderr = "";
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("close", (code) => resolve({ code, stderr }));
	})));
	const store = new stores.SqliteStore(dir);
	const records = store.listSlugs().map(({ slug }) => store.read(slug));
	store.close();
	fs.rmSync(dir, { recursive: true, force: true });
	return { outcomes, records };
}

async function verifyHotJournalRecovery() {
	const dir = temp("hot-journal");
	const store = new stores.SqliteStore(dir);
	store.createNew(record("stable", { title: "stable" }));
	const dbPath = store.databasePath;
	store.close();
	const childCode = `
		import { DatabaseSync } from "node:sqlite";
		const db = new DatabaseSync(process.argv[1]);
		db.exec("PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE");
		db.prepare("UPDATE memories SET title='partial' WHERE slug='stable'").run();
		process.stdout.write("ready\\n");
		setInterval(() => {}, 1000);
	`;
	await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", childCode, dbPath]);
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk;
			if (output.includes("ready")) child.kill();
		});
		child.on("error", reject);
		child.on("close", () => resolve(undefined));
	});
	const recovered = new stores.SqliteStore(dir);
	const result = { title: recovered.read("stable")?.title, integrity: recovered.integrityCheck() };
	recovered.close();
	fs.rmSync(dir, { recursive: true, force: true });
	return result;
}

async function eachStore(name, run) {
	for (const kind of ["sqlite", "file"]) {
		const make = kind === "sqlite"
			? (dir) => new stores.SqliteStore(dir)
			: (dir) => new stores.FileStore(dir);
		const dir = temp(`${name}-${kind}`);
		const store = make(dir);
		try {
			await run(store, dir, kind);
		} finally {
			store.close();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
}

async function withSqliteMcp(name, setup, run) {
	const dir = temp(name);
	await setup(dir);
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [path.join(root, "dist", "index.js")],
		env: { ...process.env, ASTRONRAG_VAULT: dir, ASTRONRAG_SQLITE_PATH: path.join(dir, ".bbm", "store.sqlite"), ASTRONRAG_STORE: "sqlite" },
		stderr: "pipe",
	});
	const client = new Client({ name: `store-contract-${name}`, version: "0.0.1" });
	try {
		await client.connect(transport);
		await run(client);
	} finally {
		await client.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test("test_store_factory_defaults_empty_to_sqlite", () => {
	for (const value of [undefined, ""]) {
		const dir = temp("factory-default");
		const store = stores.createMemoryStore(dir, { ASTRONRAG_STORE: value });
		assert.ok(store instanceof stores.SqliteStore);
		store.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("test_store_factory_rejects_unknown_kind", () => {
	for (const value of ["postgres", " sqlite", "sqlite ", "SQLITE", "File"]) {
		const dir = temp("factory-reject");
		assert.throws(() => stores.createMemoryStore(dir, { ASTRONRAG_STORE: value }), new RegExp(value));
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("test_sqlite_default_path_under_vault_bbm", () => {
	for (const value of [undefined, ""]) {
		const dir = temp("default-path");
		const store = stores.createMemoryStore(dir, { ASTRONRAG_STORE: "sqlite", ASTRONRAG_SQLITE_PATH: value });
		assert.equal(store.databasePath, path.join(dir, ".bbm", "store.sqlite"));
		store.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("test_sqlite_custom_path_supports_unicode_spaces", () => {
	const dir = temp("unicode-path");
	const dbPath = path.join(dir, "공백 (괄호)", "기억 저장소.sqlite");
	const store = new stores.SqliteStore(dir, dbPath);
	store.createNew(record("unicode"));
	store.close();
	assert.ok(fs.existsSync(dbPath));
	fs.rmSync(dir, { recursive: true, force: true });
});

test("test_sqlite_parameterizes_special_character_fields", () => {
	const dir = temp("parameters");
	const store = new stores.SqliteStore(dir);
	const input = record("special", {
		title: "'제목'; DROP TABLE memories; -- %_",
		description: "한글 ' ; % _",
		tags: ["'", ";", "%", "_", "한글"],
		body: "본문 ' ; % _ 한글",
	});
	store.createNew(input);
	const found = store.read("special");
	assert.equal(found.title, input.title);
	assert.equal(found.description, input.description);
	assert.deepEqual(found.tags, input.tags);
	assert.equal(found.body, input.body);
	store.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

test("test_store_contract_rejects_parent_escape_slug", () => eachStore("escape", (store) => {
	for (const slug of ["../escape", "..\\escape", "/absolute", "C:\\absolute"])
		assert.throws(() => store.createNew(record(slug)), /slug/i);
}));

test("test_store_contract_roundtrips_all_memory_fields", () => eachStore("roundtrip", (store) => {
	const full = record("all-fields", {
		description: "",
		tags: ["a", "b"],
		links: ["x", "y"],
		derivedFrom: ["d1", "d2"],
		history: ["h1", "h2"],
		source: "source",
		project: "project",
		reviewAfter: "2026-12-31",
		supersedes: "old",
		supersededBy: "new",
		archiveReason: "reason",
	});
	store.createNew(full);
	assert.deepEqual(store.read(full.slug), full);
}));

test("test_store_contract_preserves_child_order", () => eachStore("order", (store) => {
	/** @type {any} */
	const input = record("ordered", {
		tags: ["z", "a", "m"],
		links: ["third", "first", "second"],
		derivedFrom: ["d3", "d1", "d2"],
		history: ["h3", "h1", "h2"],
	});
	store.createNew(input);
	const found = store.read(input.slug);
	assert.deepEqual([found.tags, found.links, found.derivedFrom, found.history], [input.tags, input.links, Object(input).derivedFrom, input.history]);
}));

test("test_store_contract_filters_before_limit_in_both_backends", () => eachStore("filter-limit", (store) => {
	store.createNew(record("a-wrong", { type: "preference", title: "needle", body: "needle" }));
	store.createNew(record("b-right", { type: "semantic", title: "needle", body: "needle" }));
	const service = new MemoryService(store);
	const result = service.searchDetailed("needle", { type: "semantic", limit: 1 });
	assert.deepEqual(result.results.map((r) => r.record.slug), ["b-right"]);
}));

test("test_store_service_list_orders_updated_desc_then_slug", () => eachStore("list-order", (store) => {
	store.createNew(record("z-last"));
	store.createNew(record("a-first"));
	const service = new MemoryService(store);
	assert.deepEqual(service.list().map((m) => m.slug), ["a-first", "z-last"]);
}));

test("test_store_contract_enforces_slug_retry_limit", () => eachStore("slug-limit", (store) => {
	for (let n = 1; n < 1000; n++) store.createNew(record(n === 1 ? "taken" : `taken-${n}`));
	assert.throws(() => store.createNew(record("taken")), /1000|slug/i);
}));

test("test_store_contract_keeps_latest_three_revisions", () => eachStore("revisions", (store) => {
	store.createNew(record("revision"));
	for (let n = 0; n < 4; n++) {
		store.snapshotRevision("revision", false);
		store.write(record("revision", { body: `generation ${n}` }));
	}
	assert.equal(store.listRevisions("revision").length, 3);
}));

test("test_store_contract_archives_without_duplicate_active_copy", () => eachStore("archive", (store) => {
	store.createNew(record("archived"));
	store.moveToArchive("archived");
	assert.equal(store.read("archived", false), null);
	assert.equal(store.read("archived", true)?.slug, "archived");
	assert.deepEqual(store.listSlugs(true), [{ slug: "archived", archived: true }]);
}));

test("test_sqlite_artifacts_never_appear_as_memories", () => {
	const dir = temp("artifacts");
	const store = new stores.SqliteStore(dir);
	store.createNew(record("real-memory"));
	fs.writeFileSync(`${store.databasePath}-journal`, "journal");
	assert.deepEqual(store.listSlugs(true), [{ slug: "real-memory", archived: false }]);
	store.close();
	assert.deepEqual(new Vault(dir).listSlugs(true), []);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("test_sqlite_uses_delete_journal_without_wal_files", () => {
	const dir = temp("delete-journal");
	const store = new stores.SqliteStore(dir);
	assert.equal(store.journalMode(), "delete");
	store.createNew(record("one"));
	assert.equal(fs.existsSync(`${store.databasePath}-wal`), false);
	assert.equal(fs.existsSync(`${store.databasePath}-shm`), false);
	store.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

test("test_sqlite_multi_process_writes_without_loss_or_busy", async () => {
	const result = await verifyConcurrentWrites();
	assert.equal(result.count, 80);
	assert.ok(result.outcomes.every((outcome) => outcome.code === 0), JSON.stringify(result.outcomes));
	assert.ok(result.outcomes.every((outcome) => !/SQLITE_BUSY/.test(outcome.stderr)), JSON.stringify(result.outcomes));
	const collision = await verifyConcurrentSlugAllocation();
	assert.ok(collision.outcomes.every((outcome) => Object(outcome).code === 0 && !/SQLITE_BUSY/.test(Object(outcome).stderr)), JSON.stringify(collision.outcomes));
	assert.deepEqual(collision.records.map((item) => item.body).sort(), ["worker 0", "worker 1", "worker 2", "worker 3"]);
});

test("test_sqlite_integrity_after_concurrent_writes", async () => {
	assert.equal((await verifyConcurrentWrites()).integrity, "ok");
});

test("test_sqlite_recovers_hot_journal_after_killed_writer", async () => {
	assert.deepEqual(await verifyHotJournalRecovery(), { title: "stable", integrity: "ok" });
});

test("test_sqlite_lexical_cache_refreshes_after_external_commit", () => {
	const dir = temp("external-commit");
	const a = new stores.SqliteStore(dir);
	const service = new MemoryService(a);
	assert.equal(service.search("external needle").length, 0);
	const b = new stores.SqliteStore(dir);
	b.createNew(record("external", { title: "external needle", body: "external needle" }));
	b.close();
	assert.deepEqual(service.search("external needle").map((r) => r.record.slug), ["external"]);
	a.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

test("test_sqlite_hook_reads_persisted_index_without_markdown_files", () => {
	const dir = temp("sqlite-hook-index");
	const store = new stores.SqliteStore(dir);
	const service = new MemoryService(store);
	service.remember({ title: "zirconium deployment", content: "zirconium deployment procedure", type: "procedural" });
	service.retriever.sync(store);
	store.close();
	const child = spawnSync(process.execPath, [path.join(root, "scripts", "session-guard.mjs"), "--prompt", "--vault-force", dir], {
		cwd: root,
		input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "sqlite-hook", prompt: "zirconium deployment procedure" }),
		encoding: "utf8",
		env: { ...process.env, ASTRONRAG_VAULT: dir, ASTRONRAG_SQLITE_PATH: path.join(dir, ".bbm", "store.sqlite"), ASTRONRAG_STORE: "sqlite", ASTRONRAG_AUTO_RECALL: "1", ASTRONRAG_AUTO_MIN_SCORE: "0" },
	});
	assert.equal(child.status, 0);
	assert.match(child.stdout, /<astronrag-auto-recall/);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("test_embedding_cache_recovers_from_invalid_row", () => {
	const dir = temp("invalid-embedding");
	const store = new stores.SqliteStore(dir);
	store.replaceEmbeddings("model", [{ key: "m:one", hash: "bad", vector: new Float32Array([1, 2]) }]);
	assert.deepEqual(store.loadEmbeddings("model", 3), []);
	store.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

test("test_store_embeddings_replace_stale_rows_and_reload", () => eachStore("embeddings", (store) => {
	store.replaceEmbeddings("model", [
		{ key: "m:one", hash: "h1", vector: new Float32Array([1, 0]) },
		{ key: "m:stale", hash: "h2", vector: new Float32Array([0, 1]) },
	]);
	store.replaceEmbeddings("model", [{ key: "m:one", hash: "h3", vector: new Float32Array([0.5, 0.5]) }]);
	const rows = store.loadEmbeddings("model", 2);
	assert.deepEqual(rows.map((r) => r.key), ["m:one"]);
	assert.deepEqual([...rows[0].vector], [0.5, 0.5]);
	store.replaceEmbeddings("model", []);
	assert.deepEqual(store.loadEmbeddings("model", 2), []);
}));

test("test_store_close_releases_sqlite_file", () => {
	const dir = temp("close");
	const store = new stores.SqliteStore(dir);
	store.createNew(record("one"));
	const moved = `${store.databasePath}.moved`;
	store.close();
	fs.renameSync(store.databasePath, moved);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("test_sqlite_permission_error_does_not_fallback_to_file", () => {
	const dir = temp("permission");
	const parentFile = path.join(dir, "not-a-directory");
	fs.writeFileSync(parentFile, "x");
	assert.throws(() => stores.createMemoryStore(dir, { ASTRONRAG_STORE: "sqlite", ASTRONRAG_SQLITE_PATH: path.join(parentFile, "store.sqlite") }));
	assert.deepEqual(new Vault(dir).listSlugs(true), []);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("test_sqlite_does_not_persist_environment_credentials", () => {
	const dir = temp("secret");
	const secret = `secret-${Date.now()}-credential`;
	process.env.ASTRONRAG_TEST_SECRET = secret;
	const store = new stores.SqliteStore(dir);
	store.setMeta("safe", "value");
	store.close();
	assert.equal(fs.readFileSync(path.join(dir, ".bbm", "store.sqlite")).includes(Buffer.from(secret)), false);
	delete process.env.ASTRONRAG_TEST_SECRET;
	fs.rmSync(dir, { recursive: true, force: true });
});

test("test_sqlite_native_memory_origin_preserves_index", () => {
	const dir = temp("native-index");
	const fp = path.join(dir, "MEMORY.md");
	fs.writeFileSync(fp, "native\n");
	fs.writeFileSync(path.join(dir, "native-note.md"), "---\nnode_type: memory\n---\nnative\n");
	const store = new stores.SqliteStore(dir);
	store.writeIndex("replacement\n");
	assert.equal(fs.readFileSync(fp, "utf8"), "native\n");
	store.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

test("test_sqlite_does_not_implicitly_import_file_vault", () => {
	const dir = temp("no-import");
	new Vault(dir).createNew(record("legacy"));
	const store = new stores.SqliteStore(dir);
	assert.deepEqual(store.listSlugs(true), []);
	store.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

test("test_sqlite_empty_database_with_legacy_markdown_blocks_memory_tools_only", async () => {
	await withSqliteMcp("migration-guard", (dir) => {
		new Vault(dir).createNew(record("legacy"));
	}, async (client) => {
		/** @type {[string, Record<string, unknown>][]} */
		const calls = [
			["recall", { query: "legacy" }],
			["remember", { title: "new", content: "new", type: "semantic" }],
			["revise", { id: "legacy", reason: "test" }],
			["forget", { id: "legacy", reason: "test" }],
			["link", { source: "legacy", target: "other" }],
			["reflect", {}],
			["list_memories", {}],
			["read_memory", { id: "legacy" }],
		];
		for (const [name, args] of calls) {
			const result = await client.callTool({ name, arguments: args });
			assert.equal(result.isError, true, String(name));
			assert.match(result.content?.[0]?.text ?? "", /이관 필요: migrate 도구 실행 또는 ASTRONRAG_STORE=file 로 되돌리기/, String(name));
		}
		const recommended = await client.callTool({ name: "recommend", arguments: { description: "구현", role: "impl" } });
		assert.notEqual(recommended.isError, true);
	});
});

test("test_sqlite_empty_database_without_legacy_markdown_starts_normally", async () => {
	await withSqliteMcp("migration-empty", () => {}, async (client) => {
		const listed = await client.callTool({ name: "list_memories", arguments: {} });
		assert.notEqual(listed.isError, true);
		const remembered = await client.callTool({ name: "remember", arguments: { title: "first", content: "first", type: "semantic" } });
		assert.notEqual(remembered.isError, true);
	});
});

test("test_sqlite_valid_migration_marker_disables_legacy_markdown_guard", async () => {
	await withSqliteMcp("migration-complete", (dir) => {
		new Vault(dir).createNew(record("legacy"));
		const store = new stores.SqliteStore(dir);
		store.setMeta("vault_import_completed_at", "2026-10-19T08:00:00.000Z");
		store.close();
	}, async (client) => {
		const listed = await client.callTool({ name: "list_memories", arguments: {} });
		assert.notEqual(listed.isError, true);
	});
});

test("test_sqlite_invalid_migration_marker_keeps_legacy_markdown_guard", async () => {
	await withSqliteMcp("migration-invalid", (dir) => {
		new Vault(dir).createNew(record("legacy"));
		const store = new stores.SqliteStore(dir);
		store.setMeta("vault_import_completed_at", "not-a-date");
		store.close();
	}, async (client) => {
		const listed = await client.callTool({ name: "list_memories", arguments: {} });
		assert.equal(listed.isError, true);
	});
});

test("test_sqlite_migration_guard_hook_is_silent_and_exits_zero", () => {
	const dir = temp("migration-hook");
	new Vault(dir).createNew(record("legacy"));
	const child = spawnSync(process.execPath, [path.join(root, "scripts", "session-guard.mjs"), "--prompt", "--vault-force", dir], {
		cwd: root,
		input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "migration-hook", prompt: "legacy" }),
		encoding: "utf8",
		env: { ...process.env, ASTRONRAG_VAULT: dir, ASTRONRAG_SQLITE_PATH: path.join(dir, ".bbm", "store.sqlite"), ASTRONRAG_STORE: "sqlite", ASTRONRAG_AUTO_RECALL: "1" },
	});
	assert.equal(child.status, 0);
	assert.equal(child.stdout, "");
	assert.equal(child.stderr.trim().split(/\r?\n/).length, 1, child.stderr);
	assert.match(child.stderr, /이관 필요: migrate 도구 실행 또는 ASTRONRAG_STORE=file 로 되돌리기/);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("test_store_usage_events_omit_query_text_by_default", () => eachStore("usage", (store) => {
	store.appendUsageEvent({ tool: "recall", ok: true, queryLen: 12 });
	const text = JSON.stringify(store.readUsageEvents());
	assert.match(text, /queryLen/);
	assert.doesNotMatch(text, /queryText|credential|password/i);
}));

test("test_store_usage_events_default_undefined_timestamp_in_both_backends", () => eachStore("usage-ts", (store, _dir, kind) => {
	store.appendUsageEvent({ tool: "hook", ok: true, ts: undefined });
	const [event] = store.readUsageEvents();
	assert.equal(Number.isNaN(Date.parse(event.ts)), false, `${kind}: ${JSON.stringify(event)}`);
}));

test("test_file_store_usage_report_since_excludes_old_hook_event", () => {
	const dir = temp("usage-since-file");
	const store = new stores.FileStore(dir);
	const toISOString = Date.prototype.toISOString;
	try {
		Date.prototype.toISOString = () => "2025-01-01T00:00:00.000Z";
		store.appendUsageEvent({ tool: "hook", ok: true, ts: undefined });
	} finally {
		Date.prototype.toISOString = toISOString;
		store.close();
	}
	const child = spawnSync(process.execPath, [path.join(root, "scripts", "usage-report.mjs"), "--vault", dir, "--since", "2026-01-01", "--json"], {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, ASTRONRAG_VAULT: dir, ASTRONRAG_SQLITE_PATH: path.join(dir, ".bbm", "store.sqlite"), ASTRONRAG_STORE: "file" },
	});
	assert.equal(child.status, 0, child.stderr);
	assert.equal(JSON.parse(child.stdout).window.events, 0, child.stdout);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("test_node_sqlite_warning_never_uses_stdout", () => {
	const child = spawnSync(process.execPath, ["-e", "import('node:sqlite').then(()=>console.log('sqlite-ok'))"], { encoding: "utf8" });
	assert.equal(child.status, 0);
	assert.equal(child.stdout, "sqlite-ok\n");
	assert.equal(/ExperimentalWarning/.test(child.stdout), false);
});

test("test_hook_failure_keeps_stdout_empty_with_sqlite_store", () => {
	const dir = temp("hook-failure");
	const parentFile = path.join(dir, "not-a-directory");
	fs.writeFileSync(parentFile, "x");
	const child = spawnSync(process.execPath, [path.join(root, "scripts", "session-guard.mjs")], {
		cwd: root,
		input: "{}",
		encoding: "utf8",
		env: { ...process.env, ASTRONRAG_VAULT: dir, ASTRONRAG_STORE: "sqlite", ASTRONRAG_SQLITE_PATH: path.join(parentFile, "store.sqlite") },
	});
	assert.equal(child.stdout, "");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("test_mcp_tools_and_recommend_schema_match_for_both_stores", () => eachStore("schema", (store) => {
	const service = new MemoryService(store);
	const remembered = service.remember({ title: "schema", content: "schema", type: "semantic" });
	assert.deepEqual(Object.keys(remembered).sort(), ["contradictions", "dangling", "record", "similar"]);
	assert.deepEqual(Object.keys(service.searchDetailed("schema")).sort(), ["results", "totalMatched"]);
}));

test("test_spacing_clock_reproduces_read_then_recall_gate", () => eachStore("spacing-clock", (store) => {
	let now = Date.parse("2026-01-01T16:00:00.000Z");
	const service = new MemoryService(store, undefined, () => now);
	const made = service.remember({ title: "clock needle", content: "clock needle", type: "semantic" }).record;
	const local = new Date(now);
	const expectedDay = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
	assert.ok(made.history[0].startsWith(expectedDay));
	now += 86_400_000;
	service.read(made.slug);
	const afterRead = service.resolve(made.slug).record.storageStrength;
	service.search("clock needle");
	assert.equal(service.resolve(made.slug).record.storageStrength, afterRead);
}));

test("test_smoke_active_recall_strength_uses_nonreinforcing_baseline", () => eachStore("smoke-baseline", (store) => {
	let now = Date.parse("2026-01-01T00:00:00.000Z");
	const service = new MemoryService(store, undefined, () => now);
	const made = service.remember({ title: "baseline needle", content: "baseline needle", type: "semantic" }).record;
	const baseline = service.list().find((m) => m.slug === made.slug).storageStrength;
	now += 86_400_000;
	service.search("baseline needle");
	assert.ok(service.list().find((m) => m.slug === made.slug).storageStrength > baseline);
}));

const USAGE_MAX_ENV = "ASTRONRAG_USAGE_LOG_MAX_BYTES";
const usageEvent = (n) => ({ tool: "usage_cap", ok: true, n, reason: "x".repeat(60) });

/** 상한 환경변수를 지정한 채 실행하고 원래 값으로 되돌린다. */
async function withUsageMax(value, run) {
	const before = process.env[USAGE_MAX_ENV];
	if (value === undefined) delete process.env[USAGE_MAX_ENV];
	else process.env[USAGE_MAX_ENV] = value;
	try {
		return await run();
	} finally {
		if (before === undefined) delete process.env[USAGE_MAX_ENV];
		else process.env[USAGE_MAX_ENV] = before;
	}
}

/** SQLite usage_events 의 페이로드 바이트 합과 행 수·최대 sequence 를 읽는다. */
function sqliteUsageStats(dir) {
	const db = new DatabaseSync(path.join(dir, ".bbm", "store.sqlite"));
	try {
		return db.prepare("SELECT COALESCE(SUM(LENGTH(CAST(payload AS BLOB))), 0) AS bytes, COUNT(*) AS count, COALESCE(MAX(sequence), 0) AS maxSequence FROM usage_events").get();
	} finally {
		db.close();
	}
}

test("test_usage_max_bytes_env_parses_alias_and_rejects_invalid_values", async () => {
	const { usageLogMaxBytes } = await import(distUrl("env.js"));
	assert.equal(usageLogMaxBytes({}), 5242880);
	for (const bad of ["", " ", "0", "-5", "1.5", "abc", "1e3", "0x10", "99999999999999999999"]) {
		assert.equal(usageLogMaxBytes({ [USAGE_MAX_ENV]: bad }), 5242880, JSON.stringify(bad));
	}
	assert.equal(usageLogMaxBytes({ [USAGE_MAX_ENV]: "2000" }), 2000);
	assert.equal(usageLogMaxBytes({ BIGBRAIN_USAGE_LOG_MAX_BYTES: "3000" }), 3000);
	assert.equal(usageLogMaxBytes({ [USAGE_MAX_ENV]: "2000", BIGBRAIN_USAGE_LOG_MAX_BYTES: "3000" }), 2000);
});

test("test_sqlite_usage_env_trims_oldest_rows_and_keeps_newest_in_order", () => withUsageMax("2000", () => {
	const dir = temp("usage-trim");
	const store = new stores.SqliteStore(dir);
	try {
		for (let n = 0; n < 192; n++) store.appendUsageEvent(usageEvent(n));
		const stats = sqliteUsageStats(dir);
		assert.ok(stats.bytes <= 2000, JSON.stringify(stats));
		assert.ok(stats.count > 0, JSON.stringify(stats));
		const ns = store.readUsageEvents().map((e) => e.n);
		assert.equal(ns.at(-1), 191);
		assert.ok(ns[0] > 0, `oldest rows must be trimmed: ${ns[0]}`);
		assert.deepEqual(ns, Array.from({ length: ns.length }, (_, i) => 192 - ns.length + i));
	} finally {
		store.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
}));

test("test_sqlite_usage_trim_always_keeps_newest_row_when_single_row_exceeds_limit", () => withUsageMax("10", () => {
	const dir = temp("usage-trim-one");
	const store = new stores.SqliteStore(dir);
	try {
		for (let n = 0; n < 64; n++) store.appendUsageEvent(usageEvent(n));
		assert.deepEqual(store.readUsageEvents().map((e) => e.n), [63]);
	} finally {
		store.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
}));

const sizedUsageEvent = (n, size) => ({ tool: "usage_cap", ok: true, n, reason: "x".repeat(size) });

/** 시드 고정 의사난수(0 이상 1 미만)를 돌려주는 함수를 만든다. */
function seededRandom(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** 행 크기 목록대로 삽입하며 정리 간격(64건) 직후마다 보존 바이트를 모아 돌려준다. */
function fillUsageSizes(limit, sizes) {
	return withUsageMax(String(limit), () => {
		const dir = temp("usage-approx");
		const store = new stores.SqliteStore(dir);
		try {
			const snapshots = Array();
			sizes.forEach((size, i) => {
				store.appendUsageEvent(sizedUsageEvent(i, size));
				if ((i + 1) % 64 === 0) snapshots.push({ inserted: i + 1, ...sqliteUsageStats(dir) });
			});
			return snapshots;
		} finally {
			store.close();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
}

test("test_sqlite_usage_trim_deletes_by_pk_range_without_full_table_scan", () => withUsageMax("2000", () => {
	const dir = temp("usage-trim-sql");
	const store = new stores.SqliteStore(dir);
	const issued = Array();
	const original = DatabaseSync.prototype.prepare;
	DatabaseSync.prototype.prepare = function (sql) {
		issued.push(String(sql));
		return original.call(this, sql);
	};
	try {
		for (let n = 0; n < 128; n++) store.appendUsageEvent(usageEvent(n));
	} finally {
		DatabaseSync.prototype.prepare = original;
		store.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
	const trims = issued.filter((sql) => /DELETE\s+FROM\s+usage_events/i.test(sql));
	assert.ok(trims.length > 0, "trim DELETE must be issued");
	for (const sql of trims) assert.match(sql, /^\s*DELETE\s+FROM\s+usage_events\s+WHERE\s+sequence\s*<=\s*\?\s*$/i, sql);
	assert.equal(issued.filter((sql) => /OVER\s*\(|SUM\s*\(/i.test(sql) && /usage_events/i.test(sql)).length, 0, "no whole-table window sum");
}));

test("test_sqlite_usage_trim_uniform_rows_error_within_two_rows", async () => {
	const limit = 20000;
	const snapshots = await fillUsageSizes(limit, Array.from({ length: 640 }, () => 100));
	const rowBytes = Math.round(snapshots.at(-1).bytes / snapshots.at(-1).count);
	const steady = snapshots.filter((s) => s.inserted > 256);
	assert.ok(steady.length > 0);
	for (const s of steady) {
		assert.ok(s.bytes <= limit, `uniform overshoot ${JSON.stringify(s)}`);
		assert.ok(s.bytes >= limit - 2 * rowBytes, `uniform undershoot ${JSON.stringify(s)} row=${rowBytes}`);
	}
});

test("test_sqlite_usage_trim_mixed_row_sizes_error_within_bound", async () => {
	const limit = 200000;
	for (const seed of [1, 2, 3]) {
		const random = seededRandom(seed);
		const sizes = Array.from({ length: 1536 }, () => (random() < 0.3 ? 2000 : 100));
		const snapshots = await fillUsageSizes(limit, sizes);
		for (const s of snapshots.filter((x) => x.inserted > 768)) {
			assert.ok(s.bytes <= limit * 1.1, `seed ${seed} overshoot ${JSON.stringify(s)}`);
			assert.ok(s.bytes >= limit * 0.7, `seed ${seed} undershoot ${JSON.stringify(s)}`);
		}
	}
});

test("test_sqlite_usage_trim_large_to_small_phase_shift_does_not_exceed_limit", async () => {
	const limit = 200000;
	const sizes = [...Array.from({ length: 512 }, () => 2000), ...Array.from({ length: 1536 }, () => 100)];
	const snapshots = await fillUsageSizes(limit, sizes);
	for (const s of snapshots.filter((x) => x.inserted > 256)) assert.ok(s.bytes <= limit * 1.05, `phase shift overshoot ${JSON.stringify(s)}`);
	assert.ok(snapshots.at(-1).bytes >= limit * 0.7, `settles near limit ${JSON.stringify(snapshots.at(-1))}`);
});

test("test_sqlite_usage_trim_small_to_large_phase_shift_overshoot_is_transient", async () => {
	const limit = 200000;
	const sizes = [...Array.from({ length: 1536 }, () => 100), ...Array.from({ length: 512 }, () => 2000)];
	const snapshots = await fillUsageSizes(limit, sizes);
	for (const s of snapshots.filter((x) => x.inserted > 256)) assert.ok(s.bytes <= limit * 1.5, `phase shift overshoot ${JSON.stringify(s)}`);
	assert.ok(snapshots.at(-1).bytes <= limit * 1.1 && snapshots.at(-1).bytes >= limit * 0.7, `settles near limit ${JSON.stringify(snapshots.at(-1))}`);
});

test("test_sqlite_usage_trim_mixed_rows_below_limit_deletes_nothing", async () => {
	const limit = 800000;
	const random = seededRandom(9);
	const sizes = Array.from({ length: 640 }, () => (random() < 0.3 ? 2000 : 100));
	const snapshots = await fillUsageSizes(limit, sizes);
	assert.ok(snapshots.at(-1).bytes < limit * 0.7, `fixture must stay well below limit ${JSON.stringify(snapshots.at(-1))}`);
	assert.equal(snapshots.at(-1).count, 640, JSON.stringify(snapshots.at(-1)));
});

test("test_usage_below_limit_deletes_nothing_in_both_backends", () => withUsageMax("1000000", () => eachStore("usage-below", (store, dir, kind) => {
	for (let n = 0; n < 160; n++) store.appendUsageEvent(usageEvent(n));
	assert.equal(store.readUsageEvents().length, 160, kind);
	if (kind === "file") assert.equal(fs.existsSync(path.join(dir, ".bbm-usage.jsonl.old")), false);
})));

test("test_usage_invalid_env_values_fall_back_to_default_limit_in_both_backends", async () => {
	for (const bad of [undefined, "", "0", "-5", "1.5", "abc"]) {
		await withUsageMax(bad, () => eachStore("usage-default", (store, dir, kind) => {
			for (let n = 0; n < 160; n++) store.appendUsageEvent(usageEvent(n));
			assert.equal(store.readUsageEvents().length, 160, `${kind} ${JSON.stringify(bad)}`);
			if (kind === "file") assert.equal(fs.existsSync(path.join(dir, ".bbm-usage.jsonl.old")), false);
		}));
	}
});

test("test_file_usage_env_rotates_to_old_file_when_limit_exceeded", () => withUsageMax("1000", () => {
	const dir = temp("usage-rotate");
	const store = new stores.FileStore(dir);
	try {
		for (let n = 0; n < 40; n++) store.appendUsageEvent(usageEvent(n));
		const current = path.join(dir, ".bbm-usage.jsonl");
		assert.equal(fs.existsSync(`${current}.old`), true);
		assert.ok(fs.statSync(current).size <= 1000 + 200, String(fs.statSync(current).size));
		assert.equal(store.readUsageEvents().at(-1).n, 39);
	} finally {
		store.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
}));

test("test_sqlite_usage_trim_concurrent_writers_no_busy_no_lost_inserts", async () => {
	const childCode = `
		import { SqliteStore } from ${JSON.stringify(distUrl("stores/sqlite-store.js"))};
		const [dir, worker] = process.argv.slice(1);
		const store = new SqliteStore(dir);
		try {
			for (let n = 0; n < 48; n++) store.appendUsageEvent({ tool: "usage_cap", ok: true, n, worker, reason: "x".repeat(60) });
			store.close();
		} catch (error) { console.error(error.code, error.message); process.exit(1); }
	`;
	for (const limit of [undefined, "4000"]) {
		await withUsageMax(limit, async () => {
			const dir = temp("usage-concurrent");
			new stores.SqliteStore(dir).close();
			const outcomes = await Promise.all(Array.from({ length: 4 }, (_, worker) => new Promise((resolve) => {
				const child = spawn(process.execPath, ["--input-type=module", "-e", childCode, dir, String(worker)], { env: process.env });
				let stderr = "";
				child.stderr.on("data", (chunk) => { stderr += chunk; });
				child.on("close", (code) => resolve({ code, stderr }));
			})));
			for (const outcome of outcomes) {
				assert.equal(outcome.code, 0, JSON.stringify(outcome));
				assert.doesNotMatch(outcome.stderr, /SQLITE_BUSY|database is locked|ERR_SQLITE/i, outcome.stderr);
			}
			const stats = sqliteUsageStats(dir);
			assert.equal(stats.maxSequence, 192, JSON.stringify(stats));
			if (limit === undefined) assert.equal(stats.count, 192, JSON.stringify(stats));
			else assert.ok(stats.bytes <= 4000 * 1.1 && stats.count > 0, JSON.stringify(stats));
			fs.rmSync(dir, { recursive: true, force: true });
		});
	}
});

let failed = 0;
for (const { name, run } of tests) {
	try {
		await run();
		console.log(`ok - ${name}`);
	} catch (error) {
		failed++;
		console.error(`not ok - ${name}`);
		console.error(error instanceof Error ? error.stack : String(error));
	}
}

if (failed > 0) {
	console.error(`${failed}/${tests.length} store contract tests failed`);
	process.exit(1);
}
console.log(`${tests.length} store contract tests passed`);
