// 벡터 계층 회귀 시험 — 가짜 임베더로 저장 파일·증분 재계산·warming·강화 규칙·unavailable·훅 격리를 고정한다.
//
// 사용:
//   node scripts/regress-vector.mjs                          기본(모델 없이, npm test 에 포함)
//   node scripts/regress-vector.mjs --old-dist <dist 디렉터리>  구버전 빌드가 vectors.v1.* 가 있는 볼트에서 그 파일을 무시하는지
//   node scripts/regress-vector.mjs --real [--count 950] [--queries 50] [--seed 42]
//                                                            실제 모델로 로드 시간·RSS·첫 sync·질의당 추가 지연을 잰다(측정 전용)
//
// 볼트는 전부 %TEMP% 사본이다. 서버·훅 자식 프로세스의 transformers 해석은 module.registerHooks 로 막거나 멈춘다.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const entry = path.join(root, "dist", "index.js");
const fixture = path.join(root, "eval", "fixture-vault");
const PKG = "@huggingface/transformers";
/** 가짜 임베더 차원 */
const DIM = 64;

// 시험 프로세스와 자식이 사용자 환경의 ASTRONRAG_* 설정을 물려받지 않게 한다. 강화 관측을 위해 간격 게이트를 연다
for (const k of Object.keys(process.env)) if (k.startsWith("ASTRONRAG_")) delete process.env[k];
process.env.ASTRONRAG_SPACING_MS = "0";
process.env.ASTRONRAG_SPACING_ALPHA = "0";

let values;
try {
	({ values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			real: { type: "boolean", default: false },
			"old-dist": { type: "string" },
			count: { type: "string", default: "950" },
			queries: { type: "string", default: "50" },
			seed: { type: "string", default: "42" },
		},
	}));
} catch (e) {
	console.error(`regress-vector: ${e instanceof Error ? e.message : String(e)}`);
	process.exit(2);
}
const count = Number(values.count);
const nQueries = Number(values.queries);
const seed = Number(values.seed);
if (!Number.isInteger(count) || count < 1 || !Number.isInteger(nQueries) || nQueries < 1 || !Number.isInteger(seed)) {
	console.error("regress-vector: --count·--queries 는 1 이상 정수, --seed 는 정수여야 한다");
	process.exit(2);
}
if (values.real && values["old-dist"] !== undefined) {
	console.error("regress-vector: --real 과 --old-dist 는 따로 실행한다");
	process.exit(2);
}
const oldDist = values["old-dist"] === undefined ? null : path.resolve(values["old-dist"]);
if (oldDist && !["store.js", "vault.js", "index.js"].every((f) => fs.existsSync(path.join(oldDist, f)))) {
	console.error(`regress-vector: --old-dist 에 store.js·vault.js·index.js 가 없다: ${oldDist}`);
	process.exit(2);
}
if (!fs.existsSync(path.join(root, "dist", "vector-retriever.js"))) {
	console.error("regress-vector: dist/vector-retriever.js 가 없다 — 먼저 npm run build");
	process.exit(1);
}

const distUrl = (f) => pathToFileURL(path.join(root, "dist", f)).href;
const { Vault } = await import(distUrl("vault.js"));
const { MemoryStore } = await import(distUrl("store.js"));
const { INDEX_DIR, INDEX_FILE } = await import(distUrl("retriever.js"));
const vmod = await import(distUrl("vector-retriever.js"));
const { VectorRetriever, VECTOR_BIN, VECTOR_META } = vmod;

let failures = 0;
function check(name, cond, detail = "") {
	if (cond) console.log(`  ✔ ${name}`);
	else {
		failures++;
		console.error(`  ✘ ${name} ${detail}`);
	}
}

const temps = new Array();
const testTmp = path.resolve(process.env.ASTRONRAG_TEST_TMPDIR ?? path.join(root, ".astron-logs/vector-tests"));
fs.mkdirSync(testTmp, { recursive: true });
/** %TEMP% 아래 새 디렉터리 (끝나면 지운다) */
function tempDir(tag) {
	const d = fs.mkdtempSync(path.join(testTmp, `bbm-vector-${tag}-`));
	temps.push(d);
	return d;
}
/** 픽스처 볼트 사본 */
function fixtureCopy(tag) {
	const d = tempDir(tag);
	fs.cpSync(fixture, d, { recursive: true });
	return d;
}

/** 토큰 해시 bag 을 정규화한 가짜 임베더 — 호출마다 { kind, texts } 를 calls 에 남긴다 */
function fakeEmbed(calls) {
	return async (texts, kind) => {
		calls.push({ kind, texts });
		return texts.map((t) => {
			const v = new Float32Array(DIM);
			for (const tok of t.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []) {
				let h = 2166136261;
				for (const ch of tok) h = Math.imul(h ^ (ch.codePointAt(0) ?? 0), 16777619);
				v[(h >>> 0) % DIM] += 1;
			}
			const n = Math.hypot(...v) || 1;
			return v.map((x) => x / n);
		});
	};
}
/** passage 로 임베딩한 문서 수 */
const passages = (calls) => calls.filter((c) => c.kind === "passage").reduce((s, c) => s + c.texts.length, 0);

/** 가짜 transformers 모듈 — "커피"·"coffee" 가 든 텍스트는 0번 축, 나머지는 길이로 고른 다른 축의 단위 벡터를 낸다 */
const FAKE_TRANSFORMERS = `export const env = {};
export async function pipeline() {
	return async (texts) => {
		const D = 8;
		const data = new Float32Array(texts.length * D);
		texts.forEach((t, i) => { data[i * D + (/커피|coffee/i.test(t) ? 0 : 1 + (t.length % (D - 1)))] = 1; });
		return { dims: [texts.length, D], data };
	};
}`;

/** 자식 node 가 먼저 불러올 훅 파일 — block 은 transformers 해석을 실패시키고, hang 은 그 import 를 영원히 멈추고, fake 는 가짜 모듈로 바꾸고, log 는 해석한 URL 을 파일에 남긴다 */
function hookFile(mode, logPath = "") {
	const dir = tempDir(`hook-${mode}`);
	const fp = path.join(dir, "hooks.mjs");
	const body = {
		block: `if (s === ${JSON.stringify(PKG)}) { const e = new Error("Cannot find package '${PKG}'"); e.code = "ERR_MODULE_NOT_FOUND"; throw e; } return next(s, c);`,
		hang: `if (s === ${JSON.stringify(PKG)}) return { url: "data:text/javascript,await new Promise(() => {});", shortCircuit: true }; return next(s, c);`,
		fake: `if (s === ${JSON.stringify(PKG)}) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(FAKE_TRANSFORMERS))}, shortCircuit: true }; return next(s, c);`,
		log: `const r = next(s, c); seen.add(s + " -> " + r.url); return r;`,
	}[mode];
	fs.writeFileSync(
		fp,
		`import { registerHooks } from "node:module";\nimport { writeFileSync } from "node:fs";\nconst seen = new Set();\nregisterHooks({ resolve(s, c, next) { ${body} } });\n` +
			(mode === "log" ? `process.on("exit", () => writeFileSync(${JSON.stringify(logPath)}, JSON.stringify([...seen])));\n` : ""),
		"utf-8",
	);
	return pathToFileURL(fp).href;
}

/** MCP 서버를 띄워 recall 을 한 번 이상 부른다 — until 이 true 를 돌려줄 때까지(최대 tries 회) 다시 부르고, then 이 있으면 닫기 전에 클라이언트로 부른다 */
async function serverRecall({ entryFile = entry, vault = "", env = {}, preload = "", args = {}, until = (_json) => true, tries = 1, then = async (_client) => {} }) {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [...(preload ? ["--import", preload] : []), entryFile],
		cwd: path.dirname(path.dirname(entryFile)),
		env: { ...process.env, ASTRONRAG_VAULT: vault, ASTRONRAG_STORE: "file", ...env },
		stderr: "pipe",
	});
	const client = new Client({ name: "regress-vector", version: "0.0.1" });
	await client.connect(transport);
	let json;
	try {
		for (let i = 0; i < tries; i++) {
			const res = await client.callTool({ name: "recall", arguments: args });
			json = JSON.parse(Object(res.content)[0].text);
			if (until(json)) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		await then(client);
	} finally {
		await client.close();
	}
	return json;
}

/** 파일 바이트 SHA-256 */
const fileHash = (fp) => crypto.createHash("sha256").update(fs.readFileSync(fp)).digest("hex");

/** 기억 3건짜리 새 볼트와 저장소 */
function smallVault(tag) {
	const dir = tempDir(tag);
	const vault = new Vault(dir);
	const store = new MemoryStore(vault);
	store.remember({ title: "PostgreSQL connection pool", content: "Set max pool size to 20 for the api service.", type: "semantic", slug: "pg-pool" });
	store.remember({ title: "배포 절차", content: "운영 배포는 태그를 만든 뒤 파이프라인을 승인한다.", type: "procedural", slug: "deploy-steps" });
	store.remember({ title: "Coffee preference", content: "The user likes dark roast without sugar.", type: "preference", slug: "coffee" });
	store.retriever.sync(vault);
	return { dir, vault, store, indexDir: path.join(dir, INDEX_DIR) };
}

try {
	if (values.real) await realMeasure();
	else if (oldDist) await oldDistCheck();
	else await defaultChecks();
} finally {
	for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
}
if (failures > 0) {
	console.error(`regress-vector: ${failures}건 실패`);
	process.exit(1);
}
console.log("regress-vector 통과 ✔");

async function defaultChecks() {
	await tuningBoundaryChecks();
	console.log("1) 저장 파일·증분 재계산");
	{
		const { vault, store, indexDir } = smallVault("files");
		const calls = new Array();
		const vr = new VectorRetriever(indexDir, fakeEmbed(calls));
		await vr.warm(() => store.retriever.entries());
		check("warm 뒤 ready", vr.state === "ready", vr.state);
		check("첫 sync 는 3건 모두 임베딩", passages(calls) === 3, String(passages(calls)));
		const bin = path.join(indexDir, VECTOR_BIN);
		const metaPath = path.join(indexDir, VECTOR_META);
		check("bin 크기 = n×dim×4", fs.statSync(bin).size === 3 * DIM * 4, String(fs.statSync(bin).size));
		const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
		check("메타에 모델·키·해시", meta.model === vr.model && meta.dim === DIM && meta.keys.length === 3 && meta.keys.every((k) => /^m:/.test(k[0]) && /^[0-9a-f]{64}$/.test(k[1])), JSON.stringify(meta).slice(0, 200));
		check(".gitignore 가 * 한 줄", fs.readFileSync(path.join(indexDir, ".gitignore"), "utf-8") === "*\n");

		const again = new Array();
		const vr2 = new VectorRetriever(indexDir, fakeEmbed(again));
		await vr2.warm(() => store.retriever.entries());
		check("새 검색기는 저장 파일을 적재해 다시 임베딩하지 않는다", passages(again) === 0, String(passages(again)));

		store.revise("deploy-steps", { content: "운영 배포는 태그 뒤 파이프라인 승인과 헬스체크 확인으로 끝난다." });
		store.retriever.sync(vault);
		const before = again.length;
		await vr2.sync(store.retriever.entries());
		const changed = again.slice(before);
		check("내용이 바뀐 1건만 다시 임베딩", passages(changed) === 1 && changed[0].texts[0].includes("헬스체크"), JSON.stringify(changed.map((c) => c.texts.length)));
		const mark = again.length;
		store.revise("coffee", { tags: ["drink"] });
		store.retriever.sync(vault);
		await vr2.sync(store.retriever.entries());
		check("태그가 바뀌어도 임베딩 대상이라 1건 재계산", passages(again.slice(mark)) === 1, String(passages(again.slice(mark))));
		const mark2 = again.length;
		await vr2.sync(store.retriever.entries());
		check("그대로면 재계산 없음", passages(again.slice(mark2)) === 0);

		const other = new Array();
		const vr3 = new VectorRetriever(indexDir, fakeEmbed(other), "other-model@q8");
		await vr3.warm(() => store.retriever.entries());
		check("모델 ID 가 다르면 전체 재계산", passages(other) === 3, String(passages(other)));
		check("저장 메타의 모델이 새 모델로 바뀜", JSON.parse(fs.readFileSync(metaPath, "utf-8")).model === "other-model@q8");

		fs.truncateSync(bin, 3 * DIM * 4 - 4);
		const cut = new Array();
		const vr4 = new VectorRetriever(indexDir, fakeEmbed(cut), "other-model@q8");
		await vr4.warm(() => store.retriever.entries());
		check("bin 이 잘리면 전체 재계산", passages(cut) === 3 && fs.statSync(bin).size === 3 * DIM * 4, String(passages(cut)));

		const flip = fs.readFileSync(bin);
		flip[0] ^= 0xff;
		fs.writeFileSync(bin, flip);
		const bad = new Array();
		const vr5 = new VectorRetriever(indexDir, fakeEmbed(bad), "other-model@q8");
		await vr5.warm(() => store.retriever.entries());
		check("크기가 같아도 행렬 해시가 다르면 전체 재계산", passages(bad) === 3, String(passages(bad)));

		store.forget("coffee");
		store.retriever.sync(vault);
		await vr5.sync(store.retriever.entries());
		const keys = JSON.parse(fs.readFileSync(metaPath, "utf-8")).keys.map((k) => k[0]);
		check("잊은 기억은 memories 키가 빠지고 archive 키로 남는다", !keys.includes("m:coffee") && keys.includes("a:coffee"), JSON.stringify(keys));

		// 빈 slug 키(파일명 ".md")도 형식상 유효하다 — 적재에서 거부하지 않는지
		const emptyDir = path.join(tempDir("emptykey"), INDEX_DIR);
		const rec = store.retriever.entries()[0].record;
		const seedCalls = new Array();
		const seedVr = new VectorRetriever(emptyDir, fakeEmbed(seedCalls));
		await seedVr.warm(() => [{ key: "m:", record: rec }]);
		const reload = new Array();
		const vr6 = new VectorRetriever(emptyDir, fakeEmbed(reload));
		await vr6.warm(() => [{ key: "m:", record: rec }]);
		check("빈 slug 키 m: 를 적재한다", seedCalls.length === 1 && passages(reload) === 0, `${seedCalls.length}/${passages(reload)}`);
	}

	console.log("2) 범위 필터·코사인 하한·top-k");
	{
		const { store } = smallVault("nearest");
		const vr = new VectorRetriever(null, fakeEmbed([]));
		await vr.warm(() => store.retriever.entries());
		const qv = await vr.embedQuery("PostgreSQL connection pool size");
		const all = vr.nearest(qv, {}, 10, -1);
		check("하한 -1 이면 전부, 코사인 내림차순", all.length === 3 && all[0].key === "m:pg-pool" && all.every((h, i) => i === 0 || all[i - 1].cos >= h.cos), JSON.stringify(all));
		check("유형 필터를 top-k 전에 건다", JSON.stringify(vr.nearest(qv, { type: "procedural" }, 1, -1).map((h) => h.key)) === JSON.stringify(["m:deploy-steps"]));
		check("하한 미만은 버린다", vr.nearest(qv, {}, 10, 0.999).length === 0);
		check("k=0 이면 빈 목록", vr.nearest(qv, {}, 0, -1).length === 0);
	}

	console.log("3) 벡터 전용 결과는 recall 에서 강화하지 않고 read 로 열면 강화한다 (V4)");
	{
		const { vault, store } = smallVault("reinforce");
		const snap = (slug) => {
			const r = vault.read(slug);
			return { s: r.storageStrength, n: r.accessCount };
		};
		const pg0 = snap("pg-pool");
		const co0 = snap("coffee");
		const hits = [
			{ key: "m:coffee", score: 3 },
			{ key: "m:pg-pool", score: 9 },
		];
		const out = store.searchDetailed("PostgreSQL pool", { limit: 5, includeLinked: false, vectorHits: hits });
		const bySlug = new Map();
		for (const r of out.results) bySlug.set(r.record.slug, r);
		check("벡터로만 들어온 기억에 via vector", bySlug.get("coffee")?.via === "vector", JSON.stringify(out.results.map((r) => [r.record.slug, r.via])));
		check("어휘와 겹친 기억은 via 없음·점수는 어휘 점수", bySlug.has("pg-pool") && bySlug.get("pg-pool").via === undefined);
		check("totalMatched 에 벡터 전용 후보 포함", out.totalMatched === 2, String(out.totalMatched));
		const pg1 = snap("pg-pool");
		const co1 = snap("coffee");
		check("어휘 후보는 강화", pg1.s > pg0.s && pg1.n > pg0.n, JSON.stringify([pg0, pg1]));
		check("벡터 전용은 저장강도·접근수 그대로", co1.s === co0.s && co1.n === co0.n, JSON.stringify([co0, co1]));
		store.read("coffee");
		const co2 = snap("coffee");
		check("read 로 열면 강화", co2.s > co1.s && co2.n > co1.n, JSON.stringify([co1, co2]));
		const plain = store.searchDetailed("PostgreSQL pool", { limit: 5, includeLinked: false });
		check("vectorHits 가 없으면 벡터 후보 없음", plain.results.every((r) => r.via === undefined) && plain.totalMatched === 1);
		const scoped = store.searchDetailed("PostgreSQL pool", { limit: 5, includeLinked: false, type: "semantic", vectorHits: hits });
		check("범위 밖 벡터 결과는 덧붙지 않는다", scoped.results.every((r) => r.record.type === "semantic"), JSON.stringify(scoped.results.map((r) => r.record.slug)));
		const ghost = store.searchDetailed("PostgreSQL pool", { limit: 5, includeLinked: false, vectorHits: [{ key: "m:no-such", score: 5 }] });
		check("색인에 없는 키는 무시", ghost.totalMatched === 1);
	}

	console.log("4) 서버 — warming 중에는 어휘 결과만 + vector:warming (V5)");
	{
		const a = fixtureCopy("warm-a");
		const b = fixtureCopy("warm-b");
		const args = { query: "Postgres connection pool", include_linked: false };
		const warm = await serverRecall({ vault: a, env: { ASTRONRAG_VECTOR: "1" }, preload: hookFile("hang"), args });
		const off = await serverRecall({ vault: b, args });
		check("vector 가 warming", warm.vector === "warming", JSON.stringify(warm).slice(0, 200));
		const pick = (j) => JSON.stringify({ r: j.results.map((r) => [r.slug, r.score, r.via]), t: j.total_matched });
		check("결과는 벡터를 끈 서버와 같다", pick(warm) === pick(off), `${pick(warm)} / ${pick(off)}`);
		check("끈 서버 응답에는 vector 필드가 없다", !("vector" in off) && off.results.every((r) => !("via" in r)));
		check("warming 중에는 임베딩 파일을 만들지 않는다", !fs.existsSync(path.join(a, INDEX_DIR, VECTOR_BIN)));
	}

	console.log("5) 서버 — 패키지를 해석하지 못하면 unavailable + 설치 안내 + 어휘 결과");
	{
		const v = fixtureCopy("unavail");
		const json = await serverRecall({
			vault: v,
			env: { ASTRONRAG_VECTOR: "1" },
			preload: hookFile("block"),
			args: { query: "Postgres connection pool" },
			until: (j) => j.vector !== "warming",
			tries: 50,
		});
		check("vector 가 unavailable", json.vector === "unavailable", JSON.stringify(json).slice(0, 200));
		check("설치 명령 안내", typeof json.vector_note === "string" && json.vector_note.includes(vmod.INSTALL_COMMAND), String(json.vector_note));
		check("어휘 결과는 그대로", Array.isArray(json.results) && json.results.length > 0);
		const zero = await serverRecall({
			vault: v,
			env: { ASTRONRAG_VECTOR: "1" },
			preload: hookFile("block"),
			args: { query: "zzqxv nonexistent" },
			until: (j) => j.vector !== "warming",
			tries: 50,
		});
		check("0건 응답에도 vector 상태", zero.results.length === 0 && zero.vector === "unavailable", JSON.stringify(zero).slice(0, 200));
		const other = await serverRecall({ vault: v, env: { ASTRONRAG_VECTOR: "true" }, preload: hookFile("block"), args: { query: "Postgres connection pool" } });
		check("ASTRONRAG_VECTOR 가 1 이 아니면 꺼짐", !("vector" in other));
	}

	console.log("6) 서버 — ready 면 벡터 전용 결과에 via:vector, recall 은 강화하지 않고 read_memory 는 강화한다");
	{
		const { dir, vault } = smallVault("ready");
		const before = vault.read("coffee");
		/** @type {Awaited<ReturnType<Client["callTool"]>> | undefined} */
		let read;
		const json = await serverRecall({
			vault: dir,
			env: { ASTRONRAG_VECTOR: "1" },
			preload: hookFile("fake"),
			args: { query: "커피 취향" },
			until: (j) => j.vector === "ready",
			tries: 50,
			then: async (client) => {
				const mid = vault.read("coffee");
				check("recall 뒤 벡터 전용 기억의 저장강도·접근수 그대로", mid.storageStrength === before.storageStrength && mid.accessCount === before.accessCount, JSON.stringify([before.storageStrength, mid.storageStrength]));
				read = await client.callTool({ name: "read_memory", arguments: { id: "coffee" } });
			},
		});
		check("vector 가 ready", json.vector === "ready", JSON.stringify(json).slice(0, 200));
		check("어휘로 안 잡히는 기억이 via vector 로 나온다", json.results?.length === 1 && json.results[0].slug === "coffee" && json.results[0].via === "vector", JSON.stringify(json.results));
		const after = vault.read("coffee");
		check("read_memory 로 열면 강화", !read?.isError && after.storageStrength > before.storageStrength && after.accessCount > before.accessCount, JSON.stringify([before.storageStrength, after.storageStrength]));
		check("임베딩 파일을 볼트 .bbm-index 에 쓴다", fs.existsSync(path.join(dir, INDEX_DIR, VECTOR_BIN)) && fs.existsSync(path.join(dir, INDEX_DIR, VECTOR_META)));
	}

	console.log("7) 훅은 벡터 모듈·transformers 를 불러오지 않는다");
	{
		// dist/store.js 에서 정적·동적 상대 import 를 따라간 그래프
		const seen = new Map();
		const stack = [path.join(root, "dist", "store.js")];
		while (stack.length > 0) {
			const fp = String(stack.pop());
			if (seen.has(fp)) continue;
			seen.set(fp, true);
			const src = fs.readFileSync(fp, "utf-8");
			for (const m of src.matchAll(/(?:from\s*|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) stack.push(path.resolve(path.dirname(fp), m[1]));
		}
		const names = [...seen.keys()].map((f) => path.basename(f)).sort();
		check("store.js 그래프에 vector-retriever 없음", !names.includes("vector-retriever.js"), JSON.stringify(names));
		check("store.js 그래프에 transformers 문자열 없음", [...seen.keys()].every((f) => !fs.readFileSync(f, "utf-8").includes(PKG)));
		const guardSrc = fs.readFileSync(path.join(here, "session-guard.mjs"), "utf-8");
		check("session-guard 에 벡터 모듈·transformers 언급 없음", !guardSrc.includes("vector-retriever") && !guardSrc.includes(PKG));

		// 실제 훅 실행에서 해석한 모듈 목록
		const v = fixtureCopy("hook");
		const home = tempDir("home");
		await serverRecall({ vault: v, args: { query: "Postgres connection pool" } }); // 영속 역색인을 만든다
		const log = path.join(tempDir("hooklog"), "resolved.json");
		const r = spawnSync(process.execPath, ["--import", hookFile("log", log), path.join(here, "session-guard.mjs"), "--prompt", "--vault-force", v], {
			cwd: v,
			input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "V6", prompt: "Postgres connection pool 설정을 알려줘" }),
			encoding: "utf-8",
			timeout: 15000,
			env: { ...process.env, USERPROFILE: home, HOME: home, ASTRONRAG_AUTO_RECALL: "1", ASTRONRAG_VECTOR: "1", ASTRONRAG_STORE: "file" },
		});
		const resolved = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, "utf-8")) : [];
		check("훅이 dist/store.js 를 불러왔다(시험이 공허하지 않음)", resolved.some((x) => x.includes("dist/store.js")), `status=${r.status} ${JSON.stringify(resolved).slice(0, 300)}`);
		check("훅 실행에서 벡터 모듈·transformers 를 해석하지 않았다", resolved.every((x) => !x.includes("vector-retriever") && !x.includes(PKG)), JSON.stringify(resolved.filter((x) => x.includes("vector") || x.includes("huggingface"))));
	}
}

/** 구버전 빌드가 vectors.v1.* 가 있는 볼트를 무시하는지 — 검색 결과가 파일 없는 볼트와 같고 벡터 파일 바이트가 그대로인지 */
async function oldDistCheck() {
	const dist = String(oldDist);
	console.log(`8) 구버전 빌드(${dist})와 vectors.v1.*`);
	const { Vault: OldVault } = await import(pathToFileURL(path.join(dist, "vault.js")).href);
	const { MemoryStore: OldStore } = await import(pathToFileURL(path.join(dist, "store.js")).href);
	const withVec = fixtureCopy("old-vec");
	const plain = fixtureCopy("old-plain");
	// 현재 빌드로 벡터 파일을 만든다
	{
		const vault = new Vault(withVec);
		const store = new MemoryStore(vault);
		store.retriever.sync(vault);
		const vr = new VectorRetriever(path.join(withVec, INDEX_DIR), fakeEmbed([]));
		await vr.warm(() => store.retriever.entries());
		check("벡터 파일 준비", vr.state === "ready" && fs.existsSync(path.join(withVec, INDEX_DIR, VECTOR_BIN)));
	}
	const vecFiles = [VECTOR_BIN, VECTOR_META].map((f) => path.join(withVec, INDEX_DIR, f));
	const before = vecFiles.map(fileHash);
	const open = (dir) => {
		const s = new OldStore(new OldVault(dir));
		s.reinforce = () => {};
		return s;
	};
	const a = open(withVec);
	const b = open(plain);
	const queries = fs
		.readFileSync(path.join(root, "eval", "golden.jsonl"), "utf-8")
		.split(/\r?\n/)
		.filter((l) => l.trim() !== "")
		.map((l) => JSON.parse(l).query);
	const realNow = Date.now;
	Date.now = () => Date.parse("2026-07-01T00:00:00.000Z");
	const diff = queries.filter((q) => JSON.stringify(a.searchDetailed(q, { limit: 5 })) !== JSON.stringify(b.searchDetailed(q, { limit: 5 })));
	Date.now = realNow;
	check(`골든 ${queries.length}질의 결과가 벡터 파일 없는 볼트와 같다`, diff.length === 0, JSON.stringify(diff.slice(0, 3)));
	a.remember({ title: "구버전 저장 시험", content: "벡터 파일이 있어도 구버전이 저장·색인한다.", type: "semantic", slug: "old-build-write" });
	const found = a.search("구버전 저장 시험", { limit: 3 }).map((r) => r.record.slug);
	check("구버전 remember·검색 정상", found.includes("old-build-write"), JSON.stringify(found));
	check("구버전 역색인 파일 유지", fs.existsSync(path.join(withVec, INDEX_DIR, INDEX_FILE)));
	check("벡터 파일 바이트 그대로", vecFiles.map(fileHash).every((h, i) => h === before[i]));
	const json = await serverRecall({ entryFile: path.join(dist, "index.js"), vault: withVec, args: { query: "Postgres connection pool" } });
	check("구버전 서버 recall 정상", Array.isArray(json.results) && json.results.length > 0 && !("vector" in json), JSON.stringify(json).slice(0, 200));
	check("구버전 서버 뒤에도 벡터 파일 바이트 그대로", vecFiles.map(fileHash).every((h, i) => h === before[i]));
}

/** 실제 모델 측정 — 모델 로드 시간·RSS 증가, 합성 볼트 첫 sync, 질의당 추가 지연(sync+embedQuery+nearest) */
/** 합성 기억으로 벡터 경계와 모델 캐시 계약을 검증한다. */
async function tuningBoundaryChecks() {
	const E = await import("./eval-retrieval.mjs");
	const { FileStore } = await import(distUrl("stores/file-store.js"));
	const { SqliteStore } = await import(distUrl("stores/sqlite-store.js"));
	const run = async (name, fn) => {
		try { await fn(); check(name, true); } catch (e) { check(name, false, e.stack ?? String(e)); }
	};
	await run("test_vector_threshold_topk_and_tie_order", async () => {
		const { store } = smallVault("threshold"); const entries = store.retriever.entries().slice(0, 3);
		const vr = new VectorRetriever(null, async (texts) => texts.map(() => new Float32Array([0.75, Math.sqrt(1 - 0.75 ** 2)])));
		await vr.warm(() => entries);
		const keys = entries.map((e) => e.key).sort();
		assert.deepEqual(vr.nearest(new Float32Array([1, 0]), {}, 2, 0.75).map((h) => h.key), keys.slice(0, 2));
		assert.deepEqual(vr.nearest(new Float32Array([1, 0]), {}, 2, 0.75001), []);
	});
	await run("test_vector_eval_matches_runtime_fusion", async () => {
		const { store } = smallVault("fusion"); const row = { query: "connection pool" };
		const entries = store.retriever.entries(); const calls = new Array();
		const vec = { mod: { VECTOR_TOP_K: 10 }, qv: new Map([[row, new Float32Array([1])]]), vr: { nearest: (_q, _f, k, tau) => { calls.push([k, tau]); return [{ key: entries[1].key, cos: 0.8 }, { key: entries[0].key, cos: 0.79 }]; } } };
		store.reinforce = () => {};
		for (const fusion of ["add", "rrf"]) {
			const cfg = { fusion, w: 3, tau: 0.72, topK: 10 };
			const actual = E.rankRow(store, vec, row, undefined, cfg);
			const expected = store.searchDetailed(row.query, { limit: 1000, includeLinked: false, vectorFusion: fusion, vectorHits: [{ key: entries[1].key, score: 3 * 0.8 }, { key: entries[0].key, score: 3 * 0.79 }], vectorWeight: 3 }).results.map((r) => ({ slug: r.record.slug, score: r.score, ...(r.via ? { via: r.via } : {}) }));
			assert.deepEqual(actual, expected);
		}
		assert.deepEqual(calls, [[10, 0.72], [10, 0.72]]);
	});
	await run("test_vector_fusion_preserves_scope_filters", async () => {
		const { store } = smallVault("scope-fusion"); store.reinforce = () => {};
		store.remember({ title: "범위 밖 배포", content: "private deployment", type: "semantic", project: "other-project", slug: "outside" });
		store.retriever.sync(store.vault);
		const entries = store.retriever.entries(); const hits = entries.map((e) => ({ key: e.key, score: 100 })); hits.push({ key: "missing", score: 100 });
		for (const vectorFusion of ["add", "rrf"]) {
			assert.ok(store.searchDetailed("배포", { type: "procedural", vectorHits: hits, vectorFusion }).results.every((r) => r.record.type === "procedural"));
			assert.ok(store.searchDetailed("배포", { project: "wanted-project", vectorHits: hits, vectorFusion }).results.every((r) => r.record.project !== "other-project"));
		}
	});
	await run("test_vector_no_hits_preserves_lexical_with_rrf", async () => {
		const { store } = smallVault("fallback-tuning"); store.reinforce = () => {};
		const baseline = store.searchDetailed("connection pool");
		assert.deepEqual(store.searchDetailed("connection pool", { vectorHits: undefined, vectorFusion: "rrf" }), baseline);
	});
	await run("test_vector_model_prefix_and_embedding_shape", async () => {
		for (const id of [vmod.MODEL_ID, "Xenova/paraphrase-multilingual-MiniLM-L12-v2"]) {
			const seen = new Array();
			const embed = await vmod.loadEmbedder(id, "q8", async () => async (texts, options) => { seen.push({ texts, options }); return { dims: [texts.length, 2], data: new Float32Array(texts.flatMap(() => [1, 0])) }; });
			assert.equal((await embed(["문장"], "query"))[0].length, 2); await embed(["문서"], "passage");
			assert.deepEqual(seen[0], { texts: [id.includes("e5") ? "query: 문장" : "문장"], options: { pooling: "mean", normalize: true } });
			assert.equal(seen[1].texts[0], id.includes("e5") ? "passage: 문서" : "문서");
		}
		const invalid = await vmod.loadEmbedder(vmod.MODEL_ID, "q8", async () => async () => ({ dims: [1, 2], data: new Float32Array([NaN, 0]) }));
		await assert.rejects(() => invalid(["bad"], "query"));
	});
	for (const [kind, name] of [
		["sqlite", "test_vector_sqlite_reembeds_on_model_key_change"],
		["file", "test_vector_file_store_reembeds_on_model_key_change"],
	]) await run(name, async () => {
		const { dir, store } = smallVault(`reembed-${kind}`); const entries = store.retriever.entries();
		let backend = kind === "file" ? new FileStore(dir) : new SqliteStore(dir); const calls = new Array();
		try {
			const old = new VectorRetriever(backend, fakeEmbed([]), "old@q8"); await old.warm(() => entries);
			const embed = async (texts, phase) => { calls.push({ texts, kind: phase }); return texts.map(() => new Float32Array([1, 0, 0])); };
			const fresh = new VectorRetriever(backend, embed, "new@q8"); await fresh.warm(() => entries);
			assert.equal(fresh.state, "ready"); assert.equal(passages(calls), entries.length); assert.ok(backend.loadEmbeddings("new@q8").every((r) => r.vector.length === 3));
			backend.close(); backend = kind === "file" ? new FileStore(dir) : new SqliteStore(dir);
			calls.length = 0; const restart = new VectorRetriever(backend, embed, "new@q8"); await restart.warm(() => entries);
			assert.equal(restart.state, "ready"); assert.equal(passages(calls), 0);
		} finally { backend.close(); }
	});
	await run("test_vector_cache_corruption_and_save_retry_recover", async () => {
		const { store } = smallVault("cache-tuning"); const entries = store.retriever.entries(); let saves = 0; const calls = [];
		const backend = { loadEmbeddings: () => [{ key: entries[0].key, hash: "bad", vector: new Float32Array([NaN]) }], replaceEmbeddings: () => { if (++saves === 1) throw new Error("save failed"); } };
		const vr = new VectorRetriever(backend, fakeEmbed(calls)); await vr.warm(() => entries);
		assert.equal(vr.state, "ready"); await vr.sync(entries); assert.equal(saves, 2); assert.equal(passages(calls), entries.length);
		const dimensionCalls = new Array();
		const wrongDimension = { loadEmbeddings: () => [{ key: entries[0].key, hash: crypto.createHash("sha256").update(vmod.passageText(entries[0].record)).digest("hex"), vector: new Float32Array([1, 0]) }], replaceEmbeddings: () => {} };
		const recovered = new VectorRetriever(wrongDimension, fakeEmbed(dimensionCalls)); await recovered.warm(() => entries);
		assert.equal(recovered.state, "ready"); assert.equal(recovered.nearest(new Float32Array(DIM), {}, 10, -1).length, entries.length);
		assert.ok(recovered.rows.size === entries.length && [...recovered.rows.values()].every((r) => r.vec.length === DIM));
	});
	await run("test_vector_concurrent_sync_preserves_latest_entries", async () => {
		const { store } = smallVault("sync-tuning"); const entries = store.retriever.entries();
		const vr = new VectorRetriever(null, async (texts) => { await new Promise((resolve) => setTimeout(resolve, 5)); return texts.map(() => new Float32Array([1, 0])); });
		await vr.warm(() => entries); const latest = entries.slice().reverse();
		await Promise.all([vr.sync(entries.slice(0, 1)), vr.sync(latest)]);
		assert.deepEqual(vr.nearest(new Float32Array([1, 0]), {}, 10, 0).map((h) => h.key), latest.map((e) => e.key).sort());
		assert.deepEqual([...vr.rows.keys()], latest.map((e) => e.key));
	});
}

async function realMeasure() {
	console.log(`9) 실제 모델 측정 (${vmod.MODEL_ID} ${vmod.DTYPE}, 합성 ${count}건, 질의 ${nQueries}개, 시드 ${seed})`);
	const { buildVault, mulberry32 } = await import(pathToFileURL(path.join(here, "bench-rif.mjs")).href);
	const dir = tempDir("real");
	const vault = new Vault(dir);
	const rnd = mulberry32(seed);
	const benchQueries = buildVault(vault, count, rnd);
	const store = new MemoryStore(vault);
	store.retriever.sync(vault);
	const mb = (b) => Math.round((b / 1048576) * 10) / 10;
	global.gc?.();
	const rss0 = process.memoryUsage().rss;
	const t0 = performance.now();
	const embed = await vmod.loadEmbedder();
	const loadMs = performance.now() - t0;
	const rss1 = process.memoryUsage().rss;
	const vr = new VectorRetriever(path.join(dir, INDEX_DIR), embed);
	const t1 = performance.now();
	await vr.warm(() => store.retriever.entries());
	const firstSyncMs = performance.now() - t1;
	const rss2 = process.memoryUsage().rss;
	check("ready", vr.state === "ready", vr.reason);
	const vr2 = new VectorRetriever(path.join(dir, INDEX_DIR), embed);
	const t2 = performance.now();
	await vr2.warm(() => store.retriever.entries());
	const reloadMs = performance.now() - t2;
	// 질의: bench 질의 4종 + 시드 고정으로 고른 기억 설명
	const entries = store.retriever.entries();
	const qs = benchQueries.map((q) => q.query);
	while (qs.length < nQueries) qs.push(entries[Math.floor(rnd() * entries.length)].record.description);
	const times = new Array();
	for (const q of qs.slice(0, nQueries)) {
		const s = performance.now();
		await vr.sync(store.retriever.entries());
		const qv = await vr.embedQuery(q);
		vr.nearest(qv, {}, vmod.VECTOR_TOP_K);
		times.push(performance.now() - s);
	}
	times.sort((x, y) => x - y);
	const pct = (p) => Math.round(times[Math.max(0, Math.ceil(p * times.length) - 1)] * 10) / 10;
	const result = {
		model: vmod.MODEL_ID,
		dtype: vmod.DTYPE,
		cacheDir: vmod.MODEL_CACHE_DIR,
		memories: entries.length,
		modelLoadMs: Math.round(loadMs),
		rssMB: { beforeLoad: mb(rss0), afterLoad: mb(rss1), afterFirstSync: mb(rss2), increase: mb(rss2 - rss0), peakMaxRss: mb(process.resourceUsage().maxRSS * 1024) },
		firstSyncMs: Math.round(firstSyncMs),
		reloadFromFilesMs: Math.round(reloadMs),
		vectorBinBytes: fs.statSync(path.join(dir, INDEX_DIR, VECTOR_BIN)).size,
		perQueryMs: { p50: pct(0.5), p95: pct(0.95), n: times.length, mode: "sync(변경 없음)+embedQuery+nearest, 같은 프로세스, MCP 전송 제외" },
	};
	console.log(JSON.stringify(result, null, 2));
}
