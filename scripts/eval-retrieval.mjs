// 검색 평가 하네스 — 픽스처 볼트 사본에 골든 질의를 돌려 Recall·MRR·none 오탐률·지연을 JSON 으로 낸다.
//
// 사용:
//   node scripts/eval-retrieval.mjs --scorer legacy [--out <path>] [--permute-control [--seed N]]
//   node scripts/eval-retrieval.mjs --compare base.json cand.json
//
// 픽스처는 %TEMP% 사본에서만 연다 — 회상 강화 쓰기가 eval/fixture-vault 를 바꾸지 않게 한다.
// 지표 측정 중에는 시계를 FROZEN_NOW 로 고정하고 강화를 꺼서 실행 시각·질의 순서와 무관한 결정적 결과를 낸다.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const FIXTURE = path.join(root, "eval", "fixture-vault");
const GOLDEN = path.join(root, "eval", "golden.jsonl");
const FROZEN_NOW = Date.parse("2026-07-01T00:00:00.000Z");
const SPLITS = ["exact", "crosslang", "paraphrase", "none"];
const POSITIVE = ["exact", "crosslang", "paraphrase"];
const SCORERS = ["legacy"];
const MIN_PER_SPLIT = 25;
const FPR_TARGET = 0.1;
const REL_RATIO = 0.5;
const THRESHOLDS = Array.from({ length: 41 }, (_, i) => i * 0.5);
const LATENCY_ROUNDS = 5;
const FULL_LIMIT = 1000;

function die(msg, code = 1) {
	console.error(`eval-retrieval: ${msg}`);
	process.exit(code);
}

/** argv 를 옵션 객체로 해석한다 */
function readArgs(argv) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				scorer: { type: "string", default: "legacy" },
				out: { type: "string" },
				compare: { type: "boolean", default: false },
				"permute-control": { type: "boolean", default: false },
				seed: { type: "string", default: "42" },
			},
		});
	} catch (e) {
		die(e instanceof Error ? e.message : String(e), 2);
	}
	const { values, positionals } = parsed;
	if (values.compare && positionals.length !== 2) die("--compare 는 파일 두 개가 필요하다", 2);
	if (!values.compare && positionals.length > 0) die(`알 수 없는 인자: ${positionals.join(" ")}`, 2);
	const seed = Number(values.seed);
	if (!Number.isInteger(seed)) die("--seed 는 정수여야 한다", 2);
	return {
		scorer: values.scorer,
		out: values.out,
		compare: values.compare ? positionals : null,
		permute: values["permute-control"],
		seed,
	};
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

/** 정렬된 배열의 nearest-rank 백분위수 */
function percentile(sorted, p) {
	if (sorted.length === 0) return null;
	return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

/** McNemar 정확 이항 양측 p값 — b, c 는 불일치 쌍 수 */
function mcnemarExact(b, c) {
	const n = b + c;
	if (n === 0) return 1;
	let pk = Math.pow(0.5, n);
	let tail = 0;
	for (let k = 0; k <= Math.min(b, c); k++) {
		tail += pk;
		pk = (pk * (n - k)) / (k + 1);
	}
	return Math.min(1, 2 * tail);
}

/** 골든셋을 읽고 형식·분할 크기·slug 존재를 검사한다 */
function loadGolden(slugs) {
	const lines = fs.readFileSync(GOLDEN, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
	const seen = new Set();
	const rows = lines.map((line, i) => {
		let r;
		try {
			r = JSON.parse(line);
		} catch {
			die(`golden.jsonl ${i + 1}행 JSON 파싱 실패`);
		}
		const where = `golden.jsonl ${i + 1}행`;
		if (typeof r.query !== "string" || r.query.trim() === "") die(`${where}: query 없음`);
		if (!SPLITS.includes(r.split)) die(`${where}: split 이 ${SPLITS.join("/")} 가 아님`);
		if (typeof r.holdout !== "boolean") die(`${where}: holdout 이 boolean 이 아님`);
		if (!Array.isArray(r.expected)) die(`${where}: expected 가 배열이 아님`);
		if (r.split === "none" && r.expected.length !== 0) die(`${where}: none 의 expected 는 빈 배열이어야 한다`);
		if (r.split !== "none" && r.expected.length === 0) die(`${where}: 정답 분할의 expected 가 비었다`);
		for (const s of r.expected) if (!slugs.has(s)) die(`${where}: 픽스처에 없는 slug ${s}`);
		const key = `${r.split}\u0000${r.query}`;
		if (seen.has(key)) die(`${where}: 같은 split·query 중복`);
		seen.add(key);
		return { query: r.query, expected: r.expected, split: r.split, holdout: r.holdout };
	});
	for (const s of SPLITS) {
		const n = rows.filter((r) => r.split === s).length;
		if (n < MIN_PER_SPLIT) die(`split ${s} 가 ${n}건으로 최소 ${MIN_PER_SPLIT}건 미만`);
	}
	return rows;
}

/** 픽스처를 %TEMP% 에 복사한 새 디렉터리 경로를 돌려준다 */
function copyFixture(tag) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bbm-eval-${tag}-`));
	fs.cpSync(FIXTURE, dir, { recursive: true });
	return dir;
}

/** 순위 목록에서 질의 하나의 판정값을 계산한다 */
function judge(row, ranked) {
	const exp = new Set(row.expected);
	const idx = ranked.findIndex((r) => exp.has(r.slug));
	const inTop = (k) => ranked.slice(0, k).filter((r) => exp.has(r.slug)).length;
	return {
		firstRank: idx === -1 ? null : idx + 1,
		recall1: exp.size === 0 ? null : inTop(1) / exp.size,
		recall5: exp.size === 0 ? null : inTop(5) / exp.size,
		rr: idx === -1 ? 0 : 1 / (idx + 1),
	};
}

/** 판정 목록의 평균 지표 */
function summarize(items) {
	const n = items.length;
	if (n === 0) return { n: 0 };
	const mean = (f) => items.reduce((s, x) => s + f(x), 0) / n;
	if (items[0].row.split === "none") {
		return { n, anyResultRate: mean((x) => (x.ranked.length > 0 ? 1 : 0)), meanCandidates: mean((x) => x.ranked.length) };
	}
	return { n, recall1: mean((x) => x.j.recall1), recall5: mean((x) => x.j.recall5), mrr: mean((x) => x.j.rr) };
}

/** split × {tune, holdout, all} 지표표와 정답 분할 전체 합계를 만든다 */
function splitTable(items) {
	const part = (xs) => ({
		tune: summarize(xs.filter((x) => !x.row.holdout)),
		holdout: summarize(xs.filter((x) => x.row.holdout)),
		all: summarize(xs),
	});
	return {
		...Object.fromEntries(SPLITS.map((s) => [s, part(items.filter((x) => x.row.split === s))])),
		positive: part(items.filter((x) => x.row.split !== "none")),
	};
}

/** 임계 T 에서 none 오탐률과 exact 적중률을 잰다 */
function curvePoint(items, T) {
	const none = items.filter((x) => x.row.split === "none");
	const exact = items.filter((x) => x.row.split === "exact");
	const hitsAbs = (x) => x.ranked.filter((r) => r.score >= T).length;
	const hitsRel = (x) => {
		const top = x.ranked[0]?.score ?? 0;
		const cut = Math.max(T, top * REL_RATIO);
		return x.ranked.filter((r) => r.score >= cut).length;
	};
	const rate = (xs, f) => (xs.length === 0 ? null : xs.reduce((s, x) => s + f(x), 0) / xs.length);
	const exactAt = (k) => (x) => {
		const exp = new Set(x.row.expected);
		return x.ranked.slice(0, k).filter((r) => r.score >= T && exp.has(r.slug)).length / exp.size;
	};
	return {
		fpr: rate(none, (x) => (hitsAbs(x) > 0 ? 1 : 0)),
		fprRel50: rate(none, (x) => (hitsRel(x) > 0 ? 1 : 0)),
		meanHitsAbs: rate(none, hitsAbs),
		meanHitsRel50: rate(none, hitsRel),
		exactR1: rate(exact, exactAt(1)),
		exactR5: rate(exact, exactAt(5)),
	};
}

/** 임계값 격자 전체의 곡선 (tune·holdout·all) */
function noneCurve(items) {
	const tune = items.filter((x) => !x.row.holdout);
	const hold = items.filter((x) => x.row.holdout);
	return THRESHOLDS.map((T) => ({ T, tune: curvePoint(tune, T), holdout: curvePoint(hold, T), all: curvePoint(items, T) }));
}

/** tune 곡선에서 G2 자동 회상 임계를 고르고 holdout 값을 함께 보고한다 */
function pickG2(curve) {
	const base = curve[0].tune.exactR1;
	const ok = curve.filter((p) => p.tune.fpr <= FPR_TARGET);
	const rule = `tune 분할에서 none fpr <= ${FPR_TARGET} 인 T 중 exact R@1 손실(T=0 대비) 최소, 동률이면 작은 T`;
	if (ok.length === 0) {
		const minFpr = Math.min(...curve.map((p) => p.tune.fpr));
		return { threshold: null, rule, minTuneFpr: minFpr, atMaxT: curve[curve.length - 1] };
	}
	let best = ok[0];
	for (const p of ok) if (base - p.tune.exactR1 < base - best.tune.exactR1) best = p;
	return {
		threshold: best.T,
		rule,
		tune: { fpr: best.tune.fpr, exactR1: best.tune.exactR1, exactR1Loss: base - best.tune.exactR1 },
		holdout: { fpr: best.holdout.fpr, exactR1: best.holdout.exactR1, exactR1Loss: curve[0].holdout.exactR1 - best.holdout.exactR1 },
		all: { fpr: best.all.fpr, exactR1: best.all.exactR1, exactR1Loss: curve[0].all.exactR1 - best.all.exactR1 },
	};
}

/** --compare: 두 결과 파일의 질의별 성공/실패로 McNemar 검정을 한다 */
function compare(basePath, candPath) {
	const read = (p) => {
		try {
			return JSON.parse(fs.readFileSync(p, "utf8"));
		} catch (e) {
			die(`${p} 를 읽지 못했다: ${e.message}`);
		}
	};
	const base = read(basePath);
	const cand = read(candPath);
	if (!Array.isArray(base.queries) || !Array.isArray(cand.queries)) die("queries 배열이 없는 결과 파일이다");
	const key = (q) => `${q.split}\u0000${q.query}`;
	const candMap = new Map(cand.queries.map((q) => [key(q), q]));
	const positives = base.queries.filter((q) => q.split !== "none");
	const pairs = positives.filter((q) => candMap.has(key(q))).map((q) => [q, candMap.get(key(q))]);
	const unmatched = positives.length - pairs.length;
	const test = (ps, k) => {
		const hit = (q) => q.firstRank !== null && q.firstRank <= k;
		let b = 0;
		let c = 0;
		for (const [x, y] of ps) {
			if (hit(x) && !hit(y)) b++;
			else if (!hit(x) && hit(y)) c++;
		}
		return { n: ps.length, b, c, p: mcnemarExact(b, c) };
	};
	const bySplit = {};
	for (const s of POSITIVE) {
		const ps = pairs.filter(([q]) => q.split === s);
		bySplit[s] = { hit1: test(ps, 1), hit5: test(ps, 5) };
	}
	return {
		mode: "compare",
		test: "McNemar exact binomial two-sided; b = base 성공·cand 실패, c = base 실패·cand 성공; none 분할 제외",
		base: basePath,
		cand: candPath,
		unmatched,
		all: { hit1: test(pairs, 1), hit5: test(pairs, 5) },
		holdout: { hit1: test(pairs.filter(([q]) => q.holdout), 1), hit5: test(pairs.filter(([q]) => q.holdout), 5) },
		bySplit,
	};
}

/** 결과를 파일 또는 stdout 으로 낸다 */
function emit(result, out, summaryKeys) {
	const text = JSON.stringify(result, null, 2) + "\n";
	if (!out) {
		process.stdout.write(text);
		return;
	}
	fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
	fs.writeFileSync(out, text, "utf8");
	const summary = { out: path.resolve(out) };
	for (const k of summaryKeys) if (k in result) summary[k] = result[k];
	process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}

const opts = readArgs(process.argv.slice(2));

if (opts.compare) {
	emit(compare(opts.compare[0], opts.compare[1]), opts.out, ["all", "holdout", "unmatched"]);
	process.exit(0);
}

if (!SCORERS.includes(opts.scorer)) die(`지원하지 않는 scorer: ${opts.scorer} (가능: ${SCORERS.join(", ")})`, 2);

// 사용자 동의어 사전은 모듈 로드 시 병합되므로 import 전에 지운다
delete process.env.BIGBRAIN_SYNONYMS;
const distUrl = (f) => pathToFileURL(path.join(root, "dist", f)).href;
if (!fs.existsSync(path.join(root, "dist", "store.js"))) die("dist/store.js 가 없다 — 먼저 npm run build");
const { Vault } = await import(distUrl("vault.js"));
const { MemoryStore } = await import(distUrl("store.js"));

// die() 는 finally 를 건너뛰므로 임시 사본을 만들기 전에 골든셋을 검증한다
const fixtureSlugs = new Set(
	fs.readdirSync(path.join(FIXTURE, "memories")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)),
);
const golden = loadGolden(fixtureSlugs);

const realNow = Date.now;
let metricDir = "";
let latDir = "";
try {
	// 지표: 고정 시계 + 강화 끔 + 전체 순위
	metricDir = copyFixture("metric");
	Date.now = () => FROZEN_NOW;
	const store = new MemoryStore(new Vault(metricDir));
	store.reinforce = () => {};
	const records = store.loadAll(true);
	if (records.length !== fixtureSlugs.size) throw new Error(`픽스처 파싱 수 불일치: ${records.length}/${fixtureSlugs.size}`);
	const types = {};
	for (const r of records) types[r.type] = (types[r.type] ?? 0) + 1;

	const items = golden.map((row) => {
		const ranked = store
			.searchDetailed(row.query, { limit: FULL_LIMIT, includeLinked: false })
			.results.map((r) => ({ slug: r.record.slug, score: r.score }));
		return { row, ranked, j: judge(row, ranked) };
	});
	Date.now = realNow;

	const curve = noneCurve(items);

	// 대조군: 후보 목록 순서를 시드 고정 무작위로 섞은 뒤 같은 지표
	let permuteControl;
	if (opts.permute) {
		const rnd = mulberry32(opts.seed);
		const shuffled = items.map((x) => {
			const r = [...x.ranked];
			for (let i = r.length - 1; i > 0; i--) {
				const k = Math.floor(rnd() * (i + 1));
				[r[i], r[k]] = [r[k], r[i]];
			}
			return { row: x.row, ranked: r, j: judge(x.row, r) };
		});
		permuteControl = { seed: opts.seed, splits: splitTable(shuffled) };
	}

	// 지연: 실제 시계·실제 강화, 서버 recall 기본값(limit 5, 연상 포함)
	latDir = copyFixture("latency");
	const live = new MemoryStore(new Vault(latDir));
	for (const row of golden) live.searchDetailed(row.query, { limit: 5 });
	const times = Array.from({ length: LATENCY_ROUNDS }, () =>
		golden.map((row) => {
			const t0 = performance.now();
			live.searchDetailed(row.query, { limit: 5 });
			return performance.now() - t0;
		}),
	)
		.flat()
		.sort((a, b) => a - b);

	const result = {
		scorer: opts.scorer,
		frozenNow: new Date(FROZEN_NOW).toISOString(),
		fixture: { count: records.length, types },
		golden: {
			count: golden.length,
			bySplit: Object.fromEntries(SPLITS.map((s) => [s, {
				n: golden.filter((r) => r.split === s).length,
				holdout: golden.filter((r) => r.split === s && r.holdout).length,
			}])),
		},
		splits: splitTable(items),
		noneCurve: curve,
		g2: pickG2(curve),
		permuteControl,
		latencyMs: {
			p50: percentile(times, 0.5),
			p95: percentile(times, 0.95),
			n: times.length,
			mode: `in-process warm searchDetailed(limit 5), 워밍업 1회 후 ${LATENCY_ROUNDS}라운드, MCP 전송 제외, 실제 시계·강화 적용`,
		},
		queries: items.map((x) => ({
			query: x.row.query,
			split: x.row.split,
			holdout: x.row.holdout,
			expected: x.row.expected,
			top5: x.ranked.slice(0, 5),
			firstRank: x.j.firstRank,
		})),
	};

	emit(result, opts.out, ["scorer", "fixture", "splits", "g2", "latencyMs", "permuteControl"]);
} finally {
	Date.now = realNow;
	for (const d of [metricDir, latDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
}
