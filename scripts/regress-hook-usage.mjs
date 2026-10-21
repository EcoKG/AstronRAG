#!/usr/bin/env node
// 격리된 볼트에서 훅 usage의 기록·실패 내성·병렬 쓰기를 검증한다.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

for (const key of Object.keys(process.env)) if (/^(ASTRONRAG_|BIGBRAIN_|BBM_)/.test(key)) delete process.env[key];
const root = path.resolve(import.meta.dirname, "..");
fs.mkdirSync(path.join(root, ".astron-logs"), { recursive: true });
const temp = fs.mkdtempSync(path.join(root, ".astron-logs", "hook-usage-"));
const home = path.join(temp, "home");
fs.mkdirSync(home);
Object.assign(process.env, { HOME: home, USERPROFILE: home, ASTRONRAG_VAULT: temp });
const { FileStore, SqliteStore } = await import("../dist/stores/index.js");
const { MemoryService } = await import("../dist/store.js");
const { DatabaseSync } = await import("node:sqlite");
const query = "zirconium synthetic deployment procedure";
const tests = new Array();
const test = (name, run) => tests.push({ name, run });

test("test_hook_usage_write_timeout_constant_within_150ms", () => {
	const source = fs.readFileSync(path.join(root, "scripts/session-guard.mjs"), "utf8");
	const definitions = [...source.matchAll(/^const USAGE_WRITE_TIMEOUT_MS\s*=/gm)];
	assert.equal(definitions.length, 1, "usage write timeout must have exactly one constant definition");
	const value = source.match(/^const USAGE_WRITE_TIMEOUT_MS = (\d+);$/m);
	assert.ok(value, "usage write timeout must be a numeric literal");
	const timeoutMs = Number(value[1]);
	assert.ok(timeoutMs > 0 && timeoutMs <= 150, `configured usage write budget <=150ms, actual ms=${timeoutMs}`);
	assert.match(source, /selectedStore\?\.appendUsageEvent\([^\n]+\{ timeoutMs: USAGE_WRITE_TIMEOUT_MS, throwOnError: true \}\);/);
});

// 합성 기억과 검색 인덱스를 만들고 모든 초기 연결을 닫는다.
function fixture(kind) {
	const vault = fs.mkdtempSync(path.join(temp, `${kind}-`));
	const store = kind === "sqlite" ? new SqliteStore(vault) : new FileStore(vault);
	const service = new MemoryService(store);
	service.remember({ title: "zirconium synthetic", content: query, description: query, type: "procedural" });
	service.retriever.sync(store);
	store.close();
	return vault;
}

// 프로세스마다 운영 환경 별칭을 제거하고 임시 HOME과 볼트를 강제한다.
function env(vault, kind, extra = {}) {
	return {
		...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ASTRONRAG_|BIGBRAIN_|BBM_)/.test(key))),
		HOME: home, USERPROFILE: home, ASTRONRAG_VAULT: vault, ASTRONRAG_STORE: kind,
		ASTRONRAG_SQLITE_PATH: path.join(vault, ".bbm", "store.sqlite"),
		ASTRONRAG_AUTO_RECALL: "1", ASTRONRAG_AUTO_MIN_SCORE: "0", ...extra,
	};
}

// 실제 훅의 종료 코드·JSON·stderr와 끝단 시간을 수집한다.
async function hook(vault, kind, id, options = Object()) {
	const { mode = "prompt", preload, extra } = options;
	const result = { code: -1, stdout: "", stderr: "", ms: 0 };
	await new Promise((resolve, reject) => {
		const args = ["--disable-warning=ExperimentalWarning", ...(preload ? ["--import", pathToFileURL(preload).href] : []), path.join(root, "scripts/session-guard.mjs"), `--${mode}`, "--vault-force", vault];
		const started = performance.now();
		const child = spawn(process.execPath, args, { cwd: vault, env: env(vault, kind, extra), timeout: 10000 });
		child.stdout.on("data", value => { result.stdout += value; });
		child.stderr.on("data", value => { result.stderr += value; });
		child.on("error", reject);
		child.on("close", code => { result.code = code ?? -1; result.ms = performance.now() - started; resolve(undefined); });
		child.stdin.end(JSON.stringify({ session_id: id, source: "startup", prompt: query }));
	});
	return result;
}

// 원시 SQLite usage_events 조회와 file store 조회를 같은 이벤트 목록으로 반환한다.
function events(vault, kind) {
	const store = kind === "sqlite" ? new SqliteStore(vault, undefined, { readOnly: true }) : new FileStore(vault, { readOnly: true });
	try { return store.readUsageEvents(); }
	finally { store.close(); }
}

// 회상 JSON과 내용 없는 이벤트의 허용 필드만 확인한다.
function assertRecall(result) {
	assert.equal(result.code, 0, result.stderr);
	const json = JSON.parse(result.stdout);
	assert.equal(json.hookSpecificOutput.hookEventName, "UserPromptSubmit");
	assert.match(json.hookSpecificOutput.additionalContext, /astronrag-auto-recall/);
}

for (const kind of ["sqlite", "file"]) {
	for (const tracked of [true, false]) test(`test_hook_usage_${kind}_${tracked ? "tracked" : "astron_untracked"}_omits_content`, async () => {
		const vault = fixture(kind);
		const id = tracked ? "claude-synthetic" : "astron:synthetic";
		if (tracked) assert.equal((await hook(vault, kind, id, { mode: "start" })).code, 0);
		const result = await hook(vault, kind, id);
		assertRecall(result);
		assert.equal(result.stderr, "");
		const rows = events(vault, kind).filter(event => event.tool === "auto_recall");
		assert.equal(rows.length, 1);
		assert.equal(rows[0].sessionId, id);
		assert.equal(rows[0].injected, 1);
		assert.ok(Number.isFinite(rows[0].topScore));
		assert.deepEqual(Object.keys(rows[0]).sort(), ["injected", "sessionId", "src", "tool", "topScore", "ts"].sort());
		if (!tracked) {
			assert.equal(fs.existsSync(path.join(vault, ".bbm/sessions")), false);
			assert.equal(fs.existsSync(path.join(vault, ".bbm-session-start")), false);
		}
		if (kind === "sqlite") {
			const db = new DatabaseSync(path.join(vault, ".bbm", "store.sqlite"), { readOnly: true });
			const sql = "SELECT ts, payload FROM usage_events WHERE json_extract(payload, '$.tool') = 'auto_recall' ORDER BY sequence";
			try { console.log(JSON.stringify({ kind, tracked, sql, rows: db.prepare(sql).all() })); }
			finally { db.close(); }
		} else console.log(JSON.stringify({ kind, tracked, file: ".bbm-usage.jsonl", rows }));
	});

	test(`test_hook_usage_${kind}_empty_id_and_disabled_are_zero`, async () => {
		const vault = fixture(kind);
		for (const id of [undefined, "", " \t\n"]) assertRecall(await hook(vault, kind, id));
		assertRecall(await hook(vault, kind, "disabled", { extra: { ASTRONRAG_USAGE_LOG: "0" } }));
		assert.equal(events(vault, kind).length, 0);
		console.log(JSON.stringify({ kind, emptyAndDisabledRows: 0 }));
	});

	test(`test_hook_usage_${kind}_write_failure_exit_zero_json_stderr_one_line`, async () => {
		const vault = fixture(kind);
		const preload = path.join(vault, "deny.mjs");
		fs.writeFileSync(preload, `import fs from 'node:fs';\nimport { DatabaseSync } from 'node:sqlite';\nconst failure = () => { const error = new Error('synthetic sensitive query\\nprivate path'); error.code = 'EACCES'; throw error; };\nconst append = fs.appendFileSync; fs.appendFileSync = function(file, ...args) { if (String(file).endsWith('.bbm-usage.jsonl')) return failure(); return append.call(this, file, ...args); };\nconst prepare = DatabaseSync.prototype.prepare; DatabaseSync.prototype.prepare = function(sql) { if (sql.startsWith('INSERT INTO usage_events')) return failure(); return prepare.call(this, sql); };\n`);
		const result = await hook(vault, kind, "failure", { preload });
		assertRecall(result);
		assert.match(result.stderr, /^astronrag usage: write failed \(EACCES\)\n$/);
		assert.equal(events(vault, kind).length, 0);
		console.log(JSON.stringify({ kind, exitCode: result.code, stderr: result.stderr }));
	});
}

// IPC로 잠금 획득을 확인하고 해제 시점까지 독립 프로세스의 쓰기 잠금을 유지한다.
async function locker(vault) {
	const file = path.join(vault, "locker.mjs");
	fs.writeFileSync(file, `import { DatabaseSync } from 'node:sqlite';\nconst db = new DatabaseSync(process.env.ASTRONRAG_SQLITE_PATH); db.exec('BEGIN IMMEDIATE'); process.send('ready'); process.on('message', () => { db.exec('ROLLBACK'); db.close(); process.exit(0); });\n`);
	const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", file], { cwd: vault, env: env(vault, "sqlite"), timeout: 10000, stdio: ["ignore", "ignore", "pipe", "ipc"] });
	await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); child.once("exit", code => reject(new Error(`locker exited ${code}`))); });
	return child;
}

// 잠금 보유 프로세스가 연결을 닫고 종료할 때까지 기다린다.
async function unlock(child) {
	if (child.exitCode !== null) return;
	await new Promise((resolve, reject) => {
		child.once("close", resolve);
		child.once("error", reject);
		if (child.connected) child.send("release");
	});
}

test("test_hook_usage_sqlite_writer_closes_before_stdout", async () => {
	const vault = fixture("sqlite");
	const preload = path.join(vault, "lifecycle.mjs");
	const audit = path.join(vault, "lifecycle.jsonl");
	fs.writeFileSync(preload, `import fs from 'node:fs'; import { DatabaseSync } from 'node:sqlite'; let writer; const record = value => fs.appendFileSync(${JSON.stringify(audit)}, JSON.stringify(value) + '\\n'); const prepare = DatabaseSync.prototype.prepare; DatabaseSync.prototype.prepare = function(sql) { if (sql.startsWith('INSERT INTO usage_events')) { writer = this; record('insert'); } return prepare.call(this, sql); }; const close = DatabaseSync.prototype.close; DatabaseSync.prototype.close = function() { const value = close.call(this); if (this === writer) record('writerClose'); return value; }; const write = process.stdout.write; process.stdout.write = function(...args) { record('stdout'); return write.apply(this, args); };\n`);
	assertRecall(await hook(vault, "sqlite", "lifecycle", { preload }));
	assert.deepEqual(fs.readFileSync(audit, "utf8").trim().split("\n").map(line => JSON.parse(line)), ["insert", "writerClose", "stdout"]);
});

test("test_hook_usage_sqlite_busy_bounded_exit_zero_json_stderr_one_line", async () => {
	const vault = fixture("sqlite");
	const audit = path.join(vault, "busy.jsonl");
	const preload = path.join(vault, "busy-audit.mjs");
	fs.writeFileSync(preload, `import fs from 'node:fs';
import { SqliteStore } from ${JSON.stringify(pathToFileURL(path.join(root, "dist/stores/index.js")).href)};
const append = SqliteStore.prototype.appendUsageEvent;
SqliteStore.prototype.appendUsageEvent = function(...args) {
	const started = performance.now();
	try { return append.apply(this, args); }
	catch (error) {
		const ms = performance.now() - started;
		fs.appendFileSync(${JSON.stringify(audit)}, JSON.stringify({ code: error.code, errcode: error.errcode, ms }) + '\\n');
		throw error;
	}
};
`);
	const child = await locker(vault);
	try {
		const result = await hook(vault, "sqlite", "busy", { preload });
		assertRecall(result);
		assert.match(result.stderr, /^astronrag usage: write failed \(ERR_SQLITE_ERROR\)\n$/);
		assert.equal(child.exitCode, null, "locker must hold the write lock throughout the hook");
		assert.equal(child.connected, true);
		const failures = fs.readFileSync(audit, "utf8").trim().split("\n").map(line => JSON.parse(line));
		assert.equal(failures.length, 1, "measure exactly one failed usage append");
		const failure = failures[0];
		console.log(JSON.stringify({ busyMs: result.ms, usageWriteMs: failure.ms, exitCode: result.code, stderr: result.stderr }));
		assert.equal(failure.code, "ERR_SQLITE_ERROR");
		assert.ok(failure.errcode === 5 || failure.errcode === 6, "usage append must fail with SQLITE_BUSY or SQLITE_LOCKED");
		assert.ok(Number.isFinite(failure.ms) && failure.ms >= 0 && failure.ms <= 150, `busy usage write budget <=150ms, actual ms=${failure.ms}`);
		assert.ok(result.ms < 1000, `bounded hook ms=${result.ms}`);
		assert.equal(events(vault, "sqlite").length, 0);
	} finally { await unlock(child); }
});

test("test_hook_usage_sqlite_short_busy_retries_and_closes_writer", async () => {
	const vault = fixture("sqlite");
	const child = await locker(vault);
	const preload = path.join(vault, "release.mjs");
	const signal = path.join(vault, "attempt");
	const closed = path.join(vault, "closed");
	fs.writeFileSync(preload, `import fs from 'node:fs'; import { DatabaseSync } from 'node:sqlite'; const writers = new Set(); const prepare = DatabaseSync.prototype.prepare; DatabaseSync.prototype.prepare = function(sql) { if (sql.startsWith('INSERT INTO usage_events')) { writers.add(this); fs.writeFileSync(${JSON.stringify(signal)}, 'ready'); } return prepare.call(this, sql); }; const close = DatabaseSync.prototype.close; DatabaseSync.prototype.close = function() { const result = close.call(this); if (writers.has(this)) fs.appendFileSync(${JSON.stringify(closed)}, 'closed\\n'); return result; };\n`);
	const timer = setInterval(() => { if (fs.existsSync(signal)) { clearInterval(timer); setTimeout(() => { if (child.connected) child.send("release"); }, 20); } }, 2);
	try {
		const result = await hook(vault, "sqlite", "retry", { preload });
		assertRecall(result);
		assert.equal(result.stderr, "");
		assert.equal(events(vault, "sqlite").length, 1);
		assert.ok(fs.readFileSync(closed, "utf8").trim().split("\n").length >= 2, "failed writer must close before retry");
		const next = await locker(vault);
		await unlock(next);
	} finally { clearInterval(timer); await unlock(child); }
});

test("test_hook_usage_sqlite_realistic_writer_low_concurrency_no_loss_no_lock_errors", async () => {
	const vault = fixture("sqlite");
	const file = path.join(vault, "continuous-writer.mjs");
	fs.writeFileSync(file, `import { SqliteStore } from ${JSON.stringify(pathToFileURL(path.join(root, "dist/stores/index.js")).href)}; const store = new SqliteStore(process.env.ASTRONRAG_VAULT); let writes = 0; const timer = setInterval(() => { try { store.appendUsageEvent({ tool: 'synthetic_writer', sessionId: 'continuous-' + writes++ }); } catch (error) { console.error(error.code); process.exitCode = 1; clearInterval(timer); store.close(); process.disconnect(); } }, 20); process.send('ready'); process.on('message', () => { clearInterval(timer); store.close(); process.send({ writes }); process.disconnect(); });\n`);
	const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", file], { cwd: vault, env: env(vault, "sqlite"), timeout: 20000, stdio: ["ignore", "ignore", "pipe", "ipc"] });
	let stderr = "", writes = 0;
	child.stderr?.on("data", value => { stderr += value; });
	child.on("message", message => { if (message && typeof message === "object" && "writes" in message && typeof message.writes === "number") writes = message.writes; });
	const done = new Promise((resolve, reject) => { child.once("close", code => { try { assert.equal(code, 0, stderr); assert.equal(stderr, ""); resolve(undefined); } catch (error) { reject(error); } }); child.once("error", reject); });
	done.catch(() => {});
	const results = new Array();
	try {
		await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); child.once("exit", code => reject(new Error(`writer exited ${code}`))); });
		for (let batch = 0; batch < 6; batch++) results.push(...await Promise.all([0, 1].map(n => hook(vault, "sqlite", `astron:realistic-${batch * 2 + n}`))));
	} finally {
		if (child.connected) child.send("stop");
		await done;
	}
	const rows = events(vault, "sqlite");
	const recalls = rows.filter(row => row.tool === "auto_recall");
	console.log(JSON.stringify({ load: "realistic", writers: 1, writeIntervalMs: 20, maxConcurrentHooks: 2, hooks: results.length, writes, expected: writes + 12, actual: rows.length, lost: writes + 12 - rows.length, lockErrors: results.filter(result => result.stderr.includes("ERR_SQLITE_ERROR")).length }));
	assert.ok(writes > 0);
	for (const result of results) { assertRecall(result); assert.equal(result.stderr, ""); }
	assert.equal(rows.filter(row => row.tool === "synthetic_writer").length, writes);
	assert.equal(recalls.length, 12);
	assert.equal(new Set(recalls.map(row => row.sessionId)).size, 12);
});

test("test_hook_usage_sqlite_high_contention_best_effort_preserves_recall", async () => {
	const vault = fixture("sqlite");
	const audit = path.join(vault, "errors.jsonl");
	const preload = path.join(vault, "audit.mjs");
	fs.writeFileSync(preload, `import fs from 'node:fs'; import { SqliteStore } from ${JSON.stringify(pathToFileURL(path.join(root, "dist/stores/index.js")).href)}; const append = SqliteStore.prototype.appendUsageEvent; SqliteStore.prototype.appendUsageEvent = function(...args) { const started = performance.now(); try { return append.apply(this, args); } catch (error) { fs.appendFileSync(${JSON.stringify(audit)}, JSON.stringify({ code: error.code, errcode: error.errcode, message: error.message, ms: performance.now() - started }) + '\\n'); throw error; } };\n`);
	const file = path.join(vault, "writer.mjs");
	fs.writeFileSync(file, `import { SqliteStore } from ${JSON.stringify(pathToFileURL(path.join(root, "dist/stores/index.js")).href)}; const store = new SqliteStore(process.env.ASTRONRAG_VAULT); process.send('ready'); process.on('message', () => { try { for (let n = 0; n < 20; n++) store.appendUsageEvent({ tool: 'synthetic_writer', sessionId: process.argv[2] }); store.close(); process.exit(0); } catch (error) { console.error(error.code, error.message); process.exit(1); } });\n`);
	const workers = new Array();
	await Promise.all(Array.from({ length: 3 }, (_, n) => new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", file, `writer-${n}`], { cwd: vault, env: env(vault, "sqlite"), timeout: 10000, stdio: ["ignore", "pipe", "pipe", "ipc"] });
		let stderr = "";
		child.stderr?.on("data", value => { stderr += value; });
		const done = new Promise((yes, no) => { child.once("close", code => { try { assert.equal(code, 0, stderr); assert.equal(stderr, ""); yes(undefined); } catch (error) { no(error); } }); });
		done.catch(() => {});
		child.once("error", reject);
		child.once("exit", code => { if (code !== 0) reject(new Error(`writer exited ${code}`)); });
		child.once("message", () => { workers.push({ child, done }); resolve(undefined); });
	})));
	const hooks = Array.from({ length: 12 }, (_, n) => hook(vault, "sqlite", `astron:parallel-${n}`, { preload }));
	workers.forEach(({ child }) => child.send("write"));
	const results = await Promise.all(hooks);
	await Promise.all(workers.map(({ done }) => done));
	const failureLog = fs.existsSync(audit) ? fs.readFileSync(audit, "utf8") : "";
	if (failureLog) console.log(failureLog);
	const failureTimes = failureLog.trim() ? failureLog.trim().split("\n").map(line => JSON.parse(line).ms).sort((a, b) => a - b) : [];
	const middle = Math.floor(failureTimes.length / 2);
	const failedUsageWriteMedianMs = failureTimes.length === 0 ? null : failureTimes.length % 2 ? failureTimes[middle] : (failureTimes[middle - 1] + failureTimes[middle]) / 2;
	const rows = events(vault, "sqlite");
	const recalls = rows.filter(row => row.tool === "auto_recall");
	const lost = 72 - rows.length;
	console.log(JSON.stringify({ load: "high_contention", writers: 3, hooks: 12, expected: 72, actual: rows.length, lost, lossRate: lost / 72, hookLossRate: lost / 12, lockErrors: results.filter(result => result.stderr.includes("ERR_SQLITE_ERROR")).length, failedUsageWrites: failureTimes.length, failedUsageWriteMaxMs: failureTimes.at(-1) ?? null, failedUsageWriteMedianMs }));
	for (const [n, result] of results.entries()) {
		assertRecall(result);
		if (recalls.some(row => row.sessionId === `astron:parallel-${n}`)) assert.equal(result.stderr, "");
		else assert.match(result.stderr, /^astronrag usage: write failed \(ERR_SQLITE_ERROR\)\n$/);
	}
	assert.equal(rows.filter(row => row.tool === "synthetic_writer").length, 60);
	assert.equal(results.filter(result => result.stderr !== "").length, lost);
	assert.equal(failureTimes.length, lost, "measure every failed hook usage append");
	assert.equal(new Set(recalls.map(row => row.sessionId)).size, recalls.length);
});

test("test_trigger_inherited_env_isolated", async () => {
	const vault = fixture("file");
	const result = { code: -1, stdout: "", stderr: "" };
	await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [path.join(root, "scripts/regress-trigger.mjs")], {
			cwd: vault,
			env: env(vault, "file", { ASTRONRAG_INSTRUCTIONS_BUDGET: "100000", BIGBRAIN_INSTRUCTIONS_BUDGET: "100000", BBM_TEST_SENTINEL: "synthetic" }),
			timeout: 60000,
		});
		child.stdout.on("data", value => { result.stdout += value; });
		child.stderr.on("data", value => { result.stderr += value; });
		child.once("error", reject);
		child.once("close", code => { result.code = code ?? -1; resolve(undefined); });
	});
	assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
});

let passed = 0, failed = 0;
try {
	for (const { name, run } of tests) {
		if (process.argv[2] && process.argv[2] !== name) continue;
		try { await run(); passed++; console.log(`PASS ${name}`); }
		catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
	}
} finally {
	assert.ok(path.resolve(temp).startsWith(`${path.join(root, ".astron-logs")}${path.sep}`));
	fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
console.log(`hook-usage: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
