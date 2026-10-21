// 검색 평가 하네스 — 픽스처 볼트 사본에 골든 질의를 돌려 Recall·MRR·none 오탐률·지연을 JSON 으로 낸다.
//
// 사용:
//   node scripts/eval-retrieval.mjs --scorer legacy|bm25f [--out <path>] [--permute-control [--seed N]]
//   node scripts/eval-retrieval.mjs --compare base.json cand.json
//   node scripts/eval-retrieval.mjs --baseline <기준 dist 디렉터리> [--multi] [--out <path>]
//   node scripts/eval-retrieval.mjs --min-exact-r1 <하한>
//   node scripts/eval-retrieval.mjs --multi [--alt-weight <w>] [--alt-control [--seed N]] [--out <path>]
//   node scripts/eval-retrieval.mjs --vector [--multi] [--fusion add|rrf] [--vector-weight <w>] [--min-cos <τ>] [--out <path>]
//   node scripts/eval-retrieval.mjs --vector --grid [--model <model>] [--queries <jsonl>] [--corpus <path>]
//   node scripts/eval-retrieval.mjs --multi --vector --auc [--seed N]
//
// --vector 는 실제 임베딩 모델(@huggingface/transformers, 선택 의존성)로 픽스처와 질의를 임베딩해 벡터 결과를 함께 쓴다.
// add와 가중 RRF(k=60)는 실제 MemoryStore의 결합 경로를 공유한다.
// --grid는 88개 tune 조합을 측정한다. 세 세트를 통합해 하나를 고르고 그 조합만 holdout으로 판정한다.
// --auc 는 crosslang 질의·정답 쌍(양성)과 시드 고정 무작위 비정답 쌍(음성)의 코사인으로 AUC 를 낸다.
//
// --scorer 는 import 전에 ASTRONRAG_SCORER 로 넘긴다. --alt-weight 는 변형 질의 가중(ASTRONRAG_ALT_WEIGHT, 0 초과 1 이하)이다.
// --multi 는 eval/alt-queries.jsonl 의 고정 변형을 alt_queries 로 함께 넘겨 같은 지표를 잰다.
// --alt-control 은 변형 묶음을 다른 질의의 것으로 순환 배정해 목록이 길어진 효과만 남기는 대조군이다.
// --baseline 은 골든 전 질의의 searchDetailed 출력 JSON 을 기준 dist 와 바이트 비교해 불일치가 있으면 1 로 끝난다(legacy 만). --multi 를 주면 변형도 함께 넘긴다.
// --min-exact-r1 은 exact 분할 전체 Recall@1 만 재서 하한 미만이면 1 로 끝난다.
//
// 픽스처는 운영체제 임시 폴더의 독립 사본에서만 검색한다.
// 지표 측정 중에는 시계를 FROZEN_NOW 로 고정하고 강화를 꺼서 실행 시각·질의 순서와 무관한 결정적 결과를 낸다.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { runMigration } from "./migrate-vault-to-store.mjs";
import { readEnv } from "./lib/env.mjs";
import crypto from "node:crypto";

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
/** 두 결합에서 측정할 벡터 가중치를 정의한다. */
const GRID_W = [1, 2, 3, 5];
const GRID_TAU = Array.from({ length: 11 }, (_, i) => (70 + i * 2) / 100);
/** none 오탐 판정 임계(자동 회상 하한과 같다) */
const NONE_T = 9;
/** AUC 음성 쌍 — 질의마다 뽑는 비정답 기억 수 */
const AUC_NEG = 5;

function die(msg, code = 1) {
	throw Object.assign(new Error(msg), { exitCode: code });
}

/** argv 를 옵션 객체로 해석한다 */
export function readArgs(argv) {
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
				queries: { type: "string" },
				corpus: { type: "string" },
				"corpus-kind": { type: "string", default: "file" },
				alts: { type: "string" },
				"query-mode": { type: "string", default: "original" },
				model: { type: "string", default: "Xenova/multilingual-e5-small" },
				dtype: { type: "string", default: "q8" },
				"top-k": { type: "string", default: "10" },
				"details-out": { type: "string" },
				"private-root": { type: "string" },
				"snapshot-hash": { type: "string" },
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
	const topK = Number(values["top-k"]);
	if (!Number.isSafeInteger(topK) || topK < 1) die("invalid top-k", 2);
	if (!SCORERS.includes(values.scorer) || !["original", "alts"].includes(values["query-mode"]) || !["file", "sqlite"].includes(values["corpus-kind"])) die("invalid evaluation mode", 2);
	if ((values.queries !== undefined && !values.queries.trim()) || (values.corpus !== undefined && !values.corpus.trim())) die("empty input", 2);
	const publicQueries = values.queries === undefined || [GOLDEN, path.join(root, "eval/paraphrase-fixture.jsonl")].includes(path.resolve(values.queries));
	const publicCorpus = values.corpus === undefined || path.resolve(values.corpus) === FIXTURE;
	const privateInput = !(publicQueries && publicCorpus);
	if (privateInput && (!values.queries || !values.corpus)) die("external inputs require queries and corpus", 2);
	if (privateInput && (values.compare || values.baseline || values.auc || values["permute-control"])) die("unsupported private mode", 2);
	if (values.dtype !== "q8" || !["Xenova/multilingual-e5-small", "Xenova/multilingual-e5-base", "Xenova/paraphrase-multilingual-MiniLM-L12-v2"].includes(values.model)) die("unsupported model configuration", 2);
	return {
		queries: values.queries, corpus: values.corpus, corpusKind: values["corpus-kind"], alts: values.alts,
		queryMode: values["query-mode"], model: values.model, dtype: values.dtype, topK,
		detailsOut: values["details-out"], privateRoot: values["private-root"],
		privateInput, snapshotHash: values["snapshot-hash"],
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
export function loadGolden(slugs, file = GOLDEN, options = {}) {
	let rows;
	try { rows = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l)); }
	catch { die("invalid query dataset"); }
	return validateDataset(rows, slugs, { enforceGroups: path.resolve(file) !== GOLDEN, ...options });
}

/** 문항 형식과 정답 출처, 정답 단위 분할을 검증한다. */
export function validateDataset(rows, slugs, options = Object.create(null)) {
	if (!Array.isArray(rows) || !rows.length || !slugs.size) die("empty evaluation input");
	const seen = new Set(); const groups = new Map();
	const sensitive = new Set((options.sourceRecords ?? []).filter(sensitiveRecord).map((r) => r.slug));
	for (const r of rows) {
		if (!r || typeof r.query !== "string" || !r.query.trim() || !SPLITS.includes(r.split) || typeof r.holdout !== "boolean" || !Array.isArray(r.expected)) die("invalid query schema");
		if ((r.split === "none") !== (r.expected.length === 0) || new Set(r.expected).size !== r.expected.length) die("invalid answer class");
		if (r.expected.some((s) => typeof s !== "string" || !slugs.has(s) || sensitive.has(s))) die("invalid answer source");
		if (options.publicOnly && r.source !== undefined && r.source !== "fixture") die("invalid public provenance");
		if (seen.has(r.query)) die("duplicate query"); seen.add(r.query);
		for (const s of r.expected) {
			if (options.enforceGroups !== false && groups.has(s) && groups.get(s) !== r.holdout) die("answer split leakage");
			groups.set(s, r.holdout);
		}
		if (r.alts !== undefined && (!Array.isArray(r.alts) || r.alts.some((a) => typeof a !== "string" || !a.trim()))) die("invalid alternate queries");
	}
	return rows;
}

/** 질의 출처에서 제외할 민감 정보 패턴을 판정한다. */
export function sensitiveRecord(record) {
	const text = JSON.stringify(record);
	return /[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[0-9a-f]{1,4}:){3,}[0-9a-f:]*\b|\b[0-9a-f]{1,4}::[0-9a-f:]+\b|(?:password|passwd|secret|token|api[_ -]?key|비밀번호|패스워드|토큰|인증키|계정|고객|주민번호|전화번호)|\b\d{6}[- ]?[1-4]\d{6}\b|\b01[016789][- .]?\d{3,4}[- .]?\d{4}\b|[a-z]:\\/i.test(text);
}

/** 대체 문장을 독립 질의로 펼치고 원문의 정답과 분할을 유지한다. */
export function expandAlts(rows, alts, mode = "original", multi = false) {
	return rows.flatMap((row) => {
		const alternatives = [...new Set(alts?.get(`${row.split}\u0000${row.query}`) ?? row.alts ?? [])].filter((q) => q !== row.query).slice(0, MAX_ALTS);
		if (mode === "original") return [{ ...row, alts: multi ? alternatives : undefined }];
		if (!alternatives.length) die("alternate queries missing");
		return alternatives.map((query) => ({ ...row, query, alts: multi ? alternatives.filter((q) => q !== query) : undefined }));
	});
}

/** 고정 변형 파일을 읽어 골든 행마다 변형 1~3개가 정확히 한 묶음 있는지 검사하고 split·query → 변형 Map 을 돌려준다 */
function loadAlts(rows, file = ALTS) {
	const want = new Set(rows.map((r) => `${r.split}\u0000${r.query}`));
	const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
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

/** 운영체제 임시 폴더에 픽스처 사본을 만든다. */
function copyFixture(tag) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bbm-eval-${tag}-`));
	fs.cpSync(FIXTURE, dir, { recursive: true });
	return dir;
}

/** 순위 목록에서 질의 하나의 판정값을 계산한다 */
export function judge(row, ranked) {
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
		return { n, anyResultRate: mean((x) => (x.ranked.length > 0 ? 1 : 0)), meanCandidates: mean((x) => x.ranked.totalMatched ?? x.ranked.length) };
	}
	return { n, recall1: mean((x) => x.j.recall1), recall5: mean((x) => x.j.recall5), mrr: mean((x) => x.j.rr) };
}

/** 양성 재현율과 none 결과 반환 비율을 독립 분모로 집계한다. */
export function metrics(items) {
	const positives = items.filter((x) => x.row.expected.length); const negatives = items.filter((x) => !x.row.expected.length);
	const mean = (xs, fn) => xs.length ? xs.reduce((s, x) => s + fn(x), 0) / xs.length : null;
	return { n: items.length, recall1: mean(positives, (x) => judge(x.row, x.ranked).recall1), recall5: mean(positives, (x) => judge(x.row, x.ranked).recall5), mrr: mean(positives, (x) => judge(x.row, x.ranked).rr), noneFpr: mean(negatives, (x) => x.ranked.some((r) => r.score >= NONE_T) ? 1 : 0), noneAny: mean(negatives, (x) => x.ranked.length ? 1 : 0) };
}

/** 요청한 두 결합과 모든 하한·가중치 조합을 생성한다. */
export function grid() {
	return FUSIONS.flatMap((fusion) => GRID_W.flatMap((w) => GRID_TAU.map((tau) => ({ fusion, w, tau, topK: 10 }))));
}

/** 세 결정 조건을 만족한 tune 후보 중 단순한 조합을 선택한다. */
export function selectCandidate(candidates, baseline, currentModel = "Xenova/multilingual-e5-small") {
	const qualifies = (m) => {
		const keys = ["exactR1", "noneAny", "publicR5", "publicMrr", "opsR5", "opsMrr"];
		if (!m || keys.some((k) => !Number.isFinite(m[k]) || !Number.isFinite(baseline[k]))) return false;
		if (m.exactR1 < baseline.exactR1 || m.noneAny > baseline.noneAny + 0.02 + 1e-12) return false;
		if (baseline.exactRates && (!m.exactRates || baseline.exactRates.some((v, i) => !Number.isFinite(m.exactRates[i]) || m.exactRates[i] < v))) return false;
		if (m.noneFpr !== undefined && (!Number.isFinite(m.noneFpr) || m.noneFpr > baseline.noneFpr + 0.02 + 1e-12)) return false;
		if (baseline.noneRates && (!m.noneRates || baseline.noneRates.some((v, i) => !Number.isFinite(m.noneRates[i]) || m.noneRates[i] > v + 0.02 + 1e-12))) return false;
		return ["public", "ops"].every((k) => m[`${k}R5`] + 1e-12 >= baseline[`${k}R5`] + 0.05 && m[`${k}Mrr`] + 1e-12 >= baseline[`${k}Mrr`] + 0.03);
	};
	const complexity = (c) => c.model !== currentModel ? 2 : c.fusion === "add" && c.w === 1 && (c.topK ?? 10) === 10 ? 0 : 1;
	const gain = (c) => c.tune.publicR5 + c.tune.opsR5 + c.tune.publicMrr + c.tune.opsMrr;
	return candidates.filter((c) => qualifies(c.tune)).sort((a, b) => complexity(a) - complexity(b) || gain(b) - gain(a) || b.tau - a.tau || a.w - b.w || a.model.localeCompare(b.model) || a.fusion.localeCompare(b.fusion))[0] ?? null;
}

/** tune에서 고른 하나만 holdout으로 판정하고 실패하면 기본값을 유지한다. */
export function decideCandidate(candidates, baseline, currentModel) {
	const selected = selectCandidate(candidates, baseline.tune, currentModel);
	const accepted = selected && selectCandidate([{ ...selected, tune: selected.holdout }], baseline.holdout, currentModel) ? selected : null;
	return { selected, accepted, keepDefaults: !accepted };
}

/** 결과의 스냅샷 출처가 현재 입력과 같은지 검사한다. */
export function validateProvenance(value, hash) {
	if (!hash || value.snapshotHash !== hash) die("snapshot provenance mismatch");
}

/** 평가 프로세스에 필요한 운영체제 환경만 복사한다. */
export function evaluationEnv(source, opts) {
	const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|NODE_NO_WARNINGS)$/i;
	return Object.fromEntries([...Object.entries(source).filter(([k]) => allowed.test(k)), ["ASTRONRAG_SCORER", opts.scorer ?? "legacy"], ["ASTRONRAG_SHADOW", "0"], ...(opts.altWeight === undefined ? [] : [["ASTRONRAG_ALT_WEIGHT", String(opts.altWeight)]])]);
}

/** 원본 보존 검사에 필요한 전체 기억 식별 집합만 읽는다. */
export function corpusIdentity(backend) {
	const load = backend.loadAll;
	return (typeof load === "function" ? load.call(backend, true) : backend.listSlugs(true)).map((r) => r.slug).sort();
}

/** 심볼릭 링크와 저장소 내부를 거부하고 명시한 비공개 루트 안의 상세 경로를 검증한다. */
export function privatePath(input, opts = Object.create(null)) {
	const target = path.resolve(input);
	const under = (base, value) => { const rel = path.relative(base.toLowerCase(), value.toLowerCase()); return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel); };
	if (input.split(/[\\/]/).includes("..")) die("invalid detail destination");
	if (!opts.privateRoot) die("private output requires explicit root");
	const base = path.resolve(opts.privateRoot);
	if (base.toLowerCase() === root.toLowerCase() || under(root, base) || target.toLowerCase() === root.toLowerCase() || under(root, target) || !under(base, target)) die("invalid detail destination");
	let current = path.parse(target).root;
	for (const part of target.slice(current.length).split(path.sep)) {
		current = path.join(current, part);
		if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) die("linked detail destination");
	}
	return target;
}

/** 외부 출력에는 건수와 집계 지표만 남긴다. */
export function aggregateOutput(value) {
	const numbers = new Set(["n", "count", "recall1", "recall5", "mrr", "noneFpr", "noneAny", "anyResultRate", "meanCandidates", "p50", "p95"]);
	const containers = new Set(["fixture", "golden", "splits", "positive", ...SPLITS, "tune", "holdout", "all", "latencyMs"]);
	const clean = (obj) => Object.fromEntries(Object.entries(obj ?? {}).flatMap(([k, v]) => numbers.has(k) && (Number.isFinite(v) || v === null) ? [[k, v]] : containers.has(k) && v && typeof v === "object" && !Array.isArray(v) ? [[k, clean(v)]] : []));
	return clean(value);
}

/** 모델 실행 실패를 성능 결과와 구별하고 예외 원문을 버린다. */
export async function runModel(model, execute) {
	try { return { model: model.id, available: true, ...await execute() }; }
	catch { return { model: model.id, available: false, reason: "availability check failed" }; }
}

/** 질의 임베딩과 결합을 포함한 검색을 매번 실행한다. */
export async function measureLatency(store, vec, rows, altsOf, cfg, rounds = LATENCY_ROUNDS) {
	const once = async (row) => {
		const t0 = performance.now();
		if (vec) {
			await vec.vr.sync(store.retriever.entries());
			const qv = await vec.vr.embedQuery(row.query);
			rankRow(store, { ...vec, qv: new Map([[row, qv]]) }, row, altsOf(row), cfg, 5);
		} else rankRow(store, null, row, altsOf(row), null, 5);
		return performance.now() - t0;
	};
	for (const row of rows) await once(row);
	const times = new Array();
	for (let i = 0; i < rounds; i++) for (const row of rows) times.push(await once(row));
	times.sort((a, b) => a - b);
	return { p50: percentile(times, 0.5), p95: percentile(times, 0.95), n: times.length };
}

/** 성공과 예외에 관계없이 평가 자원을 해제한다. */
export async function withEvaluationBackend(session, execute) {
	try { return await execute(session.backend); } finally { await session.cleanup(); }
}

/** 입력 코퍼스의 독립 사본을 열고 종료할 때 원본 해시를 검증한다. */
export async function openEvaluationBackend(opts = Object.create(null)) {
	const url = (f) => pathToFileURL(path.join(root, "dist", f)).href;
	const { FileStore } = await import(url("stores/file-store.js"));
	const { SqliteStore } = await import(url("stores/sqlite-store.js"));
	const corpus = path.resolve(opts.corpus ?? FIXTURE);
	const privateInput = opts.privateInput ?? corpus !== FIXTURE;
	if (privateInput && !opts.privateRoot) die("private workspace required");
	if (privateInput) privatePath(path.join(opts.privateRoot, "runs", "placeholder"), opts);
	const parent = os.tmpdir();
	const dir = fs.mkdtempSync(path.join(parent, "bbm-eval-run-")); let backend; let hash; let identity;
	const sha = () => crypto.createHash("sha256").update(fs.readFileSync(corpus)).digest("hex");
	let databasePath = path.join(dir, "store.sqlite"); let closed = false;
	const cleanup = async () => {
		if (closed) return; closed = true;
		try {
			if (backend && identity && JSON.stringify(corpusIdentity(backend)) !== JSON.stringify(identity)) die("corpus identity changed");
		} finally {
			backend?.close();
			if (path.dirname(path.resolve(dir)) !== path.resolve(parent)) die("invalid cleanup target");
			fs.rmSync(dir, { recursive: true, force: true });
			fs.rmSync(`${dir}-backup`, { recursive: true, force: true });
			if (hash && sha() !== hash) die("source snapshot changed");
		}
	};
	try {
		if (opts.corpusKind === "sqlite") {
			hash = sha(); if (opts.snapshotHash) validateProvenance({ snapshotHash: hash }, opts.snapshotHash);
			fs.copyFileSync(corpus, databasePath);
			backend = new SqliteStore(dir, databasePath, { readOnly: true });
		} else {
			fs.cpSync(corpus, dir, { recursive: true, filter: (src) => ![".bbm", ".git", ".astron-logs"].includes(path.basename(src)) });
			if (opts.storeKind === "sqlite") {
				databasePath = path.join(dir, ".bbm/evaluation.sqlite");
				runMigration({ vault: dir, storePath: databasePath, backupPath: `${dir}-backup`, dryRun: false, merge: false, verify: false });
				backend = new SqliteStore(dir, databasePath);
			} else backend = new FileStore(dir);
		}
		identity = corpusIdentity(backend);
		if (!identity.length && !opts.allowEmpty) die("empty corpus");
		return { backend, dir, databasePath, snapshotHash: hash, identity, cleanup };
	} catch (error) { await cleanup(); throw error; }
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
/** 지정한 출력 정책에 따라 JSON을 기록한다. */
export function emit(result, out, summaryKeys = new Array(), opts = Object.create(null)) {
	if (opts.detailsOut) {
		const dest = opts.privateInput ? privatePath(opts.detailsOut, opts) : path.resolve(opts.detailsOut);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		if (opts.privateInput) privatePath(dest, opts);
		fs.writeFileSync(dest, JSON.stringify(result, null, 2) + "\n", "utf8");
	}
	if (opts.privateInput) {
		const text = JSON.stringify(aggregateOutput(result), null, 2) + "\n";
		if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, text, "utf8"); }
		process.stdout.write(text); return;
	}
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


/** 모델별 색인을 준비하고 질의를 임베딩하며 자원 사용량을 기록한다. */
export async function prepareVector(store, vault, rows, opts = Object.create(null)) {
	const url = (f) => pathToFileURL(path.join(root, "dist", f)).href;
	const mod = await import(url("vector-retriever.js"));
	store.retriever.sync(vault);
	const t0 = performance.now();
	const model = opts.model ?? mod.MODEL_ID; const dtype = opts.dtype ?? mod.DTYPE;
	const embed = await mod.loadEmbedder(model, dtype);
	const loadMs = performance.now() - t0;
	const vr = new mod.VectorRetriever(opts.privateInput ? vault : null, embed, `${model}@${dtype}`);
	const startEmbed = performance.now();
	await vr.warm(() => store.retriever.entries());
	if (vr.state !== "ready") throw new Error("model unavailable");
	const corpusEmbedMs = performance.now() - startEmbed;
	const qv = new Map();
	const queryStart = performance.now();
	for (const row of rows) qv.set(row, await vr.embedQuery(row.query));
	const keys = store.retriever.entries().map((e) => e.key);
	const queryEmbedMs = performance.now() - queryStart;
	const modelCache = path.join(mod.MODEL_CACHE_DIR, ...model.split("/"));
	let cacheBytes = 0;
	const pending = fs.existsSync(modelCache) ? [modelCache] : [];
	while (pending.length) {
		const directory = pending.pop(); if (!directory) break;
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const file = path.join(directory, entry.name);
			if (entry.isDirectory()) pending.push(file);
			else if (entry.isFile()) cacheBytes += fs.statSync(file).size;
		}
	}
	return { mod, vr, qv, keys, model, dtype, loadMs, corpusEmbedMs, queryEmbedMs, cacheBytes, prefix: /multilingual-e5-/.test(model) ? "query: /passage: " : "none", dimension: qv.values().next().value?.length ?? 0, maxRssMB: process.resourceUsage().maxRSS / 1024, embedMs: Math.round(performance.now() - t0) };
}

/** 실제 결합 경로에서 상위 5건과 첫 정답 순위를 정확히 구한다. */
export function rankRow(store, vec, row, alts, cfg, requestedLimit = Number.NaN) {
	const fixedLimit = Number.isFinite(requestedLimit);
	const base = { limit: fixedLimit ? requestedLimit : (Array.isArray(row.expected) ? 5 : FULL_LIMIT), includeLinked: false, altQueries: alts };
	const vectorHits = cfg ? vec.vr.nearest(vec.qv.get(row), {}, cfg.topK ?? vec.mod.VECTOR_TOP_K, cfg.tau).map((h) => ({ key: h.key, score: cfg.w * h.cos })) : undefined;
	const options = { ...base, vectorHits, vectorFusion: cfg?.fusion, vectorWeight: cfg?.w };
	let outcome = store.searchDetailed(row.query, options);
	while (!fixedLimit && row.expected?.length && !outcome.results.some((r) => row.expected.includes(r.record.slug)) && options.limit < outcome.totalMatched) {
		options.limit = Math.min(outcome.totalMatched, options.limit * 2);
		outcome = store.searchDetailed(row.query, options);
	}
	const ranked = outcome.results.map((r) => (r.via ? { slug: r.record.slug, score: r.score, via: r.via } : { slug: r.record.slug, score: r.score }));
	Object.defineProperty(ranked, "totalMatched", { value: outcome.totalMatched });
	return ranked;
}

/** none 질의 가운데 상위 5건에 벡터 전용 결과가 하나라도 있는 비율 */
function vectorTop5Rate(items) {
	if (items.length === 0) return null;
	return items.filter((x) => x.ranked.slice(0, 5).some((r) => r.via)).length / items.length;
}

/** tune 분할의 모든 격자 조합을 측정하고 통합 선택에 필요한 지표를 반환한다. */
export function runGrid(rows, rankFn) {
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
			paraphraseMrr: summarize(of("paraphrase")).mrr ?? Number.NaN,
			positive: metrics(items),
			noneFprT9: curvePoint(items, NONE_T).fpr ?? Number.NaN,
			noneAnyResult: summarize(of("none")).anyResultRate ?? Number.NaN,
			noneVectorTop5: vectorTop5Rate(of("none")),
		};
	};
	const base = measure(null);
	const configs = grid().map((cfg) => ({ ...cfg, tune: measure(cfg) }));
	const rrf = configs.filter((c) => c.fusion === "rrf");
	const add = configs.filter((c) => c.fusion === "add");
	return {
		rule: "tune only; final selection requires exact recall, both paraphrase gains and each none result rate",
		split: "tune",
		base,
		rrf,
		add,
		configs,
		pick: null,
		decision: "Select across golden, public and operational tune results, then validate the selected candidate once on holdout.",
	};
}

/** 고정 코퍼스에서 같은 유효 후보 조합의 격자 순위 결과를 재사용한다. */
export async function runCachedGrid(store, vec, rows, altsOf) {
	const { parseQuery } = await import(pathToFileURL(path.join(root, "dist/store.js")).href);
	const states = new Map();
	return runGrid(rows, (row, cfg) => {
		let state = states.get(row);
		if (!state) {
			const queries = [row.query, ...(altsOf(row) ?? []).slice(0, MAX_ALTS)].map((query) => parseQuery(query));
			const lexical = new Set(queries.filter((q) => q.tokens.length).flatMap((q) => store.retriever.search(q, Infinity, {}, readEnv("ASTRONRAG_SCORER", "BBM_SCORER") ?? "legacy").map((c) => c.record.slug)));
			state = { lexical, ranked: new Map() }; states.set(row, state);
		}
		const fusion = cfg?.fusion ?? "add";
		const hits = cfg ? vec.vr.nearest(vec.qv.get(row), {}, cfg.topK, cfg.tau) : [];
		const effective = fusion === "add"
			? hits.filter((h) => !state.lexical.has(store.retriever.candidate(h.key, {})?.record.slug)).map((h) => [h.key, cfg.w * h.cos])
			: hits.map((h) => h.key);
		const key = JSON.stringify([fusion, fusion === "rrf" && hits.length ? cfg.w : 0, effective]);
		if (!state.ranked.has(key)) state.ranked.set(key, rankRow(store, cfg ? vec : null, row, altsOf(row), cfg));
		return state.ranked.get(key);
	});
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

async function main(opts) {
	const storeKind = readEnv("ASTRONRAG_STORE", "BBM_STORE") === "file" ? "file" : "sqlite";
	const cleanEnv = evaluationEnv(process.env, opts);
	for (const key of Object.keys(process.env)) if (!(key in cleanEnv)) delete process.env[key];
	Object.assign(process.env, cleanEnv, { ASTRONRAG_STORE: storeKind });
	if (opts.privateInput && opts.detailsOut) privatePath(opts.detailsOut, opts);

if (opts.compare) {
	emit(compare(opts.compare[0], opts.compare[1]), opts.out, ["all", "holdout", "unmatched"]);
	return;
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

// 공개 입력은 사본 준비 전에 검증한다.
const fixtureSlugs = new Set(
	fs.readdirSync(path.join(FIXTURE, "memories")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)),
);
let golden = opts.privateInput ? [] : loadGolden(fixtureSlugs, opts.queries ?? GOLDEN, { publicOnly: true });
const fixedAlts = (opts.multi || opts.queryMode === "alts") && (!opts.queries || path.resolve(opts.queries) === GOLDEN) ? loadAlts(golden, opts.alts) : null;
const usedAlts = fixedAlts && opts.altControl ? derangeAlts(golden, fixedAlts, opts.seed) : fixedAlts;
/** 행에 넘길 alt_queries — --multi 가 없으면 undefined */
const altsOf = (row) => row.alts;

const realNow = Date.now;
let session;
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
	session = await openEvaluationBackend({ ...opts, storeKind, corpusKind: opts.corpus ? opts.corpusKind : "file" });
	Date.now = () => FROZEN_NOW;
	const metricBackend = session.backend;
	const store = new MemoryStore(metricBackend);
	store.reinforce = () => {};
	const records = store.loadAll(true);
	if (!records.length) die("empty corpus");
	if (opts.privateInput) {
		golden = loadGolden(new Set(records.map((r) => r.slug)), opts.queries, { sourceRecords: records });
		if (session.snapshotHash) for (const row of golden) validateProvenance(row, session.snapshotHash);
	}
	golden = expandAlts(golden, usedAlts, opts.queryMode, opts.multi);
	store.retriever.sync(metricBackend);
	const types = {};
	for (const r of records) types[r.type] = (types[r.type] ?? 0) + 1;

	// 벡터: 임베딩은 실제 시계로 한 번만 계산하고, 순위화는 고정 시계에서 한다
	Date.now = realNow;
	const vec = opts.vector ? await prepareVector(store, metricBackend, golden, opts) : null;
	Date.now = () => FROZEN_NOW;
	if (vec && opts.auc) {
		Date.now = realNow;
		emit({ mode: "auc", model: vec.mod.MODEL_ID, dtype: vec.mod.DTYPE, seed: opts.seed, negativesPerQuery: AUC_NEG, ...crosslangAuc(vec, golden, opts.seed) }, opts.out, ["all", "tune", "holdout"]);
		break evaluation;
	}
	if (vec && opts.grid) {
		const synchronize = store.retriever.sync;
		let grid;
		try {
			store.retriever.sync = () => {};
			grid = await runCachedGrid(store, vec, golden, altsOf);
		} finally { store.retriever.sync = synchronize; }
		Date.now = realNow;
		const upper = [...grid.configs].sort((a, b) => (b.tune.paraphraseR5 - a.tune.paraphraseR5) || (b.tune.paraphraseMrr - a.tune.paraphraseMrr) || b.tau - a.tau || a.w - b.w).slice(0, 2);
		const latencyRows = [...golden.filter((r) => !r.holdout && r.expected.length).slice(0, 3), ...golden.filter((r) => !r.holdout && !r.expected.length).slice(0, 3)];
		for (const config of grid.configs) {
			if (upper.includes(config) || ([0.7, 0.9].includes(config.tau) && [1, 5].includes(config.w))) config.latencyMs = await measureLatency(store, vec, latencyRows, altsOf, config, 1);
		}
		const resources = { model: vec.model, dtype: vec.dtype, loadMs: vec.loadMs, corpusEmbedMs: vec.corpusEmbedMs, queryEmbedMs: vec.queryEmbedMs, queryCount: golden.length, corpusCount: records.length, cacheBytes: vec.cacheBytes, prefix: vec.prefix, dimension: vec.dimension, maxRssMB: process.resourceUsage().maxRSS / 1024 };
		emit({ mode: "grid", ...resources, snapshotHash: session.snapshotHash, count: golden.length, ...grid }, opts.out, ["rule", "base", "pick"], opts);
		break evaluation;
	}
	const vectorCfg = vec
		? { fusion: opts.fusion, w: opts.vectorWeight ?? vec.mod.VECTOR_WEIGHT, tau: opts.minCos ?? vec.mod.VECTOR_MIN_COS, topK: opts.topK }
		: null;

	const synchronize = store.retriever.sync;
	let items;
	try {
		store.retriever.sync = () => {};
		items = golden.map((row) => {
			const ranked = rankRow(store, vec, row, altsOf(row), vectorCfg);
			return { row, ranked, j: judge(row, ranked) };
		});
	} finally { store.retriever.sync = synchronize; }
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

	// 지연은 실제 시계와 고정된 사본에서 매회 검색 경로를 실행한다.
	const latencyRows = opts.privateInput ? [...golden.filter((r) => r.expected.length).slice(0, 6), ...golden.filter((r) => !r.expected.length).slice(0, 6)] : golden;
	const latencyMs = await measureLatency(store, vec, latencyRows, altsOf, vectorCfg);

	const result = {
		snapshotHash: session.snapshotHash,
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
						model: vec.model,
						dtype: vec.dtype,
						loadMs: vec.loadMs, corpusEmbedMs: vec.corpusEmbedMs, queryEmbedMs: vec.queryEmbedMs, dimension: vec.dimension, maxRssMB: process.resourceUsage().maxRSS / 1024, cacheBytes: vec.cacheBytes, prefix: vec.prefix,
						...vectorCfg,
						topK: vectorCfg.topK,
						embedMs: vec.embedMs,
						noneVectorTop5: {
							tune: vectorTop5Rate(items.filter((x) => x.row.split === "none" && !x.row.holdout)),
							holdout: vectorTop5Rate(items.filter((x) => x.row.split === "none" && x.row.holdout)),
							all: vectorTop5Rate(items.filter((x) => x.row.split === "none")),
						},
						latencyNote: "sync + embedQuery + nearest + searchDetailed",
					},
				}
			: {}),
		latencyMs,
		queries: items.map((x) => ({
			query: x.row.query,
			split: x.row.split,
			holdout: x.row.holdout,
			expected: x.row.expected,
			top5: x.ranked.slice(0, 5),
			firstRank: x.j.firstRank,
		})),
	};

	emit(result, opts.out, ["scorer", "shadow", "fixture", "splits", "g2", "latencyMs", "permuteControl", "multi", "vector"], opts);
} finally {
	Date.now = realNow;
	if (session) await session.cleanup();
	for (const d of diffDirs) {
		if (path.dirname(path.resolve(d)) !== path.resolve(os.tmpdir())) die("invalid cleanup target");
		fs.rmSync(d, { recursive: true, force: true });
	}
}

}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const privateRun = process.argv.includes("--queries") && process.argv.includes("--corpus");
	const originalError = console.error; const originalWarn = console.warn;
	if (privateRun) { console.error = () => {}; console.warn = () => {}; }
	try { await main(readArgs(process.argv.slice(2))); }
	catch (error) {
		process.stderr.write("eval-retrieval: evaluation failed (input, model or storage unavailable)\n");
		process.exitCode = error.exitCode ?? 1;
	} finally { console.error = originalError; console.warn = originalWarn; }
}
