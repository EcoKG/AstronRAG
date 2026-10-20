// 환경 이름 호환과 실제 서버·훅의 이름 전환 계약을 검증한다.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.mkdirSync(path.join(root, ".astron-logs"), { recursive: true });
const scratch = fs.mkdtempSync(path.join(root, ".astron-logs", "env-compat-"));
const moduleUrl = (file) => pathToFileURL(path.join(root, file)).href;
const helpers = [moduleUrl("dist/env.js"), moduleUrl("scripts/lib/env.mjs")];
const storeUrl = moduleUrl("dist/stores/index.js");
const suffixes = ["VAULT", "PROJECT", "SYNONYMS", "INDEX_LIMIT", "STALE_DAYS", "SPACING_MS", "SPACING_ALPHA", "WEAKENED_GRACE_H", "WEAKENED_RATIO", "FLUSH_EVERY_ACCESS", "SCORER", "SHADOW", "ALT_WEIGHT", "VECTOR", "HOOK_CHECK", "INSTRUCTIONS_BUDGET", "ALWAYS_LOAD", "LOG_QUERIES", "USAGE_LOG", "USAGE_LOG_MAX_BYTES", "STOP_MIN_TOOLS", "AUTO_MIN_SCORE", "AUTO_BUDGET", "AUTO_RECALL", "CUE_COOLDOWN", "CUE_TURNS"];
const mappings = [...suffixes.map((s) => [`ASTRONRAG_${s}`, `BIGBRAIN_${s}`]), ...["STORE", "SQLITE_PATH", "ONTOLOGY_PATH"].map((s) => [`ASTRONRAG_${s}`, `BBM_${s}`])];
const warningPattern = /(?:BIGBRAIN|BBM)_[A-Z_]+ 대신 ASTRONRAG_[A-Z_]+ 를 쓰십시오/g;
const warnings = (stderr) => stderr.match(warningPattern) ?? [];
let serial = 0;

function fixture() {
	const dir = path.join(scratch, String(++serial));
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanEnv(extra = {}) {
	return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ASTRONRAG_|BIGBRAIN_|BBM_)/.test(key))), HOME: scratch, USERPROFILE: scratch, ...extra };
}

/** 자식 프로세스의 종료 상태와 출력을 반환한다.
 * @returns {Promise<{status: number | null, stdout: string, stderr: string}>}
 */
async function child(args, { env = {}, cwd = root, input = "" } = {}) {
	const proc = spawn(process.execPath, args, { cwd, env: cleanEnv(env), stdio: ["pipe", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => { proc.kill(); reject(new Error("child timeout")); }, 30000);
		proc.stdout.on("data", (data) => { stdout += data; });
		proc.stderr.on("data", (data) => { stderr += data; });
		proc.on("error", (error) => { clearTimeout(timer); reject(error); });
		proc.on("close", () => { clearTimeout(timer); resolve(null); });
		proc.stdin.end(input);
	});
	return { status: proc.exitCode, stdout, stderr };
}

async function probe(body, env = {}) {
	const result = await child(["--input-type=module", "-e", `import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; ${body}`], { env });
	assert.equal(result.status, 0, result.stderr);
	return result;
}

async function read(helper, env, calls = [["ASTRONRAG_VAULT", "BIGBRAIN_VAULT"]]) {
	const result = await probe(`const {readEnv}=await import(${JSON.stringify(helper)}); const env=${JSON.stringify(env)}; console.log(JSON.stringify(${JSON.stringify(calls)}.map(([n,l])=>readEnv(n,l,env) ?? null)));`);
	return { values: JSON.parse(result.stdout), stderr: result.stderr };
}

async function env_new_name_wins() {
	for (const helper of helpers) {
		const r = await read(helper, { ASTRONRAG_VAULT: "new", BIGBRAIN_VAULT: "old" });
		assert.deepEqual(r.values, ["new"]);
		assert.equal(warnings(r.stderr).length, 0);
	}
	const dir = fixture();
	const r = await probe(`const s=await import(${JSON.stringify(storeUrl)}); const store=s.createMemoryStore(${JSON.stringify(dir)},{ASTRONRAG_STORE:'file',BBM_STORE:'invalid'}); try {assert.ok(store instanceof s.FileStore);} finally {store.close();}`);
	assert.equal(warnings(r.stderr).length, 0);
}

async function env_legacy_fallback() {
	for (const helper of helpers) {
		const r = await read(helper, { BIGBRAIN_VAULT: "legacy-private-value" });
		assert.deepEqual(r.values, ["legacy-private-value"]);
		assert.deepEqual(warnings(r.stderr), ["BIGBRAIN_VAULT 대신 ASTRONRAG_VAULT 를 쓰십시오"]);
		assert.ok(!r.stderr.includes("legacy-private-value"));
	}
}

async function env_warning_once_per_process() {
	for (const order of [helpers, [...helpers].reverse()]) {
		const result = await probe(`for(const url of ${JSON.stringify(order)}) { const {readEnv}=await import(url); for(let i=0;i<3;i++) { assert.equal(readEnv('ASTRONRAG_VAULT','BIGBRAIN_VAULT',{BIGBRAIN_VAULT:'v'}),'v'); assert.equal(readEnv('ASTRONRAG_STORE','BBM_STORE',{BBM_STORE:'file'}),'file'); } }`);
		assert.equal(warnings(result.stderr).length, 1);
	}
}

async function env_warning_resets_in_child() {
	const results = await Promise.all(helpers.map((helper) => read(helper, { BIGBRAIN_VAULT: "legacy" })));
	for (const r of results) assert.equal(warnings(r.stderr).length, 1);
}

async function env_missing_preserves_defaults() {
	for (const helper of helpers) {
		const r = await read(helper, {});
		assert.deepEqual(r.values, [null]);
		assert.equal(warnings(r.stderr).length, 0);
	}
	const dir = fixture();
	const r = await probe(`const s=await import(${JSON.stringify(storeUrl)}); const store=s.createMemoryStore(${JSON.stringify(dir)},{}); try {assert.ok(store instanceof s.SqliteStore); assert.equal(store.databasePath,path.join(${JSON.stringify(dir)},'.bbm','store.sqlite'));} finally {store.close();}`);
	assert.equal(warnings(r.stderr).length, 0);
}

async function env_empty_and_zero_keep_precedence() {
	for (const helper of helpers) {
		for (const value of ["", "0"]) {
			const r = await read(helper, { ASTRONRAG_VAULT: value, BIGBRAIN_VAULT: "old" });
			assert.deepEqual(r.values, [value]);
			assert.equal(warnings(r.stderr).length, 0);
		}
	}
	const dir = fixture();
	await probe(`const s=await import(${JSON.stringify(storeUrl)}); const store=s.createMemoryStore(${JSON.stringify(dir)},{ASTRONRAG_STORE:'',BBM_STORE:'file',ASTRONRAG_SQLITE_PATH:'',BBM_SQLITE_PATH:'wrong.db'}); try {assert.ok(store instanceof s.SqliteStore);assert.equal(store.databasePath,path.join(${JSON.stringify(dir)},'.bbm','store.sqlite'));} finally {store.close();} assert.throws(()=>s.createMemoryStore(${JSON.stringify(dir)},{ASTRONRAG_STORE:'0',BBM_STORE:'file'}));`);
	const vault = fixture();
	await seed(vault, "index-limit-zero-needle");
	for (const value of ["", "0"]) {
		const r = await initialize({ ASTRONRAG_VAULT: vault, ASTRONRAG_STORE: "file", ASTRONRAG_INDEX_LIMIT: value, BIGBRAIN_INDEX_LIMIT: "40" });
		assert.ok(!r.result.instructions.includes("index-limit-zero-needle"));
		assert.equal(warnings(r.stderr).length, 0);
	}
}

async function env_invalid_new_store_rejected() {
	const dir = fixture();
	const r = await probe(`const {createMemoryStore}=await import(${JSON.stringify(storeUrl)}); assert.throws(()=>createMemoryStore(${JSON.stringify(dir)},{ASTRONRAG_STORE:'invalid-new-kind',BBM_STORE:'file'}),/invalid-new-kind/); assert.equal(fs.existsSync(path.join(${JSON.stringify(dir)},'.bbm','store.sqlite')),false);`);
	assert.equal(warnings(r.stderr).length, 0);
}

async function env_explicit_object_compat() {
	const dir = fixture();
	const db = path.join(dir, "한글 custom.sqlite");
	const r = await probe(`const s=await import(${JSON.stringify(storeUrl)}); for(const env of [{ASTRONRAG_STORE:'sqlite',BBM_STORE:'file',ASTRONRAG_SQLITE_PATH:${JSON.stringify(db)},BBM_SQLITE_PATH:'wrong.sqlite'},{BBM_STORE:'sqlite',BBM_SQLITE_PATH:${JSON.stringify(db)}}]) {const store=s.createMemoryStore(${JSON.stringify(dir)},env); try {assert.ok(store instanceof s.SqliteStore);assert.equal(store.databasePath,${JSON.stringify(db)});} finally {store.close();}} const defaults=s.createMemoryStore(${JSON.stringify(dir)},{}); try {assert.ok(defaults instanceof s.SqliteStore);assert.equal(defaults.databasePath,path.join(${JSON.stringify(dir)},'.bbm','store.sqlite'));} finally {defaults.close();}`, { ASTRONRAG_STORE: "invalid-process-value", ASTRONRAG_SQLITE_PATH: "outside.sqlite" });
	assert.equal(warnings(r.stderr).length, 1);
}

async function env_helpers_match() {
	const values = [undefined, "", "0", "  ", "한글 (공백) ' \"\n", "x".repeat(8192)];
	const body = `const mods=await Promise.all(${JSON.stringify(helpers)}.map(url=>import(url))); const mappings=${JSON.stringify(mappings)}; const values=[undefined,...${JSON.stringify(values.slice(1))}]; for(const value of values) { for(const [n,l] of mappings) { for(const env of [{[n]:value,[l]:'fallback'},{[l]:value},{}]) {const expected=env[n]!==undefined?env[n]:env[l]; for(const m of mods) assert.equal(m.readEnv(n,l,env,false),expected);}}} for(const m of mods) {for(const [n,l] of mappings) assert.equal(m.readEnv(n,l,{[n]:'one'},false),'one'); assert.equal(m.readEnv('ASTRONRAG_VAULT','BIGBRAIN_VAULT',{ASTRONRAG_VAULT:'two'},false),'two');}`;
	const r = await probe(body);
	assert.equal(warnings(r.stderr).length, 0);
	for (const helper of helpers) {
		const env = Object.fromEntries(mappings.map(([, legacy]) => [legacy, "private-value"]));
		const r = await read(helper, env, mappings);
		assert.deepEqual(r.values, mappings.map(() => "private-value"));
		assert.equal(warnings(r.stderr).length, 1);
		assert.ok(!r.stderr.includes("private-value"));
	}
}

/** MCP 초기화 응답과 stderr 출력을 반환한다.
 * @returns {Promise<{result: {serverInfo: {name: string}, instructions: string}, stderr: string}>}
 */
async function initialize(env) {
	const proc = spawn(process.execPath, [path.join(root, "dist/index.js")], { cwd: root, env: cleanEnv(env), stdio: ["pipe", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	let complete = false;
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => { proc.kill(); reject(new Error("MCP initialize timeout")); }, 15000);
		proc.stderr.on("data", (data) => { stderr += data; });
		proc.stdout.on("data", (data) => {
			stdout += data;
			if (stdout.includes("\n")) { complete = true; proc.kill(); }
		});
		proc.on("error", (error) => { clearTimeout(timer); reject(error); });
		proc.on("close", () => {
			clearTimeout(timer);
			resolve(null);
		});
		proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "env-compat", version: "1" } } }) + "\n");
	});
	assert.ok(complete, stderr);
	const messages = stdout.trim().split("\n").map((line) => JSON.parse(line));
	const response = messages.find((message) => message.id === 1);
	assert.equal(response?.jsonrpc, "2.0");
	assert.ok(response.result?.serverInfo, stdout);
	return { result: response.result, stderr };
}

async function mcp_legacy_warning_stderr_only() {
	const dir = fixture();
	const r = await initialize({ BIGBRAIN_VAULT: dir, BIGBRAIN_PROJECT: "synthetic-token-value", BBM_STORE: "file" });
	assert.equal(warnings(r.stderr).length, 1);
	const warningLines = r.stderr.split("\n").filter((line) => warnings(line).length);
	for (const line of warningLines) { assert.ok(!line.includes(dir)); assert.ok(!line.includes("synthetic-token-value")); }
}

async function mcp_astronrag_identity() {
	const r = await initialize({ ASTRONRAG_VAULT: fixture(), ASTRONRAG_STORE: "file", ASTRONRAG_HOOK_CHECK: "0" });
	assert.equal(r.result.serverInfo.name, "astronrag");
	assert.match(r.result.instructions, /AstronRAG is a persistent memory vault/);
	assert.equal(warnings(r.stderr).length, 0);
}

async function seed(dir, title, project = "legacy-project") {
	await probe(`const {Vault}=await import(${JSON.stringify(moduleUrl("dist/vault.js"))}); const {MemoryStore}=await import(${JSON.stringify(moduleUrl("dist/store.js"))}); const store=new MemoryStore(new Vault(${JSON.stringify(dir)})); store.remember({title:${JSON.stringify(title)},description:'compat fixture',type:'semantic',content:'unchanged body',project:${JSON.stringify(project)},tags:[]}); store.retriever.sync(store.vault); store.regenerateIndex();`);
}

async function hook(cwd, env, mode = "start") {
	const r = await child([path.join(root, "scripts/session-guard.mjs"), `--${mode}`], { cwd, env, input: JSON.stringify({ session_id: `compat-${++serial}`, source: "startup", prompt: "compat fixture unchanged body needle" }) });
	assert.equal(r.status, 0, r.stderr);
	return r;
}

async function hook_legacy_env_fallback() {
	const dir = fixture();
	const cwd = fixture();
	await seed(dir, "legacy-only-needle");
	await seed(dir, "excluded-project-needle", "other-project");
	for (const configured of [false, true]) {
		const env = { BIGBRAIN_VAULT: dir, BIGBRAIN_PROJECT: "legacy-project", BBM_STORE: "file" };
		if (configured) fs.writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { custom_registered: { command: process.execPath, args: [path.join(root, "dist/index.js")], env } } }));
		const r = await hook(cwd, configured ? { BBM_STORE: "file" } : env);
		assert.match(r.stdout, /legacy-only-needle/);
		assert.match(r.stdout, configured ? /mcp__custom_registered__remember/ : /mcp__astronrag__remember/);
		assert.equal(warnings(r.stderr).length, 1);
		const recall = await hook(cwd, { ...(configured ? { BBM_STORE: "file" } : env), ASTRONRAG_AUTO_RECALL: "1", ASTRONRAG_AUTO_MIN_SCORE: "0" }, "prompt");
		const context = JSON.parse(recall.stdout).hookSpecificOutput.additionalContext;
		assert.match(context, /legacy-only-needle/);
		assert.ok(!context.includes("excluded-project-needle"));
	}
}

async function hook_new_env_wins() {
	const dir = fixture();
	const old = fixture();
	await seed(dir, "new-target-needle", "new-project");
	await seed(dir, "wrong-project-needle", "old-project");
	await seed(old, "wrong-vault-needle", "old-project");
	const conflict = { ASTRONRAG_VAULT: dir, BIGBRAIN_VAULT: old, ASTRONRAG_PROJECT: "new-project", BIGBRAIN_PROJECT: "old-project" };
	for (const configured of [false, true]) {
		const cwd = fixture();
		if (configured) fs.writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { astronrag: { command: process.execPath, args: [path.join(root, "dist/index.js")], env: conflict }, ignored: { env: { BIGBRAIN_VAULT: old } } } }));
		const r = await hook(cwd, { ASTRONRAG_STORE: "file", ...(configured ? {} : conflict) });
		assert.match(r.stdout, /new-target-needle/);
		assert.ok(!r.stdout.includes("wrong-vault-needle"));
		assert.match(r.stdout, /mcp__astronrag__remember/);
		assert.equal(warnings(r.stderr).length, 0);
		const recall = await hook(cwd, { ASTRONRAG_STORE: "file", ...(configured ? {} : conflict), ASTRONRAG_AUTO_RECALL: "1", ASTRONRAG_AUTO_MIN_SCORE: "0" }, "prompt");
		const context = JSON.parse(recall.stdout).hookSpecificOutput.additionalContext;
		assert.match(context, /new-target-needle/);
		assert.ok(!/wrong-project-needle|wrong-vault-needle/.test(context));
		assert.equal(warnings(recall.stderr).length, 0);
		const server = await initialize({ ...conflict, ASTRONRAG_STORE: "file" });
		assert.match(server.result.instructions, /new-target-needle/);
		assert.ok(!/wrong-project-needle|wrong-vault-needle/.test(server.result.instructions));
		assert.equal(warnings(server.stderr).length, 0);
	}
}

async function hook_actual_repo_path() {
	const repo = path.join(fixture(), "설치 경로 (공백)");
	fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
	fs.copyFileSync(path.join(root, "scripts/setup-hook.mjs"), path.join(repo, "scripts/setup-hook.mjs"));
	fs.mkdirSync(path.join(repo, "scripts/lib"));
	fs.copyFileSync(path.join(root, "scripts/lib/env.mjs"), path.join(repo, "scripts/lib/env.mjs"));
	fs.copyFileSync(path.join(root, "scripts/session-guard.mjs"), path.join(repo, "scripts/session-guard.mjs"));
	fs.symlinkSync(path.join(root, "dist"), path.join(repo, "dist"), "junction");
	for (const explicit of [false, true]) {
		const settings = path.join(repo, `settings-${explicit}.json`);
		const vault = path.join(repo, "볼트 (하나)");
		const target = explicit ? vault : path.join(repo, "vault");
		fs.mkdirSync(target, { recursive: true });
		await seed(target, `actual-hook-${explicit}`);
		const result = await child([path.join(repo, "scripts/setup-hook.mjs"), "--settings", settings, ...(explicit ? ["--vault", vault] : [])], { cwd: repo, env: { ASTRONRAG_STORE: "file" } });
		assert.equal(result.status, 0, result.stderr);
		const hooks = JSON.parse(fs.readFileSync(settings, "utf8")).hooks;
		for (const [event, flag] of [["SessionStart", "--start"], ["Stop", "--stop"], ["UserPromptSubmit", "--prompt"]]) {
			const command = hooks[event][0].hooks[0].command;
			const parts = [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
			assert.equal(path.resolve(parts[0]), path.resolve(process.execPath));
			assert.equal(path.resolve(parts[1]), path.join(repo, "scripts/session-guard.mjs"));
			assert.deepEqual(parts.slice(2), [flag, explicit ? "--vault-force" : "--vault", target.replace(/\\/g, "/")]);
			const run = await child(parts.slice(1), { cwd: repo, env: { ASTRONRAG_STORE: "file" }, input: JSON.stringify({ session_id: "actual-path", source: "startup" }) });
			assert.equal(run.status, 0, run.stderr);
			if (event === "SessionStart") assert.match(run.stdout, new RegExp(`actual-hook-${explicit}`));
		}
	}
}

async function rename_preserves_existing_data() {
	const dir = fixture();
	await seed(dir, "preserved-slug", "BigBrainMemory-project");
	const marker = fs.readFileSync(path.join(dir, ".bigbrain-vault"));
	const originals = new Map(fs.readdirSync(path.join(dir, "memories")).map((name) => [name, fs.readFileSync(path.join(dir, "memories", name))]));
	const usage = path.join(dir, ".bbm-usage.jsonl");
	fs.writeFileSync(usage, '{"event":"existing"}\n');
	await probe(`const {createMemoryStore}=await import(${JSON.stringify(storeUrl)}); const s=createMemoryStore(${JSON.stringify(dir)},{ASTRONRAG_STORE:'file'}); try { const records=s.listSlugs().map(({slug})=>s.read(slug)); assert.equal(records.length,1);assert.equal(records[0].project,'BigBrainMemory-project');assert.match(records[0].body,/unchanged body/);} finally {s.close();}`);
	for (const [name, bytes] of originals) assert.deepEqual(fs.readFileSync(path.join(dir, "memories", name)), bytes);
	assert.deepEqual(fs.readFileSync(path.join(dir, ".bigbrain-vault")), marker);
	assert.equal(fs.readFileSync(usage, "utf8"), '{"event":"existing"}\n');
	const dbDir = fixture();
	await probe(`const s=await import(${JSON.stringify(storeUrl)}); const file=new s.FileStore(${JSON.stringify(dir)}); let record; try {record=file.read(file.listSlugs()[0].slug);} finally {file.close();} const old=s.createMemoryStore(${JSON.stringify(dbDir)},{BBM_STORE:'sqlite'}); try {old.write(record);old.setMeta('preserved-project','BigBrainMemory-project');} finally {old.close();} const current=s.createMemoryStore(${JSON.stringify(dbDir)},{ASTRONRAG_STORE:'sqlite'}); try {assert.deepEqual(current.read(record.slug),record);assert.equal(current.getMeta('preserved-project'),'BigBrainMemory-project');assert.equal(current.databasePath,path.join(${JSON.stringify(dbDir)},'.bbm','store.sqlite'));} finally {current.close();}`);
	const demo = fs.readFileSync(path.join(root, "viewer/index.html"), "utf8");
	assert.ok(demo.includes('["bbm-project-structure","BigBrainMemory 코드 구조","semantic",["bigbrainmemory","아키텍처"],"bigbrainmemory"'));
	assert.ok(demo.includes("BigBrainMemory, Context7, Notion, Google Drive."));
}

async function package_astronrag_metadata() {
	const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
	const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
	assert.equal(pkg.name, "astronrag");
	assert.match(pkg.description, /^AstronRAG — /);
	assert.deepEqual(pkg.bin, { astronrag: "dist/index.js" });
	assert.ok(pkg.scripts.test.split(" && ").includes("node scripts/regress-env-compat.mjs"), "npm test must run the environment compatibility suite");
	assert.equal(lock.name, "astronrag");
	assert.equal(lock.packages[""].name, "astronrag");
	assert.deepEqual(lock.packages[""].bin, pkg.bin);
}

const tests = [env_new_name_wins, env_legacy_fallback, env_warning_once_per_process, env_warning_resets_in_child, env_missing_preserves_defaults, env_empty_and_zero_keep_precedence, env_invalid_new_store_rejected, env_explicit_object_compat, env_helpers_match, mcp_legacy_warning_stderr_only, mcp_astronrag_identity, hook_legacy_env_fallback, hook_new_env_wins, hook_actual_repo_path, rename_preserves_existing_data, package_astronrag_metadata];
let failed = 0;
try {
	for (const test of tests) {
		console.log(`RUN ${test.name}`);
		try { await test(); console.log(`PASS ${test.name}`); }
		catch (error) { failed++; console.error(`FAIL ${test.name}`, error); }
	}
} finally {
	assert.ok(scratch.startsWith(path.join(root, ".astron-logs") + path.sep));
	fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exitCode = failed ? 1 : 0;
