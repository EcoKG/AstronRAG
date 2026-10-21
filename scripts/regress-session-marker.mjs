#!/usr/bin/env node
// 세션 marker의 격리·실패 내성·읽기 전용 계약을 임시 볼트에서 검증한다.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

for (const key of Object.keys(process.env)) {
	if (/^(?:ASTRONRAG_|BIGBRAIN_|BBM_)/.test(key)) delete process.env[key];
}
const root = path.resolve(import.meta.dirname, "..");
const guard = path.join(root, "scripts", "session-guard.mjs");
const { FileStore, SqliteStore } = await import(pathToFileURL(path.join(root, "dist", "stores", "index.js")).href);
const { MemoryService } = await import(pathToFileURL(path.join(root, "dist", "store.js")).href);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bbm-session-marker-"));
const home = path.join(temp, "home");
fs.mkdirSync(home);
const DAY = 86_400_000;
const query = "zirconium synthetic deployment procedure";
const tests = new Array();
const test = (name, run) => tests.push({ name, run });
const hash = (id) => createHash("sha256").update(id, "utf8").digest("hex");
const directory = (vault) => path.join(vault, ".bbm", "sessions");
const marker = (vault, id = "A") => path.join(directory(vault), `${hash(id)}.json`);
const read = (vault, id = "A") => JSON.parse(fs.readFileSync(marker(vault, id), "utf8"));

// 합성 기억과 검색 인덱스만 있는 새 임시 볼트를 만든다.
function fixture({ sqlite = false, memories = 1 } = {}) {
	const vault = fs.mkdtempSync(path.join(temp, "vault-"));
	const store = sqlite ? new SqliteStore(vault) : new FileStore(vault);
	const service = new MemoryService(store);
	for (let n = 0; n < memories; n++) {
		service.remember({ title: `zirconium synthetic ${n}`, content: `${query} fixture ${n}`, description: query, type: "procedural" });
	}
	service.retriever.sync(store);
	store.close();
	return vault;
}

// 상속된 볼트·store·별칭 설정 대신 해당 fixture만 자식에 전달한다.
function childEnv(vault, extra = {}) {
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:ASTRONRAG_|BIGBRAIN_|BBM_)/.test(key)));
	return {
		...env, HOME: home, USERPROFILE: home, ASTRONRAG_VAULT: vault, BIGBRAIN_VAULT: vault,
		ASTRONRAG_STORE: "file", ASTRONRAG_SQLITE_PATH: path.join(vault, ".bbm", "store.sqlite"),
		ASTRONRAG_AUTO_RECALL: "1", ASTRONRAG_AUTO_MIN_SCORE: "0", ASTRONRAG_STOP_MIN_TOOLS: "0", ...extra,
	};
}

// 실제 훅을 실행하고 종료 코드와 stdout을 검증한다.
function run(vault, mode, id = "A", options = Object()) {
	const input = options.raw ?? JSON.stringify({ session_id: id, source: options.source ?? "startup", prompt: options.prompt ?? query });
	const args = [...(options.preload ? ["--import", pathToFileURL(options.preload).href] : []), guard, `--${mode}`, "--vault-force", vault];
	const result = spawnSync(process.execPath, args, { cwd: vault, input, encoding: "utf8", timeout: 15000, env: childEnv(vault, options.env) });
	assert.equal(result.error, undefined);
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

// 파일 내용과 디렉터리 목록을 기록해 숨김 경로까지 비교한다.
function snapshot(vault) {
	const entries = {};
	const visit = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			const relative = path.relative(vault, file).split(path.sep).join("/");
			if (entry.isDirectory()) { entries[`${relative}/`] = null; visit(file); }
			else if (entry.isFile()) entries[relative] = `${fs.statSync(file).mtimeMs}:${fs.readFileSync(file).toString("base64")}`;
			else entries[relative] = "link";
		}
	};
	visit(vault);
	return entries;
}

// marker 파일의 테스트 상태를 지정한다.
function put(vault, id, value) {
	fs.mkdirSync(directory(vault), { recursive: true });
	fs.writeFileSync(marker(vault, id), typeof value === "string" ? value : JSON.stringify(value));
}

// 지정 파일 연산의 접근 기록·실패·시각을 자식 프로세스에 주입한다.
function preload(vault, { operation = "", code = "EACCES", match = "sessions", now = Number.NaN, interrupt = false, audit = false, failures = 1000000 } = {}) {
	const file = path.join(temp, `preload-${tests.length}-${Math.random().toString(16).slice(2)}.mjs`);
	const log = `${file}.jsonl`;
	fs.writeFileSync(file, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const originalAppend = fs.appendFileSync;
const vault = ${JSON.stringify(vault)};
const matcher = ${JSON.stringify(match ?? "sessions")};
const audit = ${audit};
let remaining = ${failures};
for (const name of ['readFileSync','writeFileSync','mkdirSync','renameSync','unlinkSync','readdirSync','statSync','lstatSync','existsSync']) {
	const original = fs[name];
	fs[name] = function (...args) {
		const target = String(args[0]);
		const owned = target.startsWith(vault) && (target.includes('sessions') || target.includes('.bbm-session-start'));
		if (audit && owned) originalAppend(${JSON.stringify(log)}, JSON.stringify({ name, target }) + '\\n');
		if (name === ${JSON.stringify(operation)} && target.startsWith(vault) && target.includes(matcher) && remaining-- > 0) {
			${interrupt ? "const value = original.apply(this, args); process.exit(0); return value;" : `const error = new Error('synthetic filesystem failure'); error.code = ${JSON.stringify(code ?? "EACCES")}; throw error;`}
		}
		try { return original.apply(this, args); }
		catch (error) {
			if (audit && owned) originalAppend(${JSON.stringify(log)}, JSON.stringify({ name, error: error.code }) + '\\n');
			throw error;
		}
	};
}
${Number.isFinite(now) ? `Date.now = () => ${now};` : ""}
syncBuiltinESMExports();
`);
	return { file, log };
}

// 병렬 호출도 모든 자식이 종료된 후 결과를 확인한다.
function parallel(vault, mode, id, extraEnv = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [guard, `--${mode}`, "--vault-force", vault], { cwd: vault, env: childEnv(vault, extraEnv) });
		let stderr = "";
		child.stdout.resume();
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", (status) => { try { assert.equal(status, 0, stderr); resolve(undefined); } catch (error) { reject(error); } });
		child.stdin.end(JSON.stringify({ session_id: id, source: "startup", prompt: query }));
	});
}

test("test_marker_invalid_hook_input_is_untracked", () => {
	const vault = fixture();
	const before = snapshot(vault);
	for (const raw of ["{", "null", "[]", "42", '{"session_id":42}']) {
		for (const mode of ["start", "prompt", "stop"]) run(vault, mode, "A", { raw });
	}
	assert.deepEqual(snapshot(vault), before);
});

test("test_marker_empty_id_never_accesses_markers", () => {
	const vault = fixture();
	const probe = preload(vault, { audit: true });
	const before = snapshot(vault);
	for (const id of [undefined, null, "", " \t\n"]) {
		for (const mode of ["start", "prompt", "stop"]) {
			run(vault, mode, "A", { raw: JSON.stringify({ session_id: id, prompt: query }), preload: probe.file });
		}
	}
	assert.deepEqual(snapshot(vault), before);
	assert.equal(fs.existsSync(probe.log), false, "marker access count must be zero");
});

test("test_marker_hostile_ids_stay_inside_session_directory", () => {
	const vault = fixture();
	const sentinel = path.join(temp, "sentinel");
	fs.writeFileSync(sentinel, "synthetic sentinel");
	const ids = ["../sentinel", "../../escape", "a/b\\c", "CON", "NUL", "AUX", "COM1", "LPT9", "\u0000\r\n"];
	for (const id of ids) { run(vault, "start", id); assert.equal(read(vault, id).sessionId, id); }
	assert.deepEqual(fs.readdirSync(directory(vault)).sort(), ids.map((id) => `${hash(id)}.json`).sort());
	assert.equal(fs.readFileSync(sentinel, "utf8"), "synthetic sentinel");
	assert.equal(fs.existsSync(path.join(temp, "escape")), false);
});

test("test_marker_long_unicode_ids_have_stable_distinct_paths", () => {
	const vault = fixture();
	const ids = ["x".repeat(20000), "한글😀", "é", "e\u0301", "CASE", "case", " case "];
	for (const id of ids) {
		run(vault, "start", id);
		const first = read(vault, id);
		run(vault, "start", id, { source: "resume" });
		assert.equal(read(vault, id).startedAt, first.startedAt);
		assert.equal(read(vault, id).sessionId, id);
	}
	assert.equal(fs.readdirSync(directory(vault)).length, ids.length);
});

test("test_marker_invalid_payload_is_untracked", () => {
	const vault = fixture();
	for (const value of ["{", "1", "[]", "null", { count: 1 }, { sessionId: "B", count: 1 }, { sessionId: "A", count: -1 }, { sessionId: "A", count: "1" }, { sessionId: "A", count: 1.5 }]) {
		put(vault, "A", value);
		const before = snapshot(vault);
		delete before[".bbm-usage.jsonl"];
		run(vault, "prompt");
		assert.equal(run(vault, "stop"), "");
		const after = snapshot(vault);
		delete after[".bbm-usage.jsonl"];
		assert.deepEqual(after, before);
	}
});

test("test_marker_rejects_foreign_session_identity", () => {
	const vault = fixture();
	run(vault, "start", "B");
	put(vault, "A", fs.readFileSync(marker(vault, "B"), "utf8"));
	const before = snapshot(vault);
	delete before[".bbm-usage.jsonl"];
	assert.match(run(vault, "prompt", "A"), /astronrag-auto-recall/);
	assert.equal(run(vault, "stop", "A"), "");
	const after = snapshot(vault);
	delete after[".bbm-usage.jsonl"];
	assert.deepEqual(after, before);
});

test("test_marker_prompt_without_start_creates_no_files", () => {
	const vault = fixture();
	const before = snapshot(vault);
	const stdout = run(vault, "prompt", "astron:unstarted");
	assert.match(stdout, /astronrag-auto-recall/);
	assert.doesNotMatch(stdout, /astronrag-cue/);
	const after = snapshot(vault);
	const added = Object.keys(after).filter((key) => !(key in before));
	const changed = Object.keys(before).filter((key) => after[key] !== before[key]);
	assert.deepEqual(added, [".bbm-usage.jsonl"]);
	assert.deepEqual(changed, []);
	const events = new FileStore(vault).readUsageEvents();
	assert.equal(events.length, 1);
	assert.equal(events[0].tool, "auto_recall");
	assert.equal(JSON.stringify(events).includes(query), false);
	assert.equal(fs.existsSync(path.join(vault, ".bbm-session-start")), false);
	assert.equal(fs.existsSync(directory(vault)), false);
	assert.equal(run(vault, "prompt", "astron:unstarted"), stdout);
	console.log("markerFiles=0 legacyMarker=0 newFilesOutsideUsage=0 firstPromptUsageEvents=1 contentFields=0");
});

test("test_marker_sqlite_prompt_without_start_is_read_only", () => {
	const vault = fixture({ sqlite: true });
	const before = snapshot(vault);
	const options = { env: { ASTRONRAG_STORE: "sqlite" } };
	assert.match(run(vault, "prompt", "unstarted", options), /astronrag-auto-recall/);
	assert.equal(run(vault, "stop", "unstarted", options), "");
	const after = snapshot(vault);
	assert.deepEqual(Object.keys(after), Object.keys(before));
	assert.deepEqual(Object.keys(before).filter(key => after[key] !== before[key]), [".bbm/store.sqlite"]);
	const store = new SqliteStore(vault, undefined, { readOnly: true });
	try { assert.equal(store.readUsageEvents().filter(event => event.tool === "auto_recall").length, 1); }
	finally { store.close(); }
	assert.equal(fs.existsSync(directory(vault)), false);
});

test("test_marker_legacy_file_is_ignored_until_next_start", () => {
	for (const raw of ["1", JSON.stringify({ sessionId: "A", count: 1, total: 1 })]) {
		const vault = fixture();
		const legacy = path.join(vault, ".bbm-session-start");
		fs.writeFileSync(legacy, raw);
		const before = snapshot(vault);
		assert.match(run(vault, "prompt"), /astronrag-auto-recall/);
		assert.equal(run(vault, "stop"), "");
		const after = snapshot(vault);
		delete after[".bbm-usage.jsonl"];
		assert.deepEqual(after, before);
		run(vault, "start");
		assert.equal(read(vault).count, 1);
		assert.equal(fs.readFileSync(legacy, "utf8"), raw);
	}
});

test("test_marker_interleaved_sessions_keep_independent_state", () => {
	const vault = fixture();
	run(vault, "start", "A");
	run(vault, "prompt", "A", { prompt: `${query} actually instead` });
	const a = read(vault);
	assert.equal(a.cued, true);
	const store = new FileStore(vault);
	new MemoryService(store).remember({ title: "synthetic second", content: "unrelated synthetic memory", type: "semantic" });
	store.close();
	run(vault, "start", "B");
	run(vault, "prompt", "B");
	assert.equal(run(vault, "stop", "A"), "");
	assert.match(run(vault, "stop", "B"), /stored 0/);
	assert.equal(read(vault, "A").count, 1);
	assert.equal(read(vault, "B").count, 2);
	assert.equal(read(vault, "A").turns, 1);
	assert.equal(read(vault, "B").turns, 1);
	assert.equal(read(vault, "A").warned, false);
	assert.equal(read(vault, "B").warned, true);
	assert.equal(read(vault, "B").cued, false);
	assert.deepEqual(read(vault, "A").autoSlugs, a.autoSlugs);
	assert.equal(read(vault, "A").lastCueTurn, a.lastCueTurn);
});

test("test_marker_second_start_preserves_first_session_dedup", () => {
	const vault = fixture();
	run(vault, "start");
	assert.match(run(vault, "prompt"), /astronrag-auto-recall/);
	const a = read(vault);
	run(vault, "start", "B");
	assert.doesNotMatch(run(vault, "prompt"), /astronrag-auto-recall/);
	assert.deepEqual(read(vault).autoSlugs, a.autoSlugs);
	assert.equal(read(vault).turns, 2);
});

test("test_marker_repeated_start_preserves_baseline_and_compact_scope", () => {
	const vault = fixture();
	run(vault, "start"); run(vault, "prompt");
	run(vault, "start", "B"); run(vault, "prompt", "B");
	const first = read(vault);
	const b = read(vault, "B");
	for (const source of ["startup", "resume", "clear", "compact"]) {
		run(vault, "start", "A", { source });
		assert.equal(read(vault).count, first.count);
		assert.equal(read(vault).startedAt, first.startedAt);
	}
	assert.deepEqual(read(vault).autoSlugs, []);
	assert.deepEqual(read(vault, "B"), b);
});

test("test_marker_auto_slugs_keep_existing_limit_and_order", () => {
	const vault = fixture();
	run(vault, "start");
	const prior = Array.from({ length: 200 }, (_, n) => `synthetic-${n}`);
	put(vault, "A", { ...read(vault), autoSlugs: prior });
	run(vault, "prompt");
	const slugs = read(vault).autoSlugs;
	assert.equal(slugs.length, 200);
	assert.deepEqual(slugs.slice(0, 199), prior.slice(1));
	assert.equal(slugs[199].startsWith("synthetic-"), false);
});

test("test_marker_hook_output_shape_and_order_are_preserved", () => {
	const vault = fixture();
	run(vault, "start");
	const prompt = JSON.parse(run(vault, "prompt", "A", { prompt: `${query} actually instead` }));
	assert.deepEqual(Object.keys(prompt), ["hookSpecificOutput"]);
	assert.equal(prompt.hookSpecificOutput.hookEventName, "UserPromptSubmit");
	const context = prompt.hookSpecificOutput.additionalContext;
	assert.ok(context.indexOf("</astronrag-auto-recall>") < context.indexOf("<astronrag-cue"));
	const stop = JSON.parse(run(vault, "stop"));
	assert.equal(stop.hookSpecificOutput.hookEventName, "Stop");
	assert.equal(typeof stop.hookSpecificOutput.additionalContext, "string");
	assert.equal("decision" in stop, false);
});

test("test_marker_loss_detection_uses_latest_session_start", () => {
	const vault = fixture({ memories: 3 });
	run(vault, "start");
	const names = fs.readdirSync(path.join(vault, "memories")).filter((name) => name.endsWith(".md"));
	fs.mkdirSync(path.join(vault, "archive"), { recursive: true });
	fs.renameSync(path.join(vault, "memories", names[0]), path.join(vault, "archive", names[0]));
	assert.doesNotMatch(run(vault, "start", "B"), /MEMORY LOSS/);
	fs.unlinkSync(path.join(vault, "archive", names[0]));
	assert.match(run(vault, "start", "C"), /MEMORY LOSS/);
	assert.doesNotMatch(run(vault, "start", "D"), /MEMORY LOSS/);
	for (const name of names.slice(1)) fs.unlinkSync(path.join(vault, "memories", name));
	assert.match(run(vault, "start", "E"), /MEMORY LOSS/);
	assert.doesNotMatch(run(vault, "start", "F"), /MEMORY LOSS/);
});

test("test_marker_loss_baseline_selection_is_deterministic", () => {
	const vault = fixture();
	const now = Date.now();
	const ids = ["candidate-one", "candidate-two"].sort((a, b) => hash(a).localeCompare(hash(b)));
	put(vault, ids[0], { sessionId: ids[0], count: 1, total: 8, startedAt: now });
	put(vault, ids[1], { sessionId: ids[1], count: 1, total: 3, startedAt: now });
	put(vault, "bad", "{");
	put(vault, "missing-total", { sessionId: "missing-total", count: 1, startedAt: now + 10 });
	const stdout = run(vault, "start", "new");
	assert.match(stdout, /vault held 8 memories/);
	assert.doesNotMatch(run(vault, "start", "next"), /MEMORY LOSS/);
});

test("test_marker_cleanup_obeys_seven_day_boundary", () => {
	const vault = fixture();
	const now = Date.now();
	const ages = [{ id: "before", age: 7 * DAY - 1 }, { id: "exact", age: 7 * DAY }, { id: "after", age: 7 * DAY + 1 }];
	for (const { id, age } of ages) {
		put(vault, id, { sessionId: id, count: 1 });
		fs.utimesSync(marker(vault, id), new Date(now - age), new Date(now - age));
	}
	const probe = preload(vault, { now });
	run(vault, "start", "fresh", { preload: probe.file });
	assert.equal(fs.existsSync(marker(vault, "before")), true);
	assert.equal(fs.existsSync(marker(vault, "exact")), true);
	assert.equal(fs.existsSync(marker(vault, "after")), false);
});

test("test_marker_cleanup_only_removes_owned_regular_files", () => {
	const vault = fixture();
	put(vault, "old", { sessionId: "old", count: 1 });
	const owned = marker(vault, "old");
	const expired = new Date(Date.now() - 8 * DAY);
	const ownedTemp = path.join(directory(vault), `.${hash("old")}.123.0123456789abcdef.tmp`);
	const keep = [path.join(directory(vault), "notes.json"), path.join(directory(vault), ".unknown.tmp"), path.join(vault, ".bbm", "store.sqlite"), path.join(vault, ".bbm-session-start")];
	for (const file of [...keep, ownedTemp]) { fs.writeFileSync(file, "synthetic"); fs.utimesSync(file, expired, expired); }
	const nested = path.join(directory(vault), `${hash("nested")}.json`);
	fs.mkdirSync(nested);
	const external = fs.mkdtempSync(path.join(temp, "cleanup-external-"));
	const linked = path.join(directory(vault), `${hash("linked")}.json`);
	fs.symlinkSync(external, linked, process.platform === "win32" ? "junction" : "dir");
	fs.utimesSync(nested, expired, expired);
	fs.utimesSync(owned, expired, expired);
	run(vault, "start", "fresh");
	assert.equal(fs.existsSync(owned), false);
	assert.equal(fs.existsSync(ownedTemp), false);
	for (const file of [...keep, nested, linked]) assert.equal(fs.existsSync(file), true);
});

test("test_marker_cleanup_errors_do_not_fail_hook", () => {
	for (const operation of ["readdirSync", "lstatSync", "unlinkSync"]) {
		for (const code of ["EACCES", "EPERM", "EBUSY"]) {
			const vault = fixture();
			put(vault, "old", { sessionId: "old", count: 1 });
			const expired = new Date(Date.now() - 8 * DAY);
			fs.utimesSync(marker(vault, "old"), expired, expired);
			const probe = preload(vault, { operation, code, match: operation === "lstatSync" ? hash("old") : "sessions" });
			run(vault, "start", "fresh", { preload: probe.file });
			assert.equal(read(vault, "fresh").sessionId, "fresh");
			assert.equal(fs.existsSync(marker(vault, "old")), true);
		}
	}
});

test("test_marker_links_cannot_redirect_marker_access", () => {
	for (const component of [".bbm", "sessions", "marker", "marker-junction"]) {
		const vault = fixture({ memories: 0 });
		const outside = fs.mkdtempSync(path.join(temp, "outside-"));
		const sentinel = path.join(outside, "sentinel");
		fs.writeFileSync(sentinel, "synthetic external sentinel");
		const target = component === ".bbm" ? path.join(vault, ".bbm") : component === "sessions" ? directory(vault) : marker(vault);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		if (component === "marker") {
			// Windows의 파일 symlink 권한 없이도 hard link의 외부 파일 보호를 검증한다.
			fs.linkSync(sentinel, target);
		} else fs.symlinkSync(outside, target, process.platform === "win32" ? "junction" : "dir");
		const before = snapshot(outside);
		for (const mode of ["prompt", "stop", "start"]) run(vault, mode);
		assert.deepEqual(snapshot(outside), before);
		assert.equal(fs.readFileSync(sentinel, "utf8"), "synthetic external sentinel");
	}
});

test("test_marker_write_failures_preserve_previous_json", () => {
	for (const operation of ["mkdirSync", "writeFileSync", "renameSync"]) {
		const vault = fixture();
		run(vault, "start");
		const before = fs.readFileSync(marker(vault), "utf8");
		const probe = preload(vault, { operation, match: "sessions", code: "EACCES" });
		run(vault, "prompt", "A", { preload: probe.file });
		assert.equal(fs.readFileSync(marker(vault), "utf8"), before);
		assert.equal(fs.readdirSync(directory(vault)).some((name) => name.endsWith(".tmp")), false);
	}
	for (const code of ["EPERM", "EBUSY"]) {
		const vault = fixture();
		run(vault, "start");
		const probe = preload(vault, { operation: "renameSync", code, failures: 5 });
		run(vault, "prompt", "A", { preload: probe.file });
		assert.equal(read(vault).turns, 1, `transient ${code} must recover`);
	}
});

test("test_marker_windows_rename_conflicts_exit_zero", () => {
	for (const code of ["EPERM", "EBUSY"]) {
		const vault = fixture();
		run(vault, "start");
		const before = fs.readFileSync(marker(vault), "utf8");
		const probe = preload(vault, { operation: "renameSync", code, audit: true });
		run(vault, "prompt", "A", { preload: probe.file });
		assert.equal(fs.readFileSync(marker(vault), "utf8"), before);
		const calls = fs.readFileSync(probe.log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(calls.some((call) => call.name === "renameSync"), true);
		assert.equal(calls.some((call) => call.name === "unlinkSync" && call.target.endsWith(".json")), false);
		assert.equal(calls.some((call) => call.name === "unlinkSync" && call.target.endsWith(".tmp")), true);
		assert.equal(fs.readdirSync(directory(vault)).some((name) => name.endsWith(".tmp")), false);
	}
});

test("test_marker_interrupted_write_recovers_and_expires_temp", () => {
	const vault = fixture();
	run(vault, "start");
	const before = fs.readFileSync(marker(vault), "utf8");
	const probe = preload(vault, { operation: "writeFileSync", match: ".tmp", interrupt: true });
	run(vault, "prompt", "A", { preload: probe.file });
	assert.equal(fs.readFileSync(marker(vault), "utf8"), before);
	const abandoned = fs.readdirSync(directory(vault)).filter((name) => name.endsWith(".tmp"));
	assert.equal(abandoned.length, 1);
	run(vault, "prompt");
	assert.equal(read(vault).turns, 1);
	const expired = new Date(Date.now() - 8 * DAY);
	fs.utimesSync(path.join(directory(vault), abandoned[0]), expired, expired);
	run(vault, "start", "fresh");
	assert.equal(fs.existsSync(path.join(directory(vault), abandoned[0])), false);
});

test("test_marker_sequential_prompts_preserve_updates", () => {
	const vault = fixture();
	run(vault, "start");
	const baseline = read(vault);
	for (let n = 0; n < 10; n++) run(vault, "prompt");
	assert.equal(read(vault).turns, 10);
	assert.equal(read(vault).count, baseline.count);
	assert.equal(read(vault).startedAt, baseline.startedAt);
	assert.equal(read(vault).autoSlugs.length, 1);
});

test("test_marker_same_session_parallel_writes_keep_valid_json", async () => {
	const vault = fixture();
	run(vault, "start");
	let reads = 0;
	let invalid = 0;
	const errors = new Array();
	const probe = preload(vault, { audit: true });
	const reader = setInterval(() => {
		reads++;
		try { JSON.parse(fs.readFileSync(marker(vault), "utf8")); }
		catch (error) { invalid++; errors.push({ code: error.code, message: error.message }); }
	}, 1);
	try { await Promise.all(Array.from({ length: 10 }, () => parallel(vault, "prompt", "A", { NODE_OPTIONS: `--import=${pathToFileURL(probe.file).href}` }))); }
	finally { clearInterval(reader); }
	const operations = fs.readFileSync(probe.log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const conflicts = operations.filter((operation) => operation.name === "renameSync" && operation.error).length;
	console.log(`parallelRenameConflicts=${conflicts}`);
	assert.ok(reads > 0);
	assert.equal(invalid, 0, JSON.stringify(errors));
	assert.ok(read(vault).turns >= 1 && read(vault).turns <= 10, JSON.stringify(read(vault)));
	assert.equal(read(vault).autoSlugs.length, 1);
	console.log(`sameSessionProcesses=10 readerSamples=${reads} invalidJson=${invalid}`);
});

test("test_marker_distinct_sessions_parallel_keep_isolation", async () => {
	const vault = fixture();
	const ids = Array.from({ length: 10 }, (_, n) => `parallel-${n}`);
	await Promise.all(ids.map((id) => parallel(vault, "start", id)));
	await Promise.all(ids.map((id) => parallel(vault, "prompt", id)));
	await Promise.all(ids.map((id) => parallel(vault, "stop", id)));
	assert.equal(fs.readdirSync(directory(vault)).length, 10);
	for (const id of ids) {
		const value = read(vault, id);
		assert.equal(value.sessionId, id);
		assert.equal(value.turns, 1);
		assert.equal(value.warned, true);
		assert.equal(value.autoSlugs.length, 1);
	}
	console.log("distinctSessionProcesses=10 files=10 invalidJson=0");
});

test("test_marker_untracked_prompt_never_repairs_search_cache", () => {
	for (const bad of [false, true]) {
		const vault = fixture();
		const index = path.join(vault, ".bbm-index");
		if (bad) {
			for (const name of fs.readdirSync(index)) fs.writeFileSync(path.join(index, name), "broken synthetic cache");
		} else fs.rmSync(index, { recursive: true });
		for (const damagedMarker of [false, true]) {
			if (damagedMarker) put(vault, "A", "{");
			const before = snapshot(vault);
			delete before[".bbm-usage.jsonl"];
			run(vault, "prompt");
			const after = snapshot(vault);
			delete after[".bbm-usage.jsonl"];
			assert.deepEqual(after, before);
		}
	}
});

test("test_marker_usage_logging_requires_tracking_and_omits_content", () => {
	const vault = fixture();
	const usage = path.join(vault, ".bbm-usage.jsonl");
	const before = snapshot(vault);
	run(vault, "prompt");
	const after = snapshot(vault);
	delete after[".bbm-usage.jsonl"];
	assert.deepEqual(after, before);
	assert.equal(new FileStore(vault).readUsageEvents().filter(event => event.tool === "auto_recall").length, 1);
	run(vault, "start");
	run(vault, "prompt");
	const raw = fs.readFileSync(usage, "utf8");
	const events = raw.trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(events.filter(event => event.tool === "auto_recall").length, 2);
	assert.ok(events.some((event) => event.tool === "auto_recall" && event.injected === 1 && Number.isFinite(event.topScore)));
	assert.equal(raw.includes(query), false);
	assert.equal(raw.includes("fixture 0"), false);
});

test("test_marker_test_children_override_inherited_vault_settings", () => {
	const vault = fixture();
	const sentinel = fixture();
	const before = snapshot(sentinel);
	const saved = { ...process.env };
	try {
		for (const prefix of ["ASTRONRAG", "BIGBRAIN", "BBM"]) {
			process.env[`${prefix}_VAULT`] = sentinel;
			process.env[`${prefix}_SQLITE_PATH`] = path.join(sentinel, "outside.sqlite");
		}
		process.env.ASTRONRAG_STORE = "sqlite";
		run(vault, "start"); run(vault, "prompt"); run(vault, "stop");
		assert.equal(read(vault).sessionId, "A");
		assert.deepEqual(snapshot(sentinel), before);
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
	}
});

test("test_marker_session_files_are_excluded_from_memory_operations", async () => {
	const vault = fixture();
	run(vault, "start");
	const before = snapshot(directory(vault));
	const fileStore = new FileStore(vault);
	const service = new MemoryService(fileStore);
	assert.equal(service.loadAll().length, 1);
	assert.equal(fileStore.listSlugs(true).length, 1);
	service.reflect();
	const memory = service.loadAll()[0];
	assert.ok(service.forget(memory.slug, "synthetic archive test"));
	fileStore.close();
	const db = path.join(vault, ".bbm", "store.sqlite");
	const migrate = spawnSync(process.execPath, [path.join(root, "scripts", "migrate-vault-to-store.mjs"), "--vault", vault, "--store-path", db], { env: childEnv(vault), encoding: "utf8", timeout: 15000 });
	assert.equal(migrate.status, 0, migrate.stderr || migrate.stdout);
	const sqlite = new SqliteStore(vault, db, { readOnly: true });
	assert.equal(sqlite.exportVaultSnapshot().records.length, 1);
	sqlite.close();
	const { exportStoreToVault } = await import("./export-store-to-vault.mjs");
	const out = path.join(temp, "export-vault");
	exportStoreToVault({ cwd: temp, storePath: db, out, env: childEnv(vault) });
	assert.equal(fs.existsSync(directory(out)), false);
	const viewer = path.join(temp, "viewer-data.js");
	const result = spawnSync(process.execPath, [path.join(root, "scripts", "export-viewer-data.mjs"), viewer], { env: childEnv(vault), encoding: "utf8", timeout: 15000 });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(fs.readFileSync(viewer, "utf8").includes(hash("A")), false);
	assert.deepEqual(snapshot(directory(vault)), before);
});

let passed = 0;
let failed = 0;
const selectedName = process.argv[2];
try {
	for (const { name, run: execute } of tests) {
		if (selectedName && name !== selectedName) continue;
		try { await execute(); passed++; console.log(`PASS ${name}`); }
		catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
	}
} finally {
	const resolved = path.resolve(temp);
	assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
	fs.rmSync(resolved, { recursive: true, force: true });
}
console.log(`session-marker: ${passed} passed, ${failed} failed, ${tests.length - passed - failed} skipped`);
process.exitCode = failed || passed === 0 ? 1 : 0;
