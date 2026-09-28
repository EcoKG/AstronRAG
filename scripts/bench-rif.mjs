// RIF 비용 벤치 — 합성 볼트에서 구 RIF(쌍마다 재토큰화·전 후보 비교)와 신 RIF(사전 토큰·조기 종료)를 같은 입력으로 잰다.
//
// 사용:
//   node scripts/bench-rif.mjs [--base <기준 dist 디렉터리>] [--count 950] [--rounds 5] [--seed 42]
//
// 볼트는 %TEMP% 에 만들고 끝나면 지운다. 제목·본문·slug 는 전부 시드 고정 가짜 음절이다.
// --base 를 주면 기준 dist 와 현재 dist 의 searchDetailed(limit 5) 끝단 시간·출력도 비교한다.
// 시계는 고정하고 강화는 끈다. 구·신 출력이 하나라도 다르면 1 로 끝난다.

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
	return { base, count, rounds, seed };
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

/** 정렬된 배열의 중앙값(nearest-rank) */
function p50(xs) {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.max(0, Math.ceil(0.5 * s.length) - 1)];
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

const opts = readArgs(process.argv.slice(2));

// 사용자 동의어 사전은 모듈 로드 시 병합되므로 import 전에 지운다
delete process.env.BIGBRAIN_SYNONYMS;
const distUrl = (f) => pathToFileURL(path.join(root, "dist", f)).href;
if (!fs.existsSync(path.join(root, "dist", "ranker.js"))) die("dist/ranker.js 가 없다 — 먼저 npm run build", 1);
const { Vault } = await import(distUrl("vault.js"));
const { MemoryStore, parseQuery } = await import(distUrl("store.js"));
const { LexicalRetriever, overlap, tokenize } = await import(distUrl("retriever.js"));
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

	const result = {
		count: opts.count,
		cluster: CLUSTER,
		limit: LIMIT,
		rounds: opts.rounds,
		seed: opts.seed,
		node: process.version,
		rif,
		e2e: e2e ?? "생략(--base 없음)",
		identical: allIdentical,
	};
	process.stdout.write(JSON.stringify(result, null, 2) + "\n");
	if (!allIdentical) process.exitCode = 1;
} finally {
	Date.now = realNow;
	fs.rmSync(dir, { recursive: true, force: true });
}
