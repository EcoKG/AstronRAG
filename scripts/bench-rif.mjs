// RIF 비용 벤치 — 합성 볼트에서 구 RIF(쌍마다 재토큰화·전 후보 비교)와 신 RIF(사전 토큰·조기 종료)를 같은 입력으로 잰다.
//
// 사용:
//   node scripts/bench-rif.mjs [--base <기준 dist 디렉터리>] [--count 950] [--rounds 5] [--seed 42] [--cold]
//
// 볼트는 %TEMP% 에 만들고 끝나면 지운다. 제목·본문·slug 는 전부 시드 고정 가짜 음절이다.
// --base 를 주면 기준 dist 와 현재 dist 의 searchDetailed(limit 5) 끝단 시간·출력도 비교한다.
// --cold 는 역색인을 만든 뒤 질의마다 새 프로세스를 rounds 번 띄워 콜드 질의를 잰다(p95 를 보려면 --rounds 20 이상).
//   phases: node 기동·import·인덱스 적재·전체 stat 대조·검색(search+rank)을 단계별로 잰다.
//     인덱스 적재 + 검색의 p95 가 100ms 를 넘으면 1 로 끝난다(기동·import·전체 stat 대조 제외).
//   server(new Vault + searchDetailed)·hook(searchPersistedIndex)·base(--base 의 searchDetailed):
//     import·질의, 프로세스 시작~질의 끝, 부모가 잰 spawn~종료 시간을 잰다.
//   hookAllStale: 볼트를 fs.cpSync 로 복사해 모든 파일 신원이 바뀐 사본에서 hook 을 잰다(결과는 빈 목록이어야 한다).
//   지표마다 p50·p95 를 낸다.
// 시계는 고정하고 강화는 끈다. 구·신 출력이 하나라도 다르면 1 로 끝난다.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const NOW = Date.parse("2026-07-01T00:00:00.000Z");
const DAY = 86_400_000;
const LIMIT = 5;
const CLUSTER = 10;
/** 콜드 기준 — 새 프로세스에서 인덱스 적재 + 검색 p95 상한(ms) */
const COLD_LIMIT_MS = 100;

function die(msg, code = 2) {
	console.error(`bench-rif: ${msg}`);
	process.exit(code);
}

/** argv 를 옵션 객체로 해석한다 */
function readArgs(argv) {
	let values;
	try {
		({ values } = parseArgs({
			args: argv,
			options: {
				base: { type: "string" },
				count: { type: "string", default: "950" },
				rounds: { type: "string", default: "5" },
				seed: { type: "string", default: "42" },
				cold: { type: "boolean", default: false },
			},
		}));
	} catch (e) {
		die(e instanceof Error ? e.message : String(e));
	}
	const count = Number(values.count);
	const rounds = Number(values.rounds);
	const seed = Number(values.seed);
	if (!Number.isInteger(count) || count < CLUSTER) die(`--count 는 ${CLUSTER} 이상 정수여야 한다`);
	if (!Number.isInteger(rounds) || rounds < 1) die("--rounds 는 1 이상 정수여야 한다");
	if (!Number.isInteger(seed)) die("--seed 는 정수여야 한다");
	let base;
	if (values.base !== undefined) {
		base = path.resolve(values.base);
		for (const f of ["store.js", "vault.js"]) {
			if (!fs.existsSync(path.join(base, f))) die(`--base 디렉터리에 ${f} 가 없다: ${base}`);
		}
	}
	return { base, count, rounds, seed, cold: values.cold };
}

/** 시드 고정 32비트 난수 생성기 (mulberry32) */
function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** 서로 다른 가짜 음절 단어 n 개 */
function makeWords(rnd, n) {
	const cons = "bdgklmnprstvz";
	const vows = "aeiou";
	const out = new Set();
	while (out.size < n) {
		const syl = 2 + Math.floor(rnd() * 2);
		let w = "";
		for (let i = 0; i < syl; i++) w += cons[Math.floor(rnd() * cons.length)] + vows[Math.floor(rnd() * vows.length)];
		out.add(w);
	}
	return Array.from(out, String);
}

/**
 * 근접 중복 군집(CLUSTER 건씩) 볼트를 쓰고 질의 목록을 돌려준다.
 * 전원이 공통 단어를 본문에 가져 넓은 질의에 전부 걸리고, 군집 안에서는 제목+설명이 RIF 임계를 넘게 겹친다.
 */
function buildVault(vault, count, rnd) {
	// 공통 1 + 주제 4 + 군집마다 (군집 단어 4 + 기억별 고유 단어 CLUSTER), 나머지 1000 은 본문 채움말
	const named = 5 + Math.ceil(count / CLUSTER) * (4 + CLUSTER);
	const words = makeWords(rnd, named + 1000);
	let w = 0;
	const next = () => words[w++];
	const common = next();
	const topics = Array.from({ length: 4 }, next);
	const filler = words.slice(named);
	const pick = () => filler[Math.floor(rnd() * filler.length)];
	const iso = (ms) => new Date(ms).toISOString();
	let clusterQuery = "";
	for (let c = 0; c * CLUSTER < count; c++) {
		const cw = Array.from({ length: 4 }, next);
		if (c === 0) clusterQuery = cw[0];
		let prev;
		for (let m = 0; m < CLUSTER && c * CLUSTER + m < count; m++) {
			// 군집마다 마지막 기억은 앞 기억과 수치를 같게 해 동점을 만든다
			const same = m === CLUSTER - 1 && prev;
			const created = same ? prev.created : NOW - (1 + Math.floor(rnd() * 400)) * DAY;
			const reinforced = same ? prev.reinforced : created + Math.floor(rnd() * (NOW - created));
			const confidence = same ? prev.confidence : [0.5, 0.6, 0.7, 0.8, 0.9, 1][Math.floor(rnd() * 6)];
			const strength = same ? prev.strength : 1 + Math.floor(rnd() * 5);
			prev = { created, reinforced, confidence, strength };
			const bodyWords = [common, cw[m % 4], ...Array.from({ length: 24 }, pick)];
			for (const t of topics) if (rnd() < 0.2) bodyWords.push(t);
			const slug = `rif-bench-${String(c * CLUSTER + m).padStart(4, "0")}`;
			vault.write({
				id: `mem-${slug}`,
				slug,
				title: `${cw.join(" ")} ${same ? "" : next()}`.trim(),
				description: `${cw[0]} ${cw[1]} ${pick()}`,
				type: ["episodic", "semantic", "procedural", "preference"][c % 4],
				tags: [cw[2]],
				confidence,
				storageStrength: strength,
				status: "active",
				created: iso(created),
				updated: iso(reinforced),
				lastAccessed: iso(reinforced),
				lastReinforced: iso(reinforced),
				accessCount: strength,
				links: [],
				history: ["2026-06-01: created"],
				body: bodyWords.join(" "),
			});
		}
	}
	return [
		{ label: "broad", query: common },
		{ label: "broad+topic", query: `${common} ${topics[1]}` },
		{ label: "topic", query: topics[0] },
		{ label: "cluster", query: clusterQuery },
	];
}

/** 배열의 nearest-rank 백분위수 */
function pctl(xs, p) {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.max(0, Math.ceil(p * s.length) - 1)];
}

/** 정렬된 배열의 중앙값(nearest-rank) */
function p50(xs) {
	return pctl(xs, 0.5);
}

/** fn 을 rounds 번 돌린 시간(ms) 중앙값 — 매 회 prepare() 로 새 입력을 만들고 그 비용은 빼고 잰다 */
function time(rounds, prepare, fn) {
	let out;
	const ms = Array.from({ length: rounds }, () => {
		const input = prepare();
		const t0 = performance.now();
		out = fn(input);
		return performance.now() - t0;
	});
	return { ms: p50(ms), out };
}

/** 콜드 측정 자식 프로세스 코드 — 단계별(phases) 또는 끝단(server·hook·base) 시간과 출력 JSON 을 한 줄로 낸다 */
function coldCode(mode, dist, dir, query) {
	const url = (f) => JSON.stringify(pathToFileURL(path.join(dist, f)).href);
	const head = `import { statSync } from "node:fs";
Date.now = () => ${NOW};
const dir = ${JSON.stringify(dir)};
const query = ${JSON.stringify(query)};
const t0 = performance.now();`;
	// 서버 경로를 단계로 나눠 잰다 — 인덱스 적재(readIndexFile+adopt)·전체 stat 대조·검색(search+rank) 순서도 서버와 같다
	if (mode === "phases") {
		return `${head}
const { Vault } = await import(${url("vault.js")});
const { parseQuery } = await import(${url("store.js")});
const { LexicalRetriever } = await import(${url("retriever.js")});
const { rank } = await import(${url("ranker.js")});
const t1 = performance.now();
const retriever = LexicalRetriever.openReadOnly(dir);
const t2 = performance.now();
const vault = new Vault(dir);
for (const { slug, archived } of vault.listSlugs(true)) statSync(vault.filePath(slug, archived), { bigint: true });
const t3 = performance.now();
const q = parseQuery(query);
const out = rank(retriever.search(q, Infinity, {}), q, { limit: ${LIMIT}, now: Date.now(), vault });
const t4 = performance.now();
process.stdout.write(JSON.stringify({ bootMs: t0, importMs: t1 - t0, loadMs: t2 - t1, statMs: t3 - t2, searchMs: t4 - t3, out: JSON.stringify(out) }));`;
	}
	const run =
		mode === "hook"
			? `const { searchPersistedIndex } = await import(${url("store.js")});
const t1 = performance.now();
const out = searchPersistedIndex(dir, query, { limit: ${LIMIT} });`
			: `const { Vault } = await import(${url("vault.js")});
const { MemoryStore } = await import(${url("store.js")});
const t1 = performance.now();
const store = new MemoryStore(new Vault(dir));
store.reinforce = () => {};
const out = store.searchDetailed(query, { limit: ${LIMIT} });`;
	return `${head}
${run}
const t2 = performance.now();
process.stdout.write(JSON.stringify({ importMs: t1 - t0, queryMs: t2 - t1, untilQueryEndMs: t2, out: JSON.stringify(out) }));`;
}

/** mode 의 콜드 질의를 새 프로세스로 rounds 번 돌려 지표마다 p50·p95 와 출력 일치 여부를 낸다 */
function coldRun(mode, dist, dir, query, rounds, want) {
	const code = coldCode(mode, dist, dir, query);
	const runs = Array.from({ length: rounds }, () => {
		const t0 = performance.now();
		const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
		const wallMs = performance.now() - t0;
		if (r.status !== 0) die(`콜드 ${mode} 자식 실패(status ${r.status}): ${r.stderr.slice(0, 400)}`, 1);
		const x = JSON.parse(r.stdout);
		const sums =
			mode === "phases"
				? { loadSearchMs: x.loadMs + x.searchMs, totalMs: x.bootMs + x.importMs + x.loadMs + x.statMs + x.searchMs }
				: {};
		return { ...x, ...sums, wallMs };
	});
	const metrics = Object.keys(runs[0]).filter((k) => k !== "out");
	const stat = (k) => {
		const xs = runs.map((x) => x[k]);
		return { p50: pctl(xs, 0.5), p95: pctl(xs, 0.95) };
	};
	return { ms: Object.fromEntries(metrics.map((k) => [k, stat(k)])), identical: runs.every((x) => x.out === want) };
}

const opts = readArgs(process.argv.slice(2));

// 사용자 동의어 사전은 모듈 로드 시 병합되므로 import 전에 지운다
delete process.env.BIGBRAIN_SYNONYMS;
const distUrl = (f) => pathToFileURL(path.join(root, "dist", f)).href;
if (!fs.existsSync(path.join(root, "dist", "ranker.js"))) die("dist/ranker.js 가 없다 — 먼저 npm run build", 1);
const { Vault } = await import(distUrl("vault.js"));
const { MemoryStore, parseQuery } = await import(distUrl("store.js"));
const { LexicalRetriever, overlap, tokenize, INDEX_DIR, INDEX_FILE } = await import(distUrl("retriever.js"));
const { finish, inhibit, RIF_THRESHOLD } = await import(distUrl("ranker.js"));

/** 조기 종료 전 RIF — 쌍마다 제목+설명을 다시 토큰화하고 각 후보를 앞선 모든 후보와 비교한다 */
function legacyInhibit(scored, limit, counter) {
	const suppresses = (winner, loser) =>
		!(winner.record.derivedFrom ?? []).includes(loser.record.slug) &&
		!(loser.record.derivedFrom ?? []).includes(winner.record.slug);
	scored.forEach((r, i) => {
		const rivalOf = scored.slice(0, i).find((k) => {
			if (!suppresses(k, r)) return false;
			counter.pairs++;
			return (
				overlap(
					tokenize(k.record.title + " " + k.record.description),
					tokenize(r.record.title + " " + r.record.description),
				) >= RIF_THRESHOLD
			);
		});
		if (rivalOf) {
			r.score *= 0.5;
			r.inhibited = true;
			r.inhibitedBy = rivalOf.record.slug;
		}
	});
	return [...scored].sort((a, b) => b.score - a.score).slice(0, limit);
}

const realNow = Date.now;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bbm-rif-bench-"));
const staleDir = `${dir}-copy`;
let allIdentical = true;
try {
	Date.now = () => NOW;
	const vault = new Vault(dir);
	const queries = buildVault(vault, opts.count, mulberry32(opts.seed));
	const retriever = new LexicalRetriever();
	retriever.sync(vault);

	const rif = queries.map(({ label, query }) => {
		const q = parseQuery(query);
		const base = retriever
			.search(q, Infinity, {})
			.map((c) => ({ result: finish(c.record, c.score, NOW, q.expanded), tokens: c.titleDescTokens }));
		base.sort((a, b) => b.result.score - a.result.score);
		const fresh = () => base.map((b) => ({ result: { ...b.result }, tokens: b.tokens }));

		const legacyCount = { pairs: 0 };
		legacyInhibit(fresh().map((s) => s.result), LIMIT, legacyCount);
		let reads = 0;
		inhibit(
			fresh().map((s) => ({
				result: s.result,
				get tokens() {
					reads++;
					return s.tokens;
				},
			})),
			LIMIT,
		);

		const legacy = time(opts.rounds, () => fresh().map((s) => s.result), (xs) => legacyInhibit(xs, LIMIT, { pairs: 0 }));
		const next = time(opts.rounds, fresh, (xs) => inhibit(xs, LIMIT));
		const identical = JSON.stringify(legacy.out) === JSON.stringify(next.out);
		if (!identical) allIdentical = false;
		return {
			label,
			query,
			candidates: base.length,
			legacyMs: legacy.ms,
			newMs: next.ms,
			ratio: legacy.ms / next.ms,
			legacyPairs: legacyCount.pairs,
			newPairs: reads / 2,
			identical,
		};
	});

	let e2e;
	if (opts.base) {
		const { Vault: BaseVault } = await import(pathToFileURL(path.join(opts.base, "vault.js")).href);
		const { MemoryStore: BaseStore } = await import(pathToFileURL(path.join(opts.base, "store.js")).href);
		const oldStore = new BaseStore(new BaseVault(dir));
		const newStore = new MemoryStore(new Vault(dir));
		oldStore.reinforce = () => {};
		newStore.reinforce = () => {};
		e2e = queries.map(({ label, query }) => {
			const run = (s) => s.searchDetailed(query, { limit: LIMIT });
			const warmOld = JSON.stringify(run(oldStore));
			const warmNew = JSON.stringify(run(newStore));
			const oldT = time(opts.rounds, () => null, () => run(oldStore));
			const newT = time(opts.rounds, () => null, () => run(newStore));
			const identical = warmOld === warmNew && JSON.stringify(oldT.out) === JSON.stringify(newT.out);
			if (!identical) allIdentical = false;
			return { label, oldMs: oldT.ms, newMs: newT.ms, ratio: oldT.ms / newT.ms, identical };
		});
	}

	let cold;
	if (opts.cold) {
		const quiet = new MemoryStore(new Vault(dir));
		quiet.reinforce = () => {};
		quiet.searchDetailed(queries[0].query, { limit: LIMIT }); // 역색인을 최신으로 만든다
		const indexFile = path.join(dir, INDEX_DIR, INDEX_FILE);
		if (!fs.existsSync(indexFile)) die(`역색인이 만들어지지 않았다: ${indexFile}`, 1);
		const before = fs.statSync(indexFile, { bigint: true });
		fs.cpSync(dir, staleDir, { recursive: true });
		const dist = path.join(root, "dist");
		const runs = queries.map(({ label, query }) => {
			const want = JSON.stringify(quiet.searchDetailed(query, { limit: LIMIT }));
			const wantHook = JSON.stringify(quiet.searchDetailed(query, { limit: LIMIT, includeLinked: false }));
			const row = {
				label,
				phases: coldRun("phases", dist, dir, query, opts.rounds, want),
				server: coldRun("server", dist, dir, query, opts.rounds, want),
				hook: coldRun("hook", dist, dir, query, opts.rounds, wantHook),
				hookAllStale: coldRun("hook", dist, staleDir, query, opts.rounds, JSON.stringify({ results: [], totalMatched: 0 })),
				base: opts.base ? coldRun("base", opts.base, dir, query, opts.rounds, want) : undefined,
			};
			if (![row.phases, row.server, row.hook, row.hookAllStale, row.base].every((m) => !m || m.identical)) allIdentical = false;
			return row;
		});
		const after = fs.statSync(indexFile, { bigint: true });
		// 볼트가 그대로면 콜드 질의는 인덱스를 다시 쓰지 않아야 한다
		const indexUntouched = before.ino === after.ino && before.mtimeNs === after.mtimeNs && before.size === after.size;
		if (!indexUntouched) allIdentical = false;
		const worstP95 = Math.max(...runs.map((r) => r.phases.ms.loadSearchMs.p95));
		const criterion = { metric: "phases.ms.loadSearchMs p95 (인덱스 적재 + 검색)", limitMs: COLD_LIMIT_MS, worstP95, ok: worstP95 <= COLD_LIMIT_MS };
		cold = { rounds: opts.rounds, criterion, runs, indexBytes: Number(after.size), indexUntouched };
	}

	const result = {
		count: opts.count,
		cluster: CLUSTER,
		limit: LIMIT,
		rounds: opts.rounds,
		seed: opts.seed,
		node: process.version,
		rif,
		e2e: e2e ?? "생략(--base 없음)",
		cold: cold ?? "생략(--cold 없음)",
		identical: allIdentical,
	};
	process.stdout.write(JSON.stringify(result, null, 2) + "\n");
	if (!allIdentical || (cold && !cold.criterion.ok)) process.exitCode = 1;
} finally {
	Date.now = realNow;
	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(staleDir, { recursive: true, force: true });
}
