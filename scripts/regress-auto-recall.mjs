// T44 자동 회상 회귀·평가·벤치 — UserPromptSubmit 훅(session-guard --prompt)의 자동 회상 주입을 고정하고 잰다.
//
// 사용:
//   node scripts/regress-auto-recall.mjs                  회귀 단언 (먼저 npm run build)
//   node scripts/regress-auto-recall.mjs --eval [--queries <jsonl>]
//                                                         질의 파일(기본 eval/autorecall-fresh.jsonl)로 none 오탐률·exact R@1·주입 크기·중복 노출을 잰다.
//                                                         기본 파일일 때만 golden.jsonl 홀드아웃도 함께 잰다
//   node scripts/regress-auto-recall.mjs --sweep          golden 의 none·exact 전체와 fresh 로 하한 T=0~20(0.5 간격)의 none 오탐률·exact R@1 을 시험 프로세스에서 훑는다
//   node scripts/regress-auto-recall.mjs --bench [--count 950] [--rounds 30] [--seed 42]
//                                                         bench-rif 생성기로 만든 합성 볼트에서 훅 끝단(spawn~종료)·단계별 시간과 SessionStart 인덱스와의 중복 노출을 잰다
//   --eval·--sweep·--bench 공통: [--scorer legacy|bm25f] [--min-score <T>] — 시험 프로세스와 자식 훅에 ASTRONRAG_SCORER·ASTRONRAG_AUTO_MIN_SCORE 로 넘긴다
//   자식 훅에는 ASTRONRAG_AUTO_RECALL=1 을 넘긴다(기본 끔).
//
// 볼트·HOME·설정 파일은 전부 %TEMP% 에 만들고 끝나면 지운다. 실사용 볼트와 ~/.claude 는 건드리지 않는다.

import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const guard = path.join(here, "session-guard.mjs");
const fixture = path.join(root, "eval", "fixture-vault");
/** 자동 회상 선택 규칙 — session-guard 기본값과 같아야 한다 */
const MIN_SCORE = 9;
const RELATIVE = 0.5;
const MAX = 3;
/** 지연 기준 — 훅 끝단(spawn~종료) p95 상한(ms) */
const LATENCY_LIMIT_MS = 200;

// 시험 프로세스와 자식 훅이 사용자 환경의 ASTRONRAG_* 설정을 물려받지 않게 한다
for (const k of Object.keys(process.env)) if (/^(?:ASTRONRAG_|BIGBRAIN_|BBM_)/.test(k)) delete process.env[k];

let values;
try {
	({ values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			eval: { type: "boolean", default: false },
			bench: { type: "boolean", default: false },
			count: { type: "string", default: "950" },
			rounds: { type: "string", default: "30" },
			seed: { type: "string", default: "42" },
			sweep: { type: "boolean", default: false },
			scorer: { type: "string" },
			"min-score": { type: "string" },
			queries: { type: "string" },
		},
	}));
} catch (e) {
	console.error(`regress-auto-recall: ${e instanceof Error ? e.message : String(e)}`);
	process.exit(2);
}
/** 측정 모드 — 회귀 단언은 기본값(스코어러 legacy·하한 9)으로만 돈다 */
const measuring = values.eval || values.bench || values.sweep;
if (!measuring && (values.scorer !== undefined || values["min-score"] !== undefined || values.queries !== undefined)) {
	console.error("regress-auto-recall: --scorer·--min-score·--queries 는 --eval·--sweep·--bench 와 함께 쓴다");
	process.exit(2);
}
if (values.scorer !== undefined) {
	if (!["legacy", "bm25f"].includes(values.scorer)) {
		console.error(`regress-auto-recall: 지원하지 않는 scorer: ${values.scorer}`);
		process.exit(2);
	}
	process.env.ASTRONRAG_SCORER = values.scorer;
}
/** 이번 실행의 자동 회상 하한 — --min-score 가 없으면 훅 기본값 */
const minScore = values["min-score"] === undefined ? MIN_SCORE : Number(values["min-score"]);
if (!(Number.isFinite(minScore) && minScore >= 0)) {
	console.error("regress-auto-recall: --min-score 는 0 이상 수여야 한다");
	process.exit(2);
}
if (values["min-score"] !== undefined) process.env.ASTRONRAG_AUTO_MIN_SCORE = String(minScore);

const distUrl = (f) => pathToFileURL(path.join(root, "dist", f)).href;
if (!fs.existsSync(path.join(root, "dist", "store.js"))) {
	console.error("regress-auto-recall: dist/store.js 가 없다 — 먼저 npm run build");
	process.exit(1);
}
const { Vault } = await import(distUrl("vault.js"));
const { MemoryStore, searchPersistedIndex, SCORER } = await import(distUrl("store.js"));
const { INDEX_DIR, INDEX_FILE } = await import(distUrl("retriever.js"));

const temps = new Array();
/** %TEMP% 아래 새 디렉터리 (끝나면 지운다) */
function tempDir(tag) {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), `bbm-autorecall-${tag}-`));
	temps.push(d);
	return d;
}
const home = tempDir("home");

/** 자식 훅 환경 — HOME 을 임시 디렉터리로 돌려 실사용 설정을 읽지 않게 한다 */
const hookEnv = (extra = {}) => ({ ...process.env, USERPROFILE: home, HOME: home, ASTRONRAG_STORE: "file", ...extra });

/** session-guard 를 띄워 { stdout, status, ms } 를 돌려준다 */
function runGuard(args, { cwd, input = "", env = {}, script = guard }) {
	const t0 = performance.now();
	const r = spawnSync(process.execPath, [script, ...args], {
		cwd,
		input,
		encoding: "utf-8",
		timeout: 15000,
		env: hookEnv(env),
	});
	return { stdout: r.stdout ?? "", status: r.status, ms: performance.now() - t0 };
}

/** 프롬프트 훅 입력 JSON (text 가 undefined 면 prompt 필드를 뺀다) */
const promptInput = (sessionId, text) =>
	JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sessionId, ...(text === undefined ? {} : { prompt: text }) });

/** 자동 회상을 켠 프롬프트 훅 한 번 (cwd 를 주지 않으면 볼트에서 띄운다) */
const prompt = (vault, sessionId, text, env = {}, cwd = vault) =>
	runGuard(["--prompt", "--vault-force", vault], { cwd, input: promptInput(sessionId, text), env: { ASTRONRAG_AUTO_RECALL: "1", ...env } });

/** 세션 시작 훅 한 번 */
const start = (vault, sessionId, source = "startup") =>
	runGuard(["--start", "--vault-force", vault], {
		cwd: vault,
		input: JSON.stringify({ hook_event_name: "SessionStart", session_id: sessionId, source }),
	});

/** 훅 stdout 의 JSON (비었으면 null, 깨졌으면 undefined) */
function parseOut(stdout) {
	if (stdout.trim() === "") return null;
	try {
		return JSON.parse(stdout);
	} catch {
		return undefined;
	}
}

const BLOCK = /<astronrag-auto-recall matched="(\d+)" note="자동 검색 결과\. 관련 없으면 무시\. 전문은 read_memory">\n([\s\S]*?)\n<\/astronrag-auto-recall>/;
const LINE = /^- \[([^\]]+)\] .+ \((episodic|semantic|procedural|preference), conf [0-9.]+, \d+일 전(, 대조 필요)?\)$/;

/** 훅 출력에서 additionalContext 와 자동 회상 블록·slug 를 뽑는다 */
function recallOf(stdout) {
	const o = parseOut(stdout);
	const context = o?.hookSpecificOutput?.additionalContext ?? "";
	const m = BLOCK.exec(context);
	const lines = m ? m[2].split("\n") : [];
	return { json: o, context, block: m?.[0] ?? "", matched: m ? Number(m[1]) : 0, lines, slugs: lines.map((l) => /^- \[([^\]]+)\]/.exec(l)?.[1] ?? "") };
}

/** 픽스처 볼트 사본을 만들고(extra 기억을 덧붙여) 서버와 같은 방식으로 역색인·MEMORY.md 를 만든다 */
function fixtureVault(tag, { index = true, extra = new Array() } = {}) {
	const d = tempDir(tag);
	fs.cpSync(fixture, d, { recursive: true });
	const now = new Date().toISOString();
	for (const m of extra) {
		const fm = [
			"---",
			`id: mem-${m.slug}`,
			`title: "${m.title}"`,
			`description: "${m.description}"`,
			"type: semantic",
			"tags:",
			...m.tags.map((t) => `  - "${t}"`),
			"confidence: 0.9",
			"storage_strength: 2",
			`status: ${m.status ?? "active"}`,
			...["created", "updated", "last_accessed", "last_reinforced"].map((k) => `${k}: '${now}'`),
			"access_count: 3",
			"links: []",
			"history: []",
			"---",
		];
		fs.writeFileSync(path.join(d, "memories", `${m.slug}.md`), `${fm.join("\n")}\n\n${m.body}\n`, "utf-8");
	}
	if (index) {
		const s = new MemoryStore(new Vault(d));
		s.reinforce = () => {};
		s.searchDetailed("warm up index", { limit: 1 });
		s.regenerateIndex();
		if (!fs.existsSync(path.join(d, INDEX_DIR, INDEX_FILE))) throw new Error(`역색인이 만들어지지 않았다: ${d}`);
	}
	return d;
}

/** 시험 프로세스에서 같은 규칙(활성·미주입 필터 → 절대 임계·1위 대비 비율 → 최대 건수)으로 고른 slug. 결과를 자르지 않고 전부 받아 계산한다 */
function expectedSlugs(vault, query, minScore = MIN_SCORE, project = undefined, injected = new Array()) {
	const active = searchPersistedIndex(vault, query, { limit: 1000, project }).results.filter((r) => r.record.status === "active");
	const top = Math.max(0, ...active.map((r) => r.score));
	return active
		.filter((r) => r.score >= minScore && r.score >= top * RELATIVE && !injected.includes(r.record.slug))
		.sort((a, b) => b.score - a.score)
		.slice(0, MAX)
		.map((r) => r.record.slug);
}

/** nearest-rank 백분위수 */
function pctl(xs, p) {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.max(0, Math.ceil(p * s.length) - 1)];
}
const stat = (xs) => ({ p50: Number(pctl(xs, 0.5).toFixed(1)), p95: Number(pctl(xs, 0.95).toFixed(1)) });

/** jsonl 파일의 행 */
const readJsonl = (fp) =>
	fs
		.readFileSync(fp, "utf-8")
		.split(/\r?\n/)
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));

function cleanup() {
	for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
}

// ── --eval: 새 질의로 none 오탐률·exact R@1·주입 크기·중복 노출을 잰다
if (values.eval) {
	try {
		const v = fixtureVault("eval");
		const sessionStart = start(v, "EVAL-START").stdout;
		const measure = (rows) => {
			const per = rows.map((row, i) => {
				const r = recallOf(prompt(v, `EVAL-${i}`, row.query).stdout);
				return { ...row, slugs: r.slugs, chars: r.context.length };
			});
			const none = per.filter((p) => p.split === "none");
			const exact = per.filter((p) => p.split === "exact");
			const injected = per.filter((p) => p.slugs.length > 0);
			const slugs = injected.flatMap((p) => p.slugs);
			const dup = slugs.filter((s) => sessionStart.includes(`memories/${s}|`));
			return {
				none: { n: none.length, falsePositive: none.filter((p) => p.slugs.length > 0).length, rate: none.length ? none.filter((p) => p.slugs.length > 0).length / none.length : null, hits: none.filter((p) => p.slugs.length > 0).map((p) => ({ query: p.query, slugs: p.slugs })) },
				exact: { n: exact.length, r1: exact.length ? exact.filter((p) => p.expected.includes(p.slugs[0])).length / exact.length : null, misses: exact.filter((p) => !p.expected.includes(p.slugs[0])).map((p) => ({ query: p.query, expected: p.expected, got: p.slugs })) },
				injection: { turns: injected.length, avgChars: injected.length ? Math.round(injected.reduce((a, p) => a + p.chars, 0) / injected.length) : 0, maxChars: Math.max(0, ...injected.map((p) => p.chars)), avgItems: injected.length ? Number((slugs.length / injected.length).toFixed(2)) : 0 },
				duplicateWithSessionStart: { injectedSlugs: slugs.length, alsoInSessionStart: dup.length, rate: slugs.length ? Number((dup.length / slugs.length).toFixed(3)) : null },
			};
		};
		const file = path.resolve(values.queries ?? path.join(root, "eval", "autorecall-fresh.jsonl"));
		const main = measure(readJsonl(file));
		const golden = readJsonl(path.join(root, "eval", "golden.jsonl"));
		const holdout = values.queries === undefined ? measure(golden.filter((g) => g.holdout && (g.split === "none" || g.split === "exact"))) : undefined;
		const ok = main.none.rate !== null && main.none.rate <= 0.1 && main.exact.r1 !== null && main.exact.r1 >= 0.8;
		process.stdout.write(
			`${JSON.stringify({ scorer: SCORER, minScore, relative: RELATIVE, queries: path.relative(root, file), sessionStartLines: sessionStart.split("\n").length, main, goldenHoldout: holdout, criterion: { metric: "main.none.rate <= 0.1 그리고 main.exact.r1 >= 0.8", ok } }, null, 2)}\n`,
		);
		if (!ok) process.exitCode = 1;
	} finally {
		cleanup();
	}
	process.exit(process.exitCode ?? 0);
}

// ── --sweep: 튜닝에 쓴 기존 데이터(golden none·exact 전체 + fresh)로 하한 후보를 고른다. 훅과 같은 규칙(expectedSlugs)을 시험 프로세스에서 계산한다
if (values.sweep) {
	try {
		const v = fixtureVault("sweep");
		const golden = readJsonl(path.join(root, "eval", "golden.jsonl")).filter((g) => g.split === "none" || g.split === "exact");
		const fresh = readJsonl(path.join(root, "eval", "autorecall-fresh.jsonl"));
		const rows = [...golden.map((r) => ({ ...r, source: "golden" })), ...fresh.map((r) => ({ ...r, source: "fresh" }))];
		// 훅은 8자 미만·슬래시 명령을 검색하지 않는다 — 같은 규칙으로 뺀다
		const searched = (q) => q.trim().length >= 8 && !q.trim().startsWith("/");
		const active = rows.map((r) => (searched(r.query) ? searchPersistedIndex(v, r.query, { limit: 1000 }).results.filter((x) => x.record.status === "active") : []));
		const pick = (list, T) => {
			const top = Math.max(0, ...list.map((x) => x.score));
			return list.filter((x) => x.score >= T && x.score >= top * RELATIVE).sort((a, b) => b.score - a.score).slice(0, MAX).map((x) => x.record.slug);
		};
		const rate = (xs, f) => (xs.length === 0 ? null : xs.filter(f).length / xs.length);
		const point = (T, keep) => {
			const idx = rows.map((_, i) => i).filter((i) => keep(rows[i]));
			const none = idx.filter((i) => rows[i].split === "none");
			const exact = idx.filter((i) => rows[i].split === "exact");
			return {
				noneRate: rate(none, (i) => pick(active[i], T).length > 0),
				exactR1: rate(exact, (i) => rows[i].expected.includes(pick(active[i], T)[0])),
				n: { none: none.length, exact: exact.length },
			};
		};
		const grid = Array.from({ length: 41 }, (_, i) => i * 0.5).map((T) => ({ T, all: point(T, () => true), golden: point(T, (r) => r.source === "golden"), fresh: point(T, (r) => r.source === "fresh") }));
		const eligible = grid.filter((p) => (p.all.noneRate ?? 1) <= 0.1);
		const best = eligible.length === 0 ? null : eligible.reduce((b, p) => ((p.all.exactR1 ?? 0) > (b.all.exactR1 ?? 0) ? p : b));
		const topScores = active.map((l) => Math.max(0, ...l.map((x) => x.score)));
		process.stdout.write(
			`${JSON.stringify({ scorer: SCORER, relative: RELATIVE, max: MAX, rows: rows.length, rule: "all 의 none 오탐률 <= 0.1 인 T 가운데 exact R@1 최대, 동률이면 작은 T", candidate: best, maxTopScore: Math.max(...topScores), grid }, null, 2)}\n`,
		);
	} finally {
		cleanup();
	}
	process.exit(0);
}

// ── --bench: 합성 볼트에서 훅 끝단과 단계별 시간
if (values.bench) {
	const count = Number(values.count);
	const rounds = Number(values.rounds);
	const seed = Number(values.seed);
	if (![count, rounds, seed].every(Number.isInteger) || count < 10 || rounds < 1) {
		console.error("regress-auto-recall: --count 는 10 이상, --rounds 는 1 이상, --seed 는 정수여야 한다");
		process.exit(2);
	}
	const { buildVault, mulberry32 } = await import(pathToFileURL(path.join(here, "bench-rif.mjs")).href);
	try {
		const dir = tempDir("bench");
		const queries = buildVault(new Vault(dir), count, mulberry32(seed));
		const s = new MemoryStore(new Vault(dir));
		s.reinforce = () => {};
		s.searchDetailed(queries[0].query, { limit: 1 });
		if (!fs.existsSync(path.join(dir, INDEX_DIR, INDEX_FILE))) throw new Error("역색인이 만들어지지 않았다");
		const indexBytes = fs.statSync(path.join(dir, INDEX_DIR, INDEX_FILE)).size;
		// bench-rif 질의가 임계를 못 넘으면 첫 기억의 제목을 주입되는 질의로 쓴다
		const titled = [...queries, { label: "title", query: new Vault(dir).read(new Vault(dir).listSlugs(false)[0].slug)?.title ?? "" }];
		const hit = titled.find((q) => expectedSlugs(dir, `please check ${q.query} again`, minScore).length > 0);
		const cases = [
			...(hit ? [{ label: `hit(${hit.label})`, text: `please check ${hit.query} again` }] : []),
			{ label: "miss", text: "please check this unrelated thing again" },
		];
		const marker = path.join(dir, ".bbm-session-start");
		const fileCount = fs.readdirSync(path.join(dir, "memories")).length;
		const hookRuns = (text) => {
			const runs = Array.from({ length: rounds }, () => {
				// 매 회 같은 세션의 첫 프롬프트로 되돌린다 — 중복 제거·큐 쿨다운이 측정을 바꾸지 않게
				fs.writeFileSync(marker, JSON.stringify({ sessionId: "BENCH", count: fileCount, total: fileCount, warned: false }), "utf-8");
				return prompt(dir, "BENCH", text);
			});
			return { ms: stat(runs.map((r) => r.ms)), injectedRuns: runs.filter((r) => recallOf(r.stdout).slugs.length > 0).length, statusOk: runs.every((r) => r.status === 0) };
		};
		const wall = (args) => stat(Array.from({ length: rounds }, () => {
			const t0 = performance.now();
			spawnSync(process.execPath, args, { encoding: "utf-8", env: hookEnv() });
			return performance.now() - t0;
		}));
		const emptyNode = wall(["-e", ""]);
		const importOnly = wall(["--input-type=module", "-e", `await import(${JSON.stringify(distUrl("store.js"))});`]);
		// 자식 안에서 단계를 나눠 잰다: 기동(프로세스 시작~첫 코드)·import·인덱스 적재·검색(순위화, 훅의 첫 요청과 같은 limit)·stat(반환 후보 신원 대조)
		const phaseCode = (text) => `const t0 = performance.now();
const { parseQuery } = await import(${JSON.stringify(distUrl("store.js"))});
const { LexicalRetriever } = await import(${JSON.stringify(distUrl("retriever.js"))});
const { rank } = await import(${JSON.stringify(distUrl("ranker.js"))});
const t1 = performance.now();
const retriever = LexicalRetriever.openReadOnly(${JSON.stringify(dir)});
const t2 = performance.now();
const q = parseQuery(${JSON.stringify(text)});
const ranked = rank(retriever.search(q, Infinity, {}, ${JSON.stringify(SCORER)}), q, { limit: ${MAX * 2}, now: Date.now(), includeLinked: false });
const t3 = performance.now();
for (const r of ranked.results) retriever.isCurrent(r.record.slug);
const t4 = performance.now();
process.stdout.write(JSON.stringify({ bootMs: t0, importMs: t1 - t0, loadMs: t2 - t1, searchMs: t3 - t2, statMs: t4 - t3 }));`;
		const phases = (text) => {
			const runs = Array.from({ length: rounds }, () => JSON.parse(spawnSync(process.execPath, ["--input-type=module", "-e", phaseCode(text)], { encoding: "utf-8", env: hookEnv() }).stdout));
			return Object.fromEntries(Object.keys(runs[0]).map((k) => [k, stat(runs.map((r) => r[k]))]));
		};
		const rows = cases.map((c) => ({ label: c.label, hook: hookRuns(c.text), phases: phases(c.text) }));
		const worstP95 = Math.max(...rows.map((r) => r.hook.ms.p95));
		// 중복 노출: SessionStart 인덱스 한 번과, bench 질의 전부·시드 고정으로 뽑은 기억 제목 30건의 자동 주입(질의마다 새 세션)을 대조한다
		s.regenerateIndex(); // SessionStart 가 읽는 MEMORY.md 를 서버와 같은 방식으로 만든다
		const sessionStart = start(dir, "DUP-START").stdout;
		const all = new Vault(dir).listSlugs(false).map(({ slug }) => slug);
		const rnd = mulberry32(seed + 1);
		const sampled = Array.from({ length: Math.min(30, all.length) }, () => all.splice(Math.floor(rnd() * all.length), 1)[0]);
		const dupQueries = [...queries.map((q) => q.query), ...sampled.map((slug) => new Vault(dir).read(slug)?.title ?? "")];
		const perTurn = dupQueries.map((text, i) => recallOf(prompt(dir, `DUP-${i}`, text).stdout).slugs);
		const injectedSlugs = perTurn.flat();
		const alsoInStart = injectedSlugs.filter((s) => sessionStart.includes(`memories/${s}|`)).length;
		const duplicateWithSessionStart = {
			queries: dupQueries.length,
			injectedTurns: perTurn.filter((s) => s.length > 0).length,
			injectedSlugs: injectedSlugs.length,
			alsoInSessionStart: alsoInStart,
			rate: injectedSlugs.length ? Number((alsoInStart / injectedSlugs.length).toFixed(3)) : null,
			sessionStartLines: sessionStart.split("\n").length,
		};
		process.stdout.write(
			`${JSON.stringify({ count, rounds, seed, scorer: SCORER, minScore, node: process.version, indexBytes, emptyNode, importStoreOnly: importOnly, rows, duplicateWithSessionStart, criterion: { metric: "hook spawn~종료 p95", limitMs: LATENCY_LIMIT_MS, worstP95, ok: worstP95 <= LATENCY_LIMIT_MS } }, null, 2)}\n`,
		);
		if (!hit || !rows.every((r) => r.hook.statusOk) || rows[0].hook.injectedRuns !== rounds || worstP95 > LATENCY_LIMIT_MS) process.exitCode = 1;
	} finally {
		cleanup();
	}
	process.exit(process.exitCode ?? 0);
}

// ── 회귀 단언
let failures = 0;
function check(name, cond, detail = "") {
	if (cond) console.log(`  ✔ ${name}`);
	else {
		failures++;
		console.error(`  ✘ ${name} ${detail}`);
	}
}

const EXACT = "Which Node version do we pin for services?";
const EXACT_SLUG = "node-version-pin";
const CORRECTION = `아니야 그게 아니라 ${EXACT}`;

try {
	const v = fixtureVault("main");
	env_new_names_preserve_recall_limits_and_order();

	console.log("0) 전제");
	{
		check("exact 질의가 시험 프로세스 기준으로 임계를 넘는다", expectedSlugs(v, EXACT)[0] === EXACT_SLUG, JSON.stringify(expectedSlugs(v, EXACT)));
	}

	console.log("1) 짧은 프롬프트·슬래시 명령·prompt 부재는 건너뛴다");
	{
		const low = { ASTRONRAG_AUTO_MIN_SCORE: "0" };
		check("7자 프롬프트는 무출력", prompt(v, "S1", "nvmrc!!", low).stdout === "");
		check("앞뒤 공백을 빼고 7자면 무출력", prompt(v, "S1", "   nvmrc!!   ", low).stdout === "");
		check("8자 프롬프트는 검색한다", recallOf(prompt(v, "S1", "nvmrc!!!", low).stdout).slugs.includes(EXACT_SLUG));
		check("/ 로 시작하면 무출력", prompt(v, "S1", `/model ${EXACT}`, low).stdout === "");
		const none = prompt(v, "S1", undefined, low);
		check("prompt 필드가 없으면 무출력·종료코드 0", none.stdout === "" && none.status === 0, `${none.status} ${none.stdout.slice(0, 100)}`);
	}

	console.log("2) 코드블록 제외·앞 500자");
	{
		check("대조군: 같은 질문을 그대로 쓰면 주입", recallOf(prompt(v, "S2", EXACT).stdout).slugs.includes(EXACT_SLUG));
		const fenced = `이 코드 좀 봐줘 부탁해\n\`\`\`\n${EXACT} nvmrc\n\`\`\`\n`;
		check("``` 펜스 안에만 있는 일치어는 무시", !recallOf(prompt(v, "S2", fenced).stdout).slugs.includes(EXACT_SLUG));
		const tilde = `이 코드 좀 봐줘 부탁해\n~~~ts\n${EXACT} nvmrc\n~~~\n`;
		check("~~~ 펜스 안에만 있는 일치어는 무시", !recallOf(prompt(v, "S2", tilde).stdout).slugs.includes(EXACT_SLUG));
		const open = `이 코드 좀 봐줘 부탁해\n\`\`\`\n${EXACT} nvmrc`;
		check("닫히지 않은 펜스는 끝까지 무시", !recallOf(prompt(v, "S2", open).stdout).slugs.includes(EXACT_SLUG));
		const after = `${EXACT}\n\`\`\`\nconst x = 1;\n\`\`\``;
		check("펜스 밖의 일치어는 그대로 쓴다", recallOf(prompt(v, "S2", after).stdout).slugs.includes(EXACT_SLUG));
		const long = `${"ㅋ".repeat(500)} ${EXACT}`;
		check("500자 뒤에만 있는 일치어는 무시", !recallOf(prompt(v, "S2", long).stdout).slugs.includes(EXACT_SLUG));
	}

	console.log("3) 출력 형식 — hookSpecificOutput.additionalContext JSON 하나");
	{
		const out = prompt(v, "S3", EXACT);
		const r = recallOf(out.stdout);
		check("stdout 이 JSON 한 줄", r.json && out.stdout.trim().split("\n").length === 1, out.stdout.slice(0, 200));
		check("hookEventName 이 UserPromptSubmit", r.json?.hookSpecificOutput?.hookEventName === "UserPromptSubmit");
		check("최상위 additionalContext 없음", r.json && !("additionalContext" in r.json));
		check("블록 태그 형식", r.block !== "" && r.context === r.block, r.context.slice(0, 300));
		check("matched 가 줄 수와 같고 1~3", r.matched === r.lines.length && r.matched >= 1 && r.matched <= MAX, `${r.matched}/${r.lines.length}`);
		check("줄 형식 - [slug] 설명 (type, conf, N일 전[, 대조 필요])", r.lines.every((l) => LINE.test(l)), r.lines.join(" | "));
		check("본문 전체는 싣지 않는다", !r.context.includes("CI reads .nvmrc"), r.context.slice(0, 300));
		check("종료코드 0", out.status === 0);
	}

	console.log("4) 선택 규칙 — 절대 임계 9·1위 대비 50%·최대 3건");
	{
		const queries = [
			...readJsonl(path.join(root, "eval", "autorecall-fresh.jsonl")).map((r) => r.query),
			"production deploy procedure and rollback",
			"커넥션 풀 고갈 장애",
		];
		const diffs = queries.flatMap((q, i) => {
			const got = recallOf(prompt(v, `S4-${i}`, q).stdout).slugs;
			const want = expectedSlugs(v, q);
			return JSON.stringify(got) === JSON.stringify(want) ? [] : [`${q}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`];
		});
		check("훅 결과가 같은 규칙의 시험 프로세스 계산과 같다", diffs.length === 0, diffs.join("\n    "));
		check("ASTRONRAG_AUTO_MIN_SCORE 로 임계를 바꾼다", prompt(v, "S4", EXACT, { ASTRONRAG_AUTO_MIN_SCORE: "1e9" }).stdout === "");
		const low = recallOf(prompt(v, "S4", EXACT, { ASTRONRAG_AUTO_MIN_SCORE: "0" }).stdout).slugs;
		check("임계 0 에서도 1위 대비 50% 규칙과 최대 3건을 지킨다", JSON.stringify(low) === JSON.stringify(expectedSlugs(v, EXACT, 0)) && low.length <= MAX, JSON.stringify(low));
	}

	console.log("5) 같은 세션 안에서 한 번만");
	{
		start(v, "D1");
		const first = recallOf(prompt(v, "D1", EXACT).stdout);
		const marker = () => JSON.parse(fs.readFileSync(path.join(v, ".bbm-session-start"), "utf-8"));
		check("첫 턴에 주입", first.slugs.includes(EXACT_SLUG));
		check("마커에 주입한 slug 가 남는다", marker().autoSlugs?.includes(EXACT_SLUG), JSON.stringify(marker()));
		const second = recallOf(prompt(v, "D1", EXACT).stdout);
		check("같은 세션 두 번째 턴에는 다시 넣지 않는다", !second.slugs.includes(EXACT_SLUG), second.context.slice(0, 200));
		check("마커의 slug 가 중복 없이 유지된다", marker().autoSlugs.filter((s) => s === EXACT_SLUG).length === 1, JSON.stringify(marker().autoSlugs));
		check("다른 세션 프롬프트에는 다시 주입", recallOf(prompt(v, "D2", EXACT).stdout).slugs.includes(EXACT_SLUG));
		start(v, "D1", "compact");
		check("압축(compact) 뒤에는 목록을 비운다", marker().autoSlugs.length === 0, JSON.stringify(marker()));
		check("압축 뒤에는 다시 주입", recallOf(prompt(v, "D1", EXACT).stdout).slugs.includes(EXACT_SLUG));
	}

	function env_new_names_preserve_recall_limits_and_order() {
		console.log("env_new_names_preserve_recall_limits_and_order");
		console.log("5-1) 필터 뒤에 자른다 — 이미 주입한 상위·superseded 가 새 후보를 가리지 않는다");
		{
			const topics = ["alpha replica failover", "billing webhook retries", "cache warmup schedule", "docker layer pruning", "email bounce handling"];
			const kw = ["quibbit", "gateway", "quota", "burst", "window", "region", "tenant", "throttle"];
			const lv = fixtureVault("limit", {
				extra: [
					...topics.map((t, i) => ({ slug: `zorblax-${i + 1}`, title: `Zorblax ${t}`, description: `zorblax ${t} notes`, tags: ["zorblax"], body: `zorblax runbook for ${t}.` })),
					{ slug: "quibbit-old", title: `Quibbit ${kw.slice(1).join(" ")}`, description: kw.join(" "), tags: kw, body: `${kw.join(" ")}.`, status: "superseded" },
					{ slug: "quibbit-frontend", title: "Quibbit gateway", description: "browser checkout calls it", tags: ["quibbit"], body: "frontend." },
					{ slug: "quibbit-mobile", title: "Quibbit quota", description: "ios android clients share one", tags: ["quibbit"], body: "mobile." },
					{ slug: "quibbit-partner", title: "Quibbit burst", description: "resellers negotiate higher ceilings", tags: ["quibbit"], body: "partner." },
				],
			});
			const Z = "zorblax runbook notes please";
			const zAll = expectedSlugs(lv, Z, MIN_SCORE, undefined, []);
			check("전제: 임계를 넘는 zorblax 후보가 3건을 넘는다", searchPersistedIndex(lv, Z, { limit: 1000 }).results.filter((r) => r.score >= MIN_SCORE).length > MAX, JSON.stringify(zAll));
			start(lv, "L1");
			const z1 = recallOf(prompt(lv, "L1", Z).stdout).slugs;
			const z2 = recallOf(prompt(lv, "L1", Z).stdout).slugs;
			check("첫 턴에 3건 주입", z1.length === MAX, JSON.stringify(z1));
			check("둘째 턴에 상위 3건 뒤의 새 후보를 주입", z2.length > 0 && z2.every((s) => !z1.includes(s)), `${JSON.stringify(z1)} → ${JSON.stringify(z2)}`);
			check("둘째 턴이 이미 주입한 것을 뺀 같은 규칙의 계산과 같다", JSON.stringify(z2) === JSON.stringify(expectedSlugs(lv, Z, MIN_SCORE, undefined, z1)), JSON.stringify(z2));

			const Q = kw.join(" ");
			const top3 = searchPersistedIndex(lv, Q, { limit: MAX }).results.map((r) => r.record.status);
			check("전제: superseded 기억이 상위 3건에 낀다", top3.includes("superseded"), JSON.stringify(top3));
			const q1 = recallOf(prompt(lv, "L2", Q).stdout).slugs;
			const want = ["quibbit-frontend", "quibbit-mobile", "quibbit-partner"];
			check("superseded 가 낀 자리를 활성 후보로 채워 3건 주입", q1.length === MAX && want.every((s) => q1.includes(s)), JSON.stringify(q1));
			check("superseded 는 주입하지 않는다", !q1.includes("quibbit-old"), JSON.stringify(q1));
			check("superseded 질의가 같은 규칙의 계산과 같다", JSON.stringify(q1) === JSON.stringify(expectedSlugs(lv, Q)), JSON.stringify(q1));
		}
		console.log("7) 예산 — ASTRONRAG_AUTO_BUDGET");
		{
			const full = recallOf(prompt(v, "S7", EXACT).stdout);
			check("기본 예산 1500자 이하", full.block.length > 0 && full.context.length <= 1500, `${full.context.length}`);
			const small = recallOf(prompt(v, "S7", EXACT, { ASTRONRAG_AUTO_BUDGET: "200" }).stdout);
			check("예산 200 이면 블록이 200자 이하", small.block !== "" && small.context.length <= 200, `${small.context.length}`);
			check("줄이 안 들어가면 설명을 잘라 첫 줄만 넣는다", small.matched === 1 && small.lines[0].includes("…") && small.slugs[0] === full.slugs[0], small.context);
			check("태그만으로 예산을 넘으면 무출력", prompt(v, "S7", EXACT, { ASTRONRAG_AUTO_BUDGET: "40" }).stdout === "");
		}
	}
	console.log("6) 마커 호환 — 구버전 훅·구형 마커");
	{
		const markerPath = path.join(v, ".bbm-session-start");
		const old = (() => {
			try {
				return execFileSync("git", ["show", "4ba3578:scripts/session-guard.mjs"], { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
			} catch {
				return null;
			}
		})();
		if (old === null) console.log("  - 건너뜀: git 으로 구버전(4ba3578) 훅을 꺼낼 수 없다");
		else {
			const oldGuard = path.join(tempDir("old"), "session-guard.mjs");
			fs.writeFileSync(oldGuard, old, "utf-8");
			const n = fs.readdirSync(path.join(v, "memories")).length;
			fs.writeFileSync(markerPath, JSON.stringify({ sessionId: "OLD", count: n, total: n, warned: false, autoSlugs: [EXACT_SLUG, "x"] }), "utf-8");
			const out = runGuard(["--prompt", "--vault-force", v], { cwd: v, script: oldGuard, input: JSON.stringify({ session_id: "OLD", prompt: "아니야 틀렸어 그게 아니라" }) });
			check("구버전 훅이 autoSlugs 마커로 종료코드 0", out.status === 0, `${out.status}`);
			check("구버전 훅의 큐 동작은 그대로", /<bigbrainmemory-cue/.test(out.stdout), out.stdout.slice(0, 200));
			const stop = runGuard(["--stop", "--vault-force", v], { cwd: v, script: oldGuard, input: JSON.stringify({ session_id: "OLD" }) });
			check("구버전 Stop 훅도 종료코드 0", stop.status === 0, `${stop.status}`);
			check("구버전 훅이 쓴 마커도 JSON 으로 남는다", (() => {
				try {
					return typeof JSON.parse(fs.readFileSync(markerPath, "utf-8")).count === "number";
				} catch {
					return false;
				}
			})());
		}
		const n = fs.readdirSync(path.join(v, "memories")).length;
		fs.writeFileSync(markerPath, String(n), "utf-8");
		const legacy = prompt(v, "LEGACY", EXACT);
		check("숫자 하나짜리 구형 마커에서도 주입", legacy.status === 0 && recallOf(legacy.stdout).slugs.includes(EXACT_SLUG), legacy.stdout.slice(0, 200));
		check("구형 마커를 JSON 으로 올리며 slug 를 기록", JSON.parse(fs.readFileSync(markerPath, "utf-8")).autoSlugs?.includes(EXACT_SLUG));
		fs.writeFileSync(markerPath, JSON.stringify({ sessionId: "NOSLUG", count: n, total: n, warned: false }), "utf-8");
		const noField = prompt(v, "NOSLUG", EXACT);
		check("autoSlugs 없는 마커에서도 주입", recallOf(noField.stdout).slugs.includes(EXACT_SLUG));
		const stop = runGuard(["--stop", "--vault-force", v], { cwd: v, input: JSON.stringify({ session_id: "NOSLUG" }) });
		check("Stop 훅이 autoSlugs 를 보존", stop.status === 0 && JSON.parse(fs.readFileSync(markerPath, "utf-8")).autoSlugs?.includes(EXACT_SLUG), fs.readFileSync(markerPath, "utf-8"));
	}

	console.log("8) 대조 필요(T49 세 번째 채널)·프로젝트 범위");
	{
		const d = tempDir("stale");
		const vault = new Vault(d);
		const now = new Date().toISOString();
		// 공유 단어는 zorblat 하나뿐이다 — 제목·설명이 겹쳐 측면억제로 점수가 갈리지 않게 한다
		const rec = (slug, words, extra) => ({
			id: `mem-${slug}`, slug, title: `Zorblat ${words[0]} ${words[1]}`, description: `zorblat ${words[2]} ${words[3]}`,
			type: "semantic", tags: ["zorblat"], confidence: 0.9, storageStrength: 1, status: "active",
			created: now, updated: now, lastAccessed: now, lastReinforced: now, accessCount: 0, links: [],
			history: ["2026-01-01: created"], body: `zorblat ${words.join(" ")}`, ...extra,
		});
		vault.write(rec("fresh-one", ["kiwi", "mango", "papaya", "lemon"], {}));
		vault.write(rec("overdue-one", ["walnut", "almond", "pecan", "cashew"], { reviewAfter: "2020-01-01" }));
		vault.write(rec("other-project", ["tulip", "daisy", "orchid", "lotus"], { project: "other" }));
		const s = new MemoryStore(new Vault(d));
		s.reinforce = () => {};
		s.searchDetailed("zorblat", { limit: 1 });
		const Q8 = "zorblat please";
		const r = recallOf(prompt(d, "S8", Q8).stdout);
		const lineOf = (slug) => r.lines.find((l) => l.startsWith(`- [${slug}]`)) ?? "";
		check("review_after 가 지난 기억에 대조 필요", lineOf("overdue-one").endsWith(", 대조 필요)"), r.context);
		check("새 기억에는 대조 필요 없음", lineOf("fresh-one") !== "" && !lineOf("fresh-one").includes("대조 필요"), r.context);
		check("나이는 0일 전", / 0일 전/.test(lineOf("fresh-one")), lineOf("fresh-one"));
		check("범위 미지정이면 다른 프로젝트 기억도 후보", r.slugs.includes("other-project"), JSON.stringify(r.slugs));
		const scoped = recallOf(prompt(d, "S8", Q8, { ASTRONRAG_PROJECT: "mine" }).stdout);
		check("ASTRONRAG_PROJECT 로 다른 프로젝트 기억을 뺀다", !scoped.slugs.includes("other-project") && scoped.slugs.length > 0, JSON.stringify(scoped.slugs));
		const cwd = tempDir("proj");
		fs.writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { astronrag: { command: "node", env: { ASTRONRAG_PROJECT: "mine" } } } }), "utf-8");
		const viaCfg = recallOf(prompt(d, "S8", Q8, {}, cwd).stdout);
		check("프로젝트 .mcp.json 의 ASTRONRAG_PROJECT 를 따른다", !viaCfg.slugs.includes("other-project") && viaCfg.slugs.length > 0, JSON.stringify(viaCfg.slugs));
	}

	console.log("9) 인덱스가 없거나 깨졌으면 조용히 끝낸다");
	{
		const bare = fixtureVault("noindex", { index: false });
		const out = prompt(bare, "S9", EXACT);
		check("인덱스 없음 → 무출력·종료코드 0", out.stdout === "" && out.status === 0, `${out.status} ${out.stdout.slice(0, 100)}`);
		check("인덱스를 만들지 않는다", !fs.existsSync(path.join(bare, INDEX_DIR)));
		const broken = fixtureVault("broken");
		const fp = path.join(broken, INDEX_DIR, INDEX_FILE);
		fs.writeFileSync(fp, "{ 깨진 인덱스", "utf-8");
		const before = fs.readFileSync(fp);
		const out2 = prompt(broken, "S9", EXACT);
		check("깨진 인덱스 → 무출력·종료코드 0", out2.stdout === "" && out2.status === 0, `${out2.status} ${out2.stdout.slice(0, 100)}`);
		check("깨진 인덱스를 고쳐 쓰지 않는다", Buffer.compare(before, fs.readFileSync(fp)) === 0);
	}

	console.log("10) 강화 없음 — 기억 파일·인덱스·저장강도·접근 시각이 그대로");
	{
		const w = fixtureVault("noreinforce");
		const files = [...fs.readdirSync(path.join(w, "memories")).map((f) => path.join(w, "memories", f)), path.join(w, INDEX_DIR, INDEX_FILE)];
		const snap = () => files.map((f) => `${f}|${crypto.createHash("sha1").update(fs.readFileSync(f)).digest("hex")}|${fs.statSync(f).mtimeMs}`).join("\n");
		const strengths = () => JSON.stringify(new Vault(w).listSlugs(false).map(({ slug }) => {
			const m = new Vault(w).read(slug);
			return [slug, m?.storageStrength, m?.lastAccessed, m?.accessCount];
		}));
		const beforeFiles = snap();
		const beforeStrength = strengths();
		let injected = 0;
		for (const [i, q] of [EXACT, "DB 백업을 복원해서 검증하는 방법 알려줘", "Connection pool exhaustion outage"].entries()) {
			injected += recallOf(prompt(w, `S10-${i}`, q).stdout).slugs.length;
		}
		check("주입이 실제로 일어났다", injected > 0, `${injected}`);
		check("기억 파일·인덱스 바이트와 mtime 불변", snap() === beforeFiles);
		check("storage_strength·last_accessed·access_count 불변", strengths() === beforeStrength);
	}

	console.log("11) 사용 로그 — 건수·1위 점수만, 질의 내용 없음");
	{
		const w = fixtureVault("log");
		prompt(w, "S11", EXACT);
		const raw = fs.readFileSync(path.join(w, ".bbm-usage.jsonl"), "utf-8");
		const last = JSON.parse(raw.trim().split("\n").at(-1) ?? "{}");
		check("tool: auto_recall", last.tool === "auto_recall", JSON.stringify(last));
		check("injected 와 topScore 가 수치", Number.isInteger(last.injected) && last.injected >= 1 && typeof last.topScore === "number" && last.topScore >= MIN_SCORE, JSON.stringify(last));
		check("프롬프트 문자열이 로그에 없다", !raw.includes("Which Node version") && !raw.includes("services"));
		prompt(w, "S11", "How do I center a div vertically with flexbox?");
		const miss = JSON.parse(fs.readFileSync(path.join(w, ".bbm-usage.jsonl"), "utf-8").trim().split("\n").at(-1) ?? "{}");
		check("주입 0건도 기록한다", miss.tool === "auto_recall" && miss.injected === 0, JSON.stringify(miss));
	}

	console.log("12) 기본 끔 — ASTRONRAG_AUTO_RECALL=1 일 때만 주입");
	{
		const unset = runGuard(["--prompt", "--vault-force", v], { cwd: v, input: promptInput("S12", EXACT) });
		check("변수 미설정이면 무출력·종료코드 0", unset.stdout === "" && unset.status === 0, `${unset.status} ${unset.stdout.slice(0, 100)}`);
		check("0 이면 무출력", prompt(v, "S12", EXACT, { ASTRONRAG_AUTO_RECALL: "0" }).stdout === "");
		check("true 처럼 1 이 아닌 값이면 무출력", prompt(v, "S12", EXACT, { ASTRONRAG_AUTO_RECALL: "true" }).stdout === "");
		check("1 이면 주입", recallOf(prompt(v, "S12", EXACT, { ASTRONRAG_AUTO_RECALL: "1" }).stdout).slugs.includes(EXACT_SLUG));
		const w = fixtureVault("off-cue");
		start(w, "S12C");
		const cue = runGuard(["--prompt", "--vault-force", w], { cwd: w, input: promptInput("S12C", CORRECTION) });
		check("꺼져 있어도 부호화 큐는 그대로", /<astronrag-cue/.test(cue.stdout) && !cue.stdout.includes("<astronrag-auto-recall"), cue.stdout.slice(0, 200));
	}

	console.log("13) 부호화 큐와 한 JSON 으로 합친다");
	{
		const w = fixtureVault("merge");
		start(w, "M1");
		const out = prompt(w, "M1", CORRECTION);
		const r = recallOf(out.stdout);
		check("stdout 이 JSON 한 줄", r.json && out.stdout.trim().split("\n").length === 1, out.stdout.slice(0, 200));
		const ri = r.context.indexOf("<astronrag-auto-recall");
		const ci = r.context.indexOf("<astronrag-cue");
		check("회상 블록과 큐 블록이 모두 있다", ri >= 0 && ci >= 0, r.context.slice(0, 300));
		check("회상 블록이 큐 블록보다 앞", ri >= 0 && ri < ci);
		check("큐 문구는 그대로", /regex guess, not an observation/.test(r.context) && /mcp__[\w-]+__remember/.test(r.context));
		const cueOnly = prompt(w, "M1", "아니야 틀렸어", { ASTRONRAG_CUE_COOLDOWN: "1" });
		const c = recallOf(cueOnly.stdout);
		check("큐만 있어도 같은 JSON 형식", c.json?.hookSpecificOutput?.hookEventName === "UserPromptSubmit" && c.context.startsWith("<astronrag-cue"), cueOnly.stdout.slice(0, 200));
	}

	console.log("14) 훅 경로 import 목록 고정");
	{
		const src = fs.readFileSync(guard, "utf-8");
		const staticImports = [...src.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]).sort();
		check("session-guard 정적 import 는 node:fs·os·path 뿐", JSON.stringify(staticImports) === JSON.stringify(["node:fs", "node:os", "node:path"]), JSON.stringify(staticImports));
		const mod = await import("node:module");
		if (typeof mod.registerHooks !== "function") console.log("  - 건너뜀: module.registerHooks 가 없는 Node");
		else {
			const t = tempDir("imports");
			const preload = path.join(t, "track.mjs");
			const log = path.join(t, "loaded.json");
			fs.writeFileSync(
				preload,
				`import { registerHooks } from "node:module";\nimport { writeFileSync } from "node:fs";\nconst seen = new Set();\nregisterHooks({ resolve(s, c, next) { const r = next(s, c); seen.add(r.url); return r; } });\nprocess.on("exit", () => writeFileSync(${JSON.stringify(log)}, JSON.stringify([...seen])));\n`,
				"utf-8",
			);
			const out = prompt(v, "S14", EXACT, { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` });
			check("추적 중에도 주입", recallOf(out.stdout).slugs.includes(EXACT_SLUG), out.stdout.slice(0, 200));
			const loaded = JSON.parse(fs.readFileSync(log, "utf-8")).filter((u) => u.startsWith("file:")).map((u) => path.relative(root, fileURLToPath(u)).replace(/\\/g, "/"));
			const outside = loaded.filter((p) => !p.startsWith("dist/") && p !== "scripts/session-guard.mjs");
			check("node_modules·외부 모듈을 불러오지 않는다(gray-matter·zod·MCP SDK)", outside.length === 0, JSON.stringify(outside));
			const dist = loaded.filter((p) => p.startsWith("dist/")).sort();
			check(
				"dist 는 저장소 등록표와 검색 경로만",
				JSON.stringify(dist) === JSON.stringify([
					"dist/log.js",
					"dist/ranker.js",
					"dist/retriever.js",
					"dist/store.js",
					"dist/stores/file-store.js",
					"dist/stores/index.js",
					"dist/stores/memory-store.js",
					"dist/stores/sqlite-store.js",
					"dist/vault.js",
				]),
				JSON.stringify(dist),
			);
		}
	}

	console.log("15) setup-hook 이 UserPromptSubmit(--prompt) 를 등록한다 (임시 HOME·설정 파일)");
	{
		const t = tempDir("setup");
		const settings = path.join(t, "settings.json");
		const vault = path.join(t, "vault");
		fs.mkdirSync(vault);
		let code = 0;
		try {
			execFileSync(process.execPath, [path.join(here, "setup-hook.mjs"), "--settings", settings, "--vault", vault], {
				cwd: t,
				encoding: "utf-8",
				timeout: 60000,
				env: hookEnv(),
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err) {
			code = err.status ?? -1;
		}
		const cfg = fs.existsSync(settings) ? JSON.parse(fs.readFileSync(settings, "utf-8")) : {};
		const cmd = cfg.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command ?? "";
		check("setup-hook 종료코드 0", code === 0, `${code}`);
		check("UserPromptSubmit 명령에 --prompt", /session-guard\.mjs" --prompt /.test(cmd), cmd);
	}
} finally {
	cleanup();
}

if (failures > 0) {
	console.error(`\n실패: ${failures}건`);
	process.exit(1);
}
console.log("\nT44 자동 회상 회귀 테스트 통과 ✔");
