// 검색 평가 하네스 — 픽스처 볼트 사본에 골든 질의를 돌려 Recall·MRR·none 오탐률·지연을 JSON 으로 낸다.
//
// 사용:
//   node scripts/eval-retrieval.mjs --scorer legacy|bm25f [--out <path>] [--permute-control [--seed N]]
//   node scripts/eval-retrieval.mjs --compare base.json cand.json
//   node scripts/eval-retrieval.mjs --baseline <기준 dist 디렉터리> [--multi] [--out <path>]
//   node scripts/eval-retrieval.mjs --min-exact-r1 <하한>
//   node scripts/eval-retrieval.mjs --multi [--alt-weight <w>] [--alt-control [--seed N]] [--out <path>]
//   node scripts/eval-retrieval.mjs --multi --vector [--fusion add|rrf] [--vector-weight <w>] [--min-cos <τ>] [--out <path>]
//   node scripts/eval-retrieval.mjs --multi --vector --grid
//   node scripts/eval-retrieval.mjs --multi --vector --auc [--seed N]
//
// --vector 는 실제 임베딩 모델(@huggingface/transformers, 선택 의존성)로 픽스처와 질의를 임베딩해 벡터 결과를 함께 쓴다.
// add 는 어휘 후보에 없는 벡터 결과만 w×코사인 점수로 덧붙이고(서버와 같은 경로), rrf 는 어휘 순위와 벡터 순위를 RRF(k=60)로 합친 뒤 순위화하는 대조군이다.
// --grid 는 tune 분할만으로 rrf 1개와 add 격자(w × τ)를 재고 미리 정한 규칙으로 하나를 고른다. holdout 은 보지 않는다.
// --auc 는 crosslang 질의·정답 쌍(양성)과 시드 고정 무작위 비정답 쌍(음성)의 코사인으로 AUC 를 낸다.
//
// --scorer 는 import 전에 ASTRONRAG_SCORER 로 넘긴다. --alt-weight 는 변형 질의 가중(ASTRONRAG_ALT_WEIGHT, 0 초과 1 이하)이다.
// --multi 는 eval/alt-queries.jsonl 의 고정 변형을 alt_queries 로 함께 넘겨 같은 지표를 잰다.
// --alt-control 은 변형 묶음을 다른 질의의 것으로 순환 배정해 목록이 길어진 효과만 남기는 대조군이다.
// --baseline 은 골든 전 질의의 searchDetailed 출력 JSON 을 기준 dist 와 바이트 비교해 불일치가 있으면 1 로 끝난다(legacy 만). --multi 를 주면 변형도 함께 넘긴다.
// --min-exact-r1 은 exact 분할 전체 Recall@1 만 재서 하한 미만이면 1 로 끝난다.
//
// 픽스처는 %TEMP% 사본에서만 연다 — 회상 강화 쓰기가 eval/fixture-vault 를 바꾸지 않게 한다.
// 지표 측정 중에는 시계를 FROZEN_NOW 로 고정하고 강화를 꺼서 실행 시각·질의 순서와 무관한 결정적 결과를 낸다.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { runMigration } from "./migrate-vault-to-store.mjs";
import { readEnv } from "./lib/env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const FIXTURE = path.join(root, "eval", "fixture-vault");
const GOLDEN = path.join(root, "eval", "golden.jsonl");
const ALTS = path.join(root, "eval", "alt-queries.jsonl");
const MAX_ALTS = 3;
const FROZEN_NOW = Date.parse("2026-07-01T00:00:00.000Z");
const SPLITS = ["exact", "crosslang", "paraphrase", "none"];
const POSITIVE = ["exact", "crosslang", "paraphrase"];
const SCORERS = ["legacy", "bm25f"];
const MIN_PER_SPLIT = 25;
const FPR_TARGET = 0.1;
const REL_RATIO = 0.5;
const THRESHOLDS = Array.from({ length: 41 }, (_, i) => i * 0.5);
const LATENCY_ROUNDS = 5;
const FULL_LIMIT = 1000;
const DIFF_CONFIGS = [
	["full", { limit: FULL_LIMIT, includeLinked: false }],
	["recall", { limit: 5 }],
	["top1", { limit: 1 }],
	["typed", { limit: 5, type: "procedural", project: "eval-other" }],
];
const DIFF_SAMPLES = 5;
const FUSIONS = ["add", "rrf"];
/** RRF 상수와 벡터 목록 깊이 */
const RRF_K = 60;
const RRF_DEPTH = 20;
/** add 융합 격자 — 벡터 가중 × 코사인 하한 0.80~0.90 */
const GRID_W = [1, 2, 3, 5];
const GRID_TAU = Array.from({ length: 11 }, (_, i) => Math.round((0.8 + i * 0.01) * 100) / 100);
/** none 오탐 판정 임계(자동 회상 하한과 같다) */
const NONE_T = 9;
/** AUC 음성 쌍 — 질의마다 뽑는 비정답 기억 수 */
const AUC_NEG = 5;

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
				baseline: { type: "string" },
				"min-exact-r1": { type: "string" },
				multi: { type: "boolean", default: false },
				"alt-control": { type: "boolean", default: false },
				"alt-weight": { type: "string" },
				vector: { type: "boolean", default: false },
				fusion: { type: "string", default: "add" },
				"vector-weight": { type: "string" },
				"min-cos": { type: "string" },
				grid: { type: "boolean", default: false },
				auc: { type: "boolean", default: false },
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
	let minExactR1;
	if (values["min-exact-r1"] !== undefined) {
		minExactR1 = Number(values["min-exact-r1"]);
		if (!(minExactR1 >= 0 && minExactR1 <= 1)) die("--min-exact-r1 은 0~1 사이 수여야 한다", 2);
	}
	if (values.baseline !== undefined && minExactR1 !== undefined) die("--baseline 과 --min-exact-r1 은 함께 쓸 수 없다", 2);
	if (values["alt-control"] && !values.multi) die("--alt-control 은 --multi 와 함께 써야 한다", 2);
	if (values.multi && values.compare) die("--multi 는 --compare 와 함께 쓸 수 없다", 2);
	if (values.baseline !== undefined && values.scorer !== "legacy") die("--baseline 은 --scorer legacy 에서만 쓴다", 2);
	let altWeight;
	if (values["alt-weight"] !== undefined) {
		altWeight = Number(values["alt-weight"]);
		if (!(altWeight > 0 && altWeight <= 1)) die("--alt-weight 는 0 초과 1 이하 수여야 한다", 2);
		if (!values.multi) die("--alt-weight 는 --multi 와 함께 써야 한다", 2);
	}
	const vectorOnly = ["grid", "auc"].filter((k) => values[k]).concat(["vector-weight", "min-cos"].filter((k) => values[k] !== undefined));
	if (values.fusion !== "add") vectorOnly.push("fusion");
	if (!values.vector && vectorOnly.length > 0) die(`--${vectorOnly.join(", --")} 는 --vector 와 함께 써야 한다`, 2);
	if (values.vector && !values.multi) die("--vector 는 --multi 와 함께 써야 한다", 2);
	if (values.vector && (values.baseline !== undefined || minExactR1 !== undefined)) die("--vector 는 --baseline·--min-exact-r1 과 함께 쓸 수 없다", 2);
	if (!FUSIONS.includes(values.fusion)) die(`--fusion 은 ${FUSIONS.join("|")} 중 하나여야 한다`, 2);
	if (values.grid && (values.auc || values["vector-weight"] !== undefined || values["min-cos"] !== undefined || values.fusion !== "add")) {
		die("--grid 는 --auc·--vector-weight·--min-cos·--fusion 과 함께 쓸 수 없다", 2);
	}
	let vectorWeight;
	if (values["vector-weight"] !== undefined) {
		vectorWeight = Number(values["vector-weight"]);
		if (!(vectorWeight > 0 && Number.isFinite(vectorWeight))) die("--vector-weight 는 0 보다 큰 수여야 한다", 2);
	}
	let minCos;
	if (values["min-cos"] !== undefined) {
		minCos = Number(values["min-cos"]);
		if (!(minCos >= -1 && minCos <= 1)) die("--min-cos 는 -1~1 사이 수여야 한다", 2);
	}
	let baseline;
	if (values.baseline !== undefined) {
		baseline = path.resolve(values.baseline);
		for (const f of ["store.js", "vault.js"]) {
			if (!fs.existsSync(path.join(baseline, f))) die(`--baseline 디렉터리에 ${f} 가 없다: ${baseline}`, 2);
		}
	}
	return {
		scorer: values.scorer,
		out: values.out,
		compare: values.compare ? positionals : null,
		permute: values["permute-control"],
		seed,
		baseline,
		minExactR1,
		multi: values.multi,
		altControl: values["alt-control"],
		altWeight,
		vector: values.vector,
		fusion: values.fusion,
		vectorWeight,
		minCos,
		grid: values.grid,
		auc: values.auc,
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

/** 고정 변형 파일을 읽어 골든 행마다 변형 1~3개가 정확히 한 묶음 있는지 검사하고 split·query → 변형 Map 을 돌려준다 */
function loadAlts(rows) {
	const want = new Set(rows.map((r) => `${r.split}\u0000${r.query}`));
	const lines = fs.readFileSync(ALTS, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
	const map = new Map();
	lines.forEach((line, i) => {
		const where = `alt-queries.jsonl ${i + 1}행`;
		let r;
		try {
			r = JSON.parse(line);
		} catch {
			die(`${where} JSON 파싱 실패`);
		}
		const key = `${r.split}\u0000${r.query}`;
		if (!want.has(key)) die(`${where}: 골든에 없는 split·query`);
		if (map.has(key)) die(`${where}: 같은 split·query 중복`);
		const ok = Array.isArray(r.alts) && r.alts.length >= 1 && r.alts.length <= MAX_ALTS;
		if (!ok || r.alts.some((a) => typeof a !== "string" || a.trim() === "")) die(`${where}: alts 는 비지 않은 문자열 1~${MAX_ALTS}개여야 한다`);
		map.set(key, r.alts);
	});
	if (map.size !== want.size) die(`alt-queries.jsonl 이 골든 ${want.size}행 중 ${map.size}행만 덮는다`);
	return map;
}

/** 대조군 변형 — 시드 고정 순서로 행을 돌려 각 행에 다른 행의 변형 묶음을 준다(자기 변형은 남지 않는다) */
function derangeAlts(rows, alts, seed) {
	const rnd = mulberry32(seed);
	const o = rows.map((_, i) => i);
	for (let i = o.length - 1; i > 0; i--) {
		const k = Math.floor(rnd() * (i + 1));
		[o[i], o[k]] = [o[k], o[i]];
	}
	const key = (r) => `${r.split}\u0000${r.query}`;
	const out = new Map();
	o.forEach((ri, i) => out.set(key(rows[ri]), alts.get(key(rows[o[(i + 1) % o.length]]))));
	return out;
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
		const part = (xs) => ({ hit1: test(xs, 1), hit5: test(xs, 5) });
		bySplit[s] = { ...part(ps), tune: part(ps.filter(([q]) => !q.holdout)), holdout: part(ps.filter(([q]) => q.holdout)) };
	}
	return {
		mode: "compare",
		test: "McNemar exact binomial two-sided; b = base 성공·cand 실패, c = base 실패·cand 성공; none 분할 제외",
		base: basePath,
		cand: candPath,
		unmatched,
		all: { hit1: test(pairs, 1), hit5: test(pairs, 5) },
		holdout: { hit1: test(pairs.filter(([q]) => q.holdout), 1), hit5: test(pairs.filter(([q]) => q.holdout), 5) },
		crossPara: { hit5: test(pairs.filter(([q]) => q.split !== "exact"), 5) },
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

/** 두 문자열이 처음 갈리는 위치와 그 앞뒤 80자 */
function firstDiff(a, b) {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	const from = Math.max(0, i - 80);
	return { at: i, base: a.slice(from, i + 80), cand: b.slice(from, i + 80) };
}

/** --baseline: 기준 dist 와 현재 dist 가 골든 전 질의·설정에서 같은 searchDetailed 출력을 내는지 JSON 바이트로 비교한다. altsOf 가 주는 변형이 있으면 함께 넘긴다 */
async function diffBaseline(baseDist, rows, current, dirs, altsOf) {
	const { Vault: BaseVault } = await import(pathToFileURL(path.join(baseDist, "vault.js")).href);
	const { MemoryStore: BaseStore } = await import(pathToFileURL(path.join(baseDist, "store.js")).href);
	const open = (Store, VaultClass, tag) => {
		const dir = copyFixture(tag);
		dirs.push(dir);
		const store = new Store(new VaultClass(dir));
		store.reinforce = () => {};
		return store;
	};
	const base = open(BaseStore, BaseVault, "base");
	const cand = open(current.MemoryStore, current.Vault, "cand");
	let compared = 0;
	const mismatches = rows.flatMap((row) =>
		DIFF_CONFIGS.flatMap(([config, c]) => {
			const alts = altsOf(row);
			const o = alts ? Object.assign({ altQueries: alts }, c) : c;
			const a = JSON.stringify(base.searchDetailed(row.query, o));
			const b = JSON.stringify(cand.searchDetailed(row.query, o));
			compared++;
			return a === b ? [] : [{ query: row.query, split: row.split, config, ...firstDiff(a, b) }];
		}),
	);
	return {
		mode: "baseline",
		baseline: baseDist,
		frozenNow: new Date(FROZEN_NOW).toISOString(),
		configs: Object.fromEntries(DIFF_CONFIGS),
		withAltQueries: rows.filter((row) => altsOf(row)).length,
		queries: rows.length,
		compared,
		mismatchCount: mismatches.length,
		mismatches: mismatches.slice(0, DIFF_SAMPLES),
	};
}


/** 벡터 평가 준비 — 실제 모델로 픽스처 항목과 골든 질의를 한 번씩 임베딩한다 */
async function prepareVector(store, vault, rows) {
	const url = (f) => pathToFileURL(path.join(root, "dist", f)).href;
	const mod = await import(url("vector-retriever.js"));
	const { parseQuery, SCORER } = await import(url("store.js"));
	const { fuseWeightedMax } = await import(url("retriever.js"));
	const { rank } = await import(url("ranker.js"));
	store.retriever.sync(vault);
	const vr = new mod.VectorRetriever(null);
	const t0 = performance.now();
	await vr.warm(() => store.retriever.entries());
	if (vr.state !== "ready") throw new Error(`벡터 계층을 올리지 못했다: ${vr.reason}`);
	const qv = new Map();
	for (const row of rows) qv.set(row, await vr.embedQuery(row.query));
	const weight = readEnv("ASTRONRAG_ALT_WEIGHT", "BIGBRAIN_ALT_WEIGHT");
	const altWeight = weight ? Number(weight) : 0.7;
	const keys = store.retriever.entries().map((e) => e.key);
	return { mod, vr, qv, keys, parseQuery, scorer: SCORER, altWeight, fuseWeightedMax, rank, embedMs: Math.round(performance.now() - t0) };
}

/** 행 하나의 전체 순위 — cfg 가 없으면 어휘만, add 는 서버와 같은 vectorHits 경로, rrf 는 RRF 대조군 */
function rankRow(store, vec, row, alts, cfg) {
	const base = { limit: FULL_LIMIT, includeLinked: false, altQueries: alts };
	let results;
	if (!cfg) results = store.searchDetailed(row.query, base).results;
	else if (cfg.fusion === "add") {
		const vectorHits = vec.vr.nearest(vec.qv.get(row), {}, vec.mod.VECTOR_TOP_K, cfg.tau).map((h) => ({ key: h.key, score: cfg.w * h.cos }));
		results = store.searchDetailed(row.query, { ...base, vectorHits }).results;
	} else results = rrfRank(store, vec, row, alts);
	return results.map((r) => (r.via ? { slug: r.record.slug, score: r.score, via: r.via } : { slug: r.record.slug, score: r.score }));
}

/** RRF 대조군 — 어휘 융합 후보의 점수 순위와 벡터 코사인 순위(상위 RRF_DEPTH)를 Σ 1/(k+순위)로 합쳐 순위화한다 */
function rrfRank(store, vec, row, alts) {
	const q = vec.parseQuery(row.query);
	if (q.tokens.length === 0) return [];
	const seen = new Set([q.tokens.join(" ")]);
	const altQs = (alts ?? [])
		.slice(0, MAX_ALTS)
		.map(vec.parseQuery)
		.filter((a) => {
			const key = a.tokens.join(" ");
			if (a.tokens.length === 0 || seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	const queries = [q, ...altQs];
	const lists = queries.map((pq) => store.retriever.search(pq, Infinity, {}, vec.scorer));
	const lex = altQs.length === 0 ? lists[0] : vec.fuseWeightedMax(lists, queries.map((_, i) => (i === 0 ? 1 : vec.altWeight)));
	const fused = new Map();
	lex
		.map((c, i) => ({ c, i }))
		.sort((a, b) => b.c.score - a.c.score || a.i - b.i)
		.forEach(({ c }, r) => fused.set(c.titleDescTokens, { ...c, score: 1 / (RRF_K + r + 1) }));
	vec.vr.nearest(vec.qv.get(row), {}, RRF_DEPTH, -1).forEach((h, r) => {
		const c = store.retriever.candidate(h.key, {});
		if (!c) return;
		const s = 1 / (RRF_K + r + 1);
		const prev = fused.get(c.titleDescTokens);
		if (prev) prev.score += s;
		else fused.set(c.titleDescTokens, { ...c, score: s, via: "vector" });
	});
	return vec.rank([...fused.values()], q, { limit: FULL_LIMIT, now: FROZEN_NOW, includeLinked: false }).results;
}

/** none 질의 가운데 상위 5건에 벡터 전용 결과가 하나라도 있는 비율 */
function vectorTop5Rate(items) {
	if (items.length === 0) return null;
	return items.filter((x) => x.ranked.slice(0, 5).some((r) => r.via)).length / items.length;
}

/**
 * tune 분할만으로 기준(어휘+변형)·rrf·add 격자를 재고 하나를 고른다.
 * 규칙: exact R@1 이 기준 이상이고 none fpr(T=9)이 기준 이하인 설정 가운데 paraphrase R@5 최대, 동률이면 τ 가 큰 쪽, 그다음 w 가 작은 쪽(rrf 는 τ·w 없음으로 가장 뒤).
 */
function runGrid(rows, rankFn) {
	const tune = rows.filter((r) => !r.holdout);
	const measure = (cfg) => {
		const items = tune.map((row) => {
			const ranked = rankFn(row, cfg);
			return { row, ranked, j: judge(row, ranked) };
		});
		const of = (s) => items.filter((x) => x.row.split === s);
		return {
			exactR1: summarize(of("exact")).recall1 ?? Number.NaN,
			crosslangR5: summarize(of("crosslang")).recall5 ?? Number.NaN,
			paraphraseR5: summarize(of("paraphrase")).recall5 ?? Number.NaN,
			noneFprT9: curvePoint(items, NONE_T).fpr ?? Number.NaN,
			noneAnyResult: summarize(of("none")).anyResultRate,
			noneVectorTop5: vectorTop5Rate(of("none")),
		};
	};
	const base = measure(null);
	const rrf = { fusion: "rrf", w: null, tau: null, tune: measure({ fusion: "rrf" }) };
	const add = GRID_W.flatMap((w) => GRID_TAU.map((tau) => ({ fusion: "add", w, tau, tune: measure({ fusion: "add", w, tau }) })));
	const ok = [rrf, ...add].filter((c) => c.tune.exactR1 >= base.exactR1 && c.tune.noneFprT9 <= base.noneFprT9);
	const tauOf = (c) => c.tau ?? -2;
	const wOf = (c) => c.w ?? Number.MAX_VALUE;
	ok.sort((a, b) => b.tune.paraphraseR5 - a.tune.paraphraseR5 || tauOf(b) - tauOf(a) || wOf(a) - wOf(b));
	return {
		rule: "tune: exact R@1 >= 기준 且 none fpr(T=9) <= 기준 인 설정 중 paraphrase R@5 최대, 동률이면 τ 큰 쪽, 다음 w 작은 쪽",
		split: "tune",
		base,
		rrf,
		add,
		eligible: ok.length,
		pick: ok[0] ?? null,
	};
}

/** crosslang 질의·정답 쌍(양성)과 질의마다 시드 고정으로 뽑은 비정답 쌍(음성)의 코사인 AUC(Mann-Whitney, 동점 0.5) */
function crosslangAuc(vec, rows, seed) {
	const rnd = mulberry32(seed);
	const cross = rows.filter((r) => r.split === "crosslang");
	const pairs = new Map();
	for (const row of cross) {
		const cos = new Map(vec.vr.nearest(vec.qv.get(row), {}, Infinity, -1).map((h) => [h.key, h.cos]));
		const expKeys = new Set(row.expected.flatMap((s) => [`m:${s}`, `a:${s}`]));
		const pos = row.expected.map((s) => cos.get(`m:${s}`) ?? cos.get(`a:${s}`));
		if (pos.some((p) => p === undefined)) throw new Error(`정답 임베딩 없음: ${row.query}`);
		const pool = vec.keys.filter((k) => !expKeys.has(k));
		const neg = new Array();
		for (let i = 0; i < AUC_NEG && pool.length > 0; i++) neg.push(cos.get(pool.splice(Math.floor(rnd() * pool.length), 1)[0]));
		pairs.set(row, { pos, neg });
	}
	const auc = (rs) => {
		const pos = rs.flatMap((r) => pairs.get(r).pos);
		const neg = rs.flatMap((r) => pairs.get(r).neg);
		let s = 0;
		for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0;
		const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
		return { nPos: pos.length, nNeg: neg.length, auc: s / (pos.length * neg.length), meanPosCos: mean(pos), meanNegCos: mean(neg) };
	};
	return { all: auc(cross), tune: auc(cross.filter((r) => !r.holdout)), holdout: auc(cross.filter((r) => r.holdout)) };
}

const opts = readArgs(process.argv.slice(2));

if (opts.compare) {
	emit(compare(opts.compare[0], opts.compare[1]), opts.out, ["all", "holdout", "unmatched"]);
	process.exit(0);
}

if (!SCORERS.includes(opts.scorer)) die(`지원하지 않는 scorer: ${opts.scorer} (가능: ${SCORERS.join(", ")})`, 2);

// 사용자 동의어 사전은 모듈 로드 시 병합되므로 import 전에 지운다. 스코어러·변형 가중도 모듈 로드 시 읽으므로 import 전에 정한다
delete process.env.ASTRONRAG_SYNONYMS;
delete process.env.BIGBRAIN_SYNONYMS;
process.env.ASTRONRAG_SCORER = opts.scorer;
delete process.env.BIGBRAIN_ALT_WEIGHT;
if (opts.altWeight === undefined) delete process.env.ASTRONRAG_ALT_WEIGHT;
else process.env.ASTRONRAG_ALT_WEIGHT = String(opts.altWeight);
const distUrl = (f) => pathToFileURL(path.join(root, "dist", f)).href;
if (!fs.existsSync(path.join(root, "dist", "store.js"))) die("dist/store.js 가 없다 — 먼저 npm run build");
const { Vault } = await import(distUrl("vault.js"));
const { MemoryStore } = await import(distUrl("store.js"));
const { FileStore } = await import(distUrl("stores/file-store.js"));
const { SqliteStore } = await import(distUrl("stores/sqlite-store.js"));

function openEvaluationBackend(dir, tag) {
	if (readEnv("ASTRONRAG_STORE", "BBM_STORE") === "file") {
		return new FileStore(dir);
	}
	const databasePath = path.join(dir, ".bbm", `${tag}.sqlite`);
	const backupPath = `${dir}-${tag}-backup`;
	runMigration({ vault: dir, storePath: databasePath, backupPath, dryRun: false, merge: false, verify: false });
	return new SqliteStore(dir, databasePath);
}

// die() 는 finally 를 건너뛰므로 임시 사본을 만들기 전에 골든셋을 검증한다
const fixtureSlugs = new Set(
	fs.readdirSync(path.join(FIXTURE, "memories")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)),
);
const golden = loadGolden(fixtureSlugs);
const fixedAlts = opts.multi ? loadAlts(golden) : null;
const usedAlts = fixedAlts && opts.altControl ? derangeAlts(golden, fixedAlts, opts.seed) : fixedAlts;
/** 행에 넘길 alt_queries — --multi 가 없으면 undefined */
const altsOf = (row) => usedAlts?.get(`${row.split}\u0000${row.query}`);

const realNow = Date.now;
let metricDir = "";
let latDir = "";
let metricBackend;
let liveBackend;
const diffDirs = [];
// --baseline·--min-exact-r1 은 필요한 계산만 하고 break 로 이 블록을 빠져나가 finally 정리를 탄다
evaluation: try {
	if (opts.baseline) {
		Date.now = () => FROZEN_NOW;
		const diff = await diffBaseline(opts.baseline, golden, { Vault, MemoryStore }, diffDirs, altsOf);
		Date.now = realNow;
		emit(diff, opts.out, ["queries", "compared", "mismatchCount", "mismatches"]);
		if (diff.mismatchCount > 0) process.exitCode = 1;
		break evaluation;
	}

	// 지표: 고정 시계 + 강화 끔 + 전체 순위
	metricDir = copyFixture("metric");
	Date.now = () => FROZEN_NOW;
	metricBackend = openEvaluationBackend(metricDir, "metric");
	const store = new MemoryStore(metricBackend);
	store.reinforce = () => {};
	const records = store.loadAll(true);
	if (records.length !== fixtureSlugs.size) throw new Error(`픽스처 파싱 수 불일치: ${records.length}/${fixtureSlugs.size}`);
	const types = {};
	for (const r of records) types[r.type] = (types[r.type] ?? 0) + 1;

	// 벡터: 임베딩은 실제 시계로 한 번만 계산하고, 순위화는 고정 시계에서 한다
	Date.now = realNow;
	const vec = opts.vector ? await prepareVector(store, metricBackend, golden) : null;
	Date.now = () => FROZEN_NOW;
	if (vec && opts.auc) {
		Date.now = realNow;
		emit({ mode: "auc", model: vec.mod.MODEL_ID, dtype: vec.mod.DTYPE, seed: opts.seed, negativesPerQuery: AUC_NEG, ...crosslangAuc(vec, golden, opts.seed) }, opts.out, ["all", "tune", "holdout"]);
		break evaluation;
	}
	if (vec && opts.grid) {
		const grid = runGrid(golden, (row, cfg) => rankRow(store, vec, row, altsOf(row), cfg));
		Date.now = realNow;
		emit({ mode: "grid", model: vec.mod.MODEL_ID, dtype: vec.mod.DTYPE, embedMs: vec.embedMs, ...grid }, opts.out, ["rule", "base", "rrf", "pick"]);
		break evaluation;
	}
	const vectorCfg = vec
		? { fusion: opts.fusion, w: opts.vectorWeight ?? vec.mod.VECTOR_WEIGHT, tau: opts.minCos ?? vec.mod.VECTOR_MIN_COS }
		: null;

	const items = golden.map((row) => {
		const ranked = rankRow(store, vec, row, altsOf(row), vectorCfg);
		return { row, ranked, j: judge(row, ranked) };
	});
	Date.now = realNow;

	if (opts.minExactR1 !== undefined) {
		const exact = summarize(items.filter((x) => x.row.split === "exact"));
		const r1 = exact.recall1 ?? Number.NaN;
		const ok = r1 >= opts.minExactR1;
		console.log(`${ok ? "✔" : "✘"} exact 분할 Recall@1 ${r1} (n=${exact.n}) ${ok ? ">=" : "<"} 하한 ${opts.minExactR1}`);
		if (!ok) process.exitCode = 1;
		break evaluation;
	}

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
	liveBackend = openEvaluationBackend(latDir, "latency");
	const live = new MemoryStore(liveBackend);
	for (const row of golden) live.searchDetailed(row.query, { limit: 5, altQueries: altsOf(row) });
	const times = Array.from({ length: LATENCY_ROUNDS }, () =>
		golden.map((row) => {
			const t0 = performance.now();
			live.searchDetailed(row.query, { limit: 5, altQueries: altsOf(row) });
			return performance.now() - t0;
		}),
	)
		.flat()
		.sort((a, b) => a - b);

	const result = {
		scorer: opts.scorer,
		shadow: opts.scorer === "legacy" && readEnv("ASTRONRAG_SHADOW", "BIGBRAIN_SHADOW") !== "0",
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
		...(opts.multi
			? { multi: { file: path.relative(root, ALTS), control: opts.altControl ? "derangement" : "none", seed: opts.altControl ? opts.seed : null, altWeight: opts.altWeight ?? "default" } }
			: {}),
		...(vec && vectorCfg
			? {
					vector: {
						model: vec.mod.MODEL_ID,
						dtype: vec.mod.DTYPE,
						...vectorCfg,
						topK: vectorCfg.fusion === "add" ? vec.mod.VECTOR_TOP_K : RRF_DEPTH,
						embedMs: vec.embedMs,
						noneVectorTop5: {
							tune: vectorTop5Rate(items.filter((x) => x.row.split === "none" && !x.row.holdout)),
							holdout: vectorTop5Rate(items.filter((x) => x.row.split === "none" && x.row.holdout)),
							all: vectorTop5Rate(items.filter((x) => x.row.split === "none")),
						},
						latencyNote: "latencyMs 는 어휘 경로만 잰다 — 벡터 추가 지연은 regress-vector.mjs --real",
					},
				}
			: {}),
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

	emit(result, opts.out, ["scorer", "shadow", "fixture", "splits", "g2", "latencyMs", "permuteControl", "multi", "vector"]);
} finally {
	Date.now = realNow;
	metricBackend?.close();
	liveBackend?.close();
	for (const d of [metricDir, latDir, ...diffDirs]) if (d) fs.rmSync(d, { recursive: true, force: true });
	if (metricDir) fs.rmSync(`${metricDir}-metric-backup`, { recursive: true, force: true });
	if (latDir) fs.rmSync(`${latDir}-latency-backup`, { recursive: true, force: true });
}
