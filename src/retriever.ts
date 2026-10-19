import fs from "node:fs";
import path from "node:path";
import { logWarn } from "./log.js";
import type { MemoryStore as Storage } from "./stores/memory-store.js";
import { cloneRecord, writeFileAtomic } from "./vault.js";
import type { MemoryRecord, MemoryType } from "./types.js";

/** 이보다 토큰이 적은 집합은 유사도 판단 근거가 부족하다고 보고 비교하지 않는다 */
export const MIN_OVERLAP_TOKENS = 3;
/** 동의어로만 맞은 토큰의 가중 — 정확히 일치한 기억이 여전히 위로 오게 한다 (감사 D1) */
export const SYNONYM_WEIGHT = 0.6;
/** 키워드 점수 계산 방식 — legacy 는 필드 가중 고정 점수, bm25f 는 필드 가중 BM25F */
export type Scorer = "legacy" | "bm25f";
/** BM25F 필드 가중 — 제목·태그·설명·본문 순 */
export const BM25F_W = [5, 4, 3, 1];
/** BM25F 필드 길이 정규화 강도 — 설명은 스키마상 한 줄 요약이라 길이가 주제 폭이 아니어서 제목·태그와 같게 둔다 */
export const BM25F_B = [0.3, 0.3, 0.3, 0.75];
/** BM25F 빈도 포화 상수 */
export const BM25F_K1 = 1.2;
/** 영속 역색인 디렉터리 — 볼트 루트 아래에 두고, 안에 "*" 한 줄 .gitignore 를 둔다 */
export const INDEX_DIR = ".bbm-index";
/** 역색인 형식 버전 — 토큰화·조사 목록·파일 구조가 바뀌면 올린다 */
export const INDEX_VERSION = 1;
/** 역색인 파일 이름 */
export const INDEX_FILE = `lexical.v${INDEX_VERSION}.json`;

/** 텍스트를 소문자 문자·숫자 연속열(2자 이상) 토큰으로 자른다 */
export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((t) => t.length >= 2);
}

/** 한국어 조사 — 긴 것부터 (부분 스트립 방지) */
export const PARTICLES = [
	"으로서", "으로써", "에게서", "이라도", "으로", "에서", "부터", "까지", "에게", "한테",
	"보다", "처럼", "이나", "라도", "조차", "마저", "밖에", "라는", "이란",
	"을", "를", "이", "가", "은", "는", "에", "의", "로", "와", "과", "도", "만", "나",
];

/** 조사를 떼어낸 어간. 남는 길이가 2 미만이면 원형을 유지한다 */
export function stripParticle(t: string): string {
	for (const p of PARTICLES) {
		if (t.length - p.length >= 2 && t.endsWith(p)) return t.slice(0, -p.length);
	}
	return t;
}

/**
 * 링크 메타데이터를 본문에서 제거한다 (감사 D6).
 * link() 는 본문에 `## 연관 기억` 섹션과 `[[슬러그]]` 를 주입하는데, 이것이 검색
 * 대상에 포함되면 링크만 걸린 무관한 기억이 상대 기억의 제목 토큰 질의에
 * **직접 매칭**으로 잡히고 `include_linked: false` 로도 배제되지 않았다.
 * 링크가 많은 허브 기억일수록 무관 질의에 끌려나오고 강화 오염도 커진다.
 */
export function stripLinkSection(body: string): string {
	return body
		.replace(/\n#{1,6}\s*연관 기억[\s\S]*$/u, "")
		.replace(/\[\[[^\]]+\]\]/gu, "")
		.trim();
}

/**
 * 토큰 동일성 — 조사 변화를 흡수하되 **단어 경계는 지킨다** ("모드를" ≈ "모드").
 *
 * 종전에는 무제한 양방향 접두 일치라 단어 경계 개념이 없었다(감사 D3):
 * "서버리스"≈"서버", "인증서"≈"인증", "부산물"≈"부산" 이 모두 참이 되어
 * 무관한 기억이 similar 로 보고되고(→ instructions 가 revise 병합을 유도) RIF 로
 * 순위가 반토막 났다.
 *
 * 흡수하려던 것은 조사뿐이므로 조사를 **명시적으로 떼어내** 비교한다.
 * 그 밖의 복합어 접두는 짧은 쪽 3자 이상 + 길이차 2 이하일 때만 인정한다
 * ("릴리스노트"≈"릴리스" 는 통과, "서버리스"≈"서버" 는 차단).
 */
export function tokenMatch(a: string, b: string): boolean {
	if (a === b) return true;
	const na = stripParticle(a);
	const nb = stripParticle(b);
	if (na === nb) return true;
	const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
	return short.length >= 3 && long.length - short.length <= 2 && long.startsWith(short);
}

/**
 * overlap 계수 — **자카드**(합집합 대비 겹침).
 *
 * 종전 분모는 min(|A|,|B|) 라, 비교 대상 한쪽이 1~2 토큰으로 희소하기만 하면
 * 토큰 하나만 겹쳐도 유사도가 0.5~1.0 으로 치솟았다(감사 D3). 제목이 짧은 메모 하나가
 * 그 토큰을 공유하는 볼트 전체를 매 질의마다 RIF 로 억제하는 구조였다
 * (실측: 무관한 빌드 문서 3건이 11.52 → 5.76 으로 반토막, overlap 1.0 vs 자카드 0.10).
 * 자카드는 한쪽이 희소해도 부풀지 않아 "근접 중복만 누른다" 는 P5 의도에 맞다.
 *
 * 추가 안전장치: 비교 집합이 3 토큰 미만이면 판단 근거가 부족하므로 0 을 돌려준다.
 */
export function overlap(a: string[], b: string[]): number {
	const sa = [...new Set(a)];
	const sb = [...new Set(b)];
	if (sa.length < MIN_OVERLAP_TOKENS || sb.length < MIN_OVERLAP_TOKENS) return 0;
	let inter = 0;
	for (const t of sa) if (sb.some((u) => tokenMatch(t, u))) inter++;
	const union = sa.length + sb.length - inter;
	return union === 0 ? 0 : inter / union;
}

/**
 * 프로젝트 스코프 필터 (감사 E2).
 * `project` 가 없는 기억은 **전역**이라 어느 프로젝트에서도 통과한다.
 * project 인자가 없으면 필터 자체를 적용하지 않는다(전체 조회).
 */
export function inScope(m: MemoryRecord, project?: string): boolean {
	if (!project) return true;
	return !m.project || m.project === project;
}

/** 해석된 질의 — 원 토큰, 동의어까지 확장한 토큰, 만점 가중을 받는 원 토큰 집합 */
export interface ParsedQuery {
	tokens: string[];
	expanded: string[];
	exact: Set<string>;
}

/** 후보 범위 제한 — 기억 유형과 프로젝트 스코프 */
export interface ScopeFilter {
	type?: MemoryType;
	project?: string;
}

/** 질의 토큰 하나가 어느 필드에서 얼마의 점수를 얻었는지 */
export interface FieldHit {
	field: "title" | "tags" | "description" | "body";
	token: string;
	weight: number;
}

/** 검색 후보 1건 — 관련도 점수와 랭커가 재조회·재토큰화 없이 쓸 레코드·제목+설명 토큰 */
export interface Candidate {
	slug: string;
	score: number;
	fields: FieldHit[];
	record: MemoryRecord;
	titleDescTokens: string[];
	/** 벡터 검색으로만 들어온 후보 표시 */
	via?: "vector";
}

/** 후보와 관련도 점수만 내는 검색기 — 가중·억제·강화는 하지 않는다 */
export interface Retriever {
	readonly name: "lexical" | "vector";
	search(q: ParsedQuery, k: number, filter: ScopeFilter, scorer?: Scorer): Candidate[];
	upsert(rec: MemoryRecord, archived?: boolean): void;
	remove(slug: string): void;
	sync(vault: Storage): void;
	/** 항목 키와 레코드를 항목 순서대로 — 레코드는 공유 참조라 변이하면 안 된다 */
	entries(): { key: string; record: MemoryRecord }[];
	/** 항목 키의 점수 0 후보 — 없거나 범위 밖이면 null */
	candidate(key: string, filter: ScopeFilter): Candidate | null;
}

/** 질의별 후보 목록을 가중 최대 점수로 합친다 — 색인 항목마다 w_q × 원점수 중 가장 큰 값을 쓴다 */
export function fuseWeightedMax(lists: Candidate[][], weights: number[]): Candidate[] {
	// 한 sync 안에서 색인 항목마다 토큰 배열이 하나라, 이것을 키로 memories·archive 의 같은 slug 를 가른다
	const fused = new Map<string[], Candidate>();
	lists.forEach((list, qi) => {
		for (const c of list) {
			const score = weights[qi] * c.score;
			const prev = fused.get(c.titleDescTokens);
			if (!prev || score > prev.score) fused.set(c.titleDescTokens, { ...(prev ?? c), score });
		}
	});
	return [...fused.values()];
}

/** 레코드 1건의 색인 항목 — 항목 키, 파일 신원, 레코드, 필드별 사전 토큰 */
interface Entry {
	key: string;
	/** 읽기 직전에 뜬 (ino, mtimeNs, size) — 디스크와 대조하지 않은 항목(upsert)은 null */
	stat: FileStat | null;
	record: MemoryRecord;
	titleT: string[];
	tagT: string[];
	descT: string[];
	bodyT: string[];
	titleDescT: string[];
}

/** 위치와 slug 로 만드는 항목 키 — memories 와 archive 의 같은 slug 를 구분한다 */
function entryKey(slug: string, archived: boolean): string {
	return `${archived ? "a" : "m"}:${slug}`;
}

/** BM25F 검색 1회의 통계 — 질의 토큰별 IDF, 필드별 평균 토큰 수 */
interface Bm25fStats {
	idf: number[];
	avg: number[];
}

/** 필드 번호(posting 의 필드 칸) → 필드 이름 */
const FIELD_NAMES: FieldHit["field"][] =["title", "tags", "description", "body"];

/**
 * 문서 1건의 BM25F 점수 — Σ_t w_t·IDF(t)·tf~/(K1+tf~), tf~ = Σ_f W_f·tf_f/(1-B_f+B_f·len_f/avg_f).
 * w_t 는 원 토큰 1·동의어 SYNONYM_WEIGHT, tf_f 는 퍼지로 맞은 표층 토큰 빈도의 합이다. 필드별 몫을 fields 에 넣어 합이 점수와 같게 한다.
 */
function bm25fScore(q: ParsedQuery, h: number[], e: Entry, bm: Bm25fStats, fields: FieldHit[]): number {
	const lens = [e.titleT.length, e.tagT.length, e.descT.length, e.bodyT.length];
	let score = 0;
	q.expanded.forEach((t, ti) => {
		const parts = [0, 0, 0, 0];
		let tf = 0;
		for (let f = 0; f < 4; f++) {
			const n = h[ti * 4 + f];
			if (n <= 0) continue;
			parts[f] = (BM25F_W[f] * n) / (1 - BM25F_B[f] + (BM25F_B[f] * lens[f]) / bm.avg[f]);
			tf += parts[f];
		}
		if (tf === 0) return;
		const s = ((q.exact.has(t) ? 1 : SYNONYM_WEIGHT) * bm.idf[ti] * tf) / (BM25F_K1 + tf);
		score += s;
		parts.forEach((p, f) => {
			if (p > 0) fields.push({ field: FIELD_NAMES[f], token: t, weight: (s * p) / tf });
		});
	});
	return score;
}

/** 파일 신원 (ino, mtimeNs, size) — 십진 문자열 */
type FileStat = [string, string, string];

/** 인덱스 파일의 문서 1건 — 항목 키, 파일 신원, 필드별 토큰 수·토큰, 제목+설명 토큰, 레코드 */
interface IndexDoc {
	key: string;
	stat: FileStat | null;
	len: number[];
	title: string[];
	tags: string[];
	description: string[];
	body: string[];
	titleDesc: string[];
	record: MemoryRecord;
}

/** 인덱스 파일 — 문서, 표층 토큰 posting([문서 위치, 필드 번호, 빈도] 반복), 어간 → 표층 토큰 사전(어간 오름차순) */
interface IndexFile {
	version: number;
	docs: IndexDoc[];
	postings: [string, number[]][];
	stems: [string, string[]][];
}

/** 파일의 (ino, mtimeNs, size) — 없거나 stat 이 실패하면 null */
function fileStat(fp: string): FileStat | null {
	try {
		const st = fs.statSync(fp, { bigint: true, throwIfNoEntry: false });
		return st ? [String(st.ino), String(st.mtimeNs), String(st.size)] : null;
	} catch {
		return null;
	}
}

/** 두 파일 신원이 모두 있고 세 값이 전부 같은지 */
function sameStat(a: FileStat | null, b: FileStat | null): boolean {
	return !!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** 항목 키가 가리키는 기억 파일 경로 */
function keyPath(root: string, key: string): string {
	return path.join(root, key.startsWith("a:") ? "archive" : "memories", `${key.slice(2)}.md`);
}

/** 문자열 배열인지 */
function isStrings(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}

const RECORD_STRINGS = ["id", "slug", "title", "description", "type", "status", "created", "updated", "lastAccessed", "lastReinforced", "body"];
const RECORD_OPTIONAL = ["source", "project", "reviewAfter", "supersedes", "supersededBy", "archiveReason"];
const RECORD_NUMBERS = ["confidence", "storageStrength", "accessCount"];
const RECORD_LISTS = ["tags", "links", "history"];

/** 검색·순위화가 읽는 레코드 필드가 전부 제 형태인지 */
function validRecord(v: unknown): v is MemoryRecord {
	if (!v || typeof v !== "object") return false;
	const r = v as Record<string, unknown>;
	return (
		RECORD_STRINGS.every((k) => typeof r[k] === "string") &&
		RECORD_OPTIONAL.every((k) => r[k] === undefined || typeof r[k] === "string") &&
		RECORD_NUMBERS.every((k) => typeof r[k] === "number") &&
		RECORD_LISTS.every((k) => isStrings(r[k])) &&
		(r.derivedFrom === undefined || isStrings(r.derivedFrom))
	);
}

/** 인덱스 파일 내용이 이 버전의 형태인지 — posting 이 가리키는 문서 위치·필드 번호까지 본다 */
function validIndex(v: unknown): v is IndexFile {
	if (!v || typeof v !== "object") return false;
	const d = v as Record<string, unknown>;
	if (d.version !== INDEX_VERSION || !Array.isArray(d.docs) || !Array.isArray(d.postings) || !Array.isArray(d.stems)) return false;
	const keys = new Set<string>();
	for (const doc of d.docs as IndexDoc[]) {
		// slug 는 빈 문자열일 수 있다(파일명이 ".md") — 위치 접두만 보고 slug 는 레코드와 대조한다
		if (!doc || typeof doc.key !== "string" || !/^[am]:/.test(doc.key) || keys.has(doc.key)) return false;
		keys.add(doc.key);
		if (doc.stat !== null && !(isStrings(doc.stat) && doc.stat.length === 3)) return false;
		if (![doc.title, doc.tags, doc.description, doc.body, doc.titleDesc].every(isStrings)) return false;
		if (!validRecord(doc.record) || doc.record.slug !== doc.key.slice(2)) return false;
	}
	const n = d.docs.length;
	for (const p of d.postings as unknown[]) {
		if (!Array.isArray(p) || typeof p[0] !== "string" || !Array.isArray(p[1]) || p[1].length % 3 !== 0) return false;
		const list = p[1] as unknown[];
		for (let i = 0; i < list.length; i += 3) {
			const [doc, field, tf] = [list[i], list[i + 1], list[i + 2]];
			if (!Number.isInteger(doc) || (doc as number) < 0 || (doc as number) >= n) return false;
			if (!Number.isInteger(field) || (field as number) < 0 || (field as number) > 3) return false;
			if (!Number.isInteger(tf) || (tf as number) < 1) return false;
		}
	}
	return (d.stems as unknown[]).every((s) => Array.isArray(s) && typeof s[0] === "string" && isStrings(s[1]));
}

/** 인덱스 파일을 읽는다 — 없거나 읽지 못하면 undefined, 파싱 실패·버전 불일치·형태 불량이면 null */
function readIndexFile(fp: string): IndexFile | null | undefined {
	let text: string;
	try {
		text = fs.readFileSync(fp, "utf-8");
	} catch {
		return undefined;
	}
	try {
		const data: unknown = JSON.parse(text);
		return validIndex(data) ? data : null;
	} catch {
		return null;
	}
}

/**
 * 필드 가중 키워드 점수(legacy: 제목 5·태그 4·설명 3·본문 최대 3, bm25f: 같은 필드 가중의 BM25F, 둘 다 동의어 0.6배)를 내는 검색기.
 * 표층 토큰 posting 과 어간 사전으로 후보를 찾고, 역색인을 볼트의 .bbm-index/ 에 영속해 새 프로세스가 파일을 다시 파싱하지 않게 한다.
 */
export class LexicalRetriever implements Retriever {
	readonly name = "lexical" as const;
	/** 항목이 속한 볼트 루트 — sync 가 다른 볼트를 받으면 그 볼트의 인덱스 파일을 새로 적재한다 */
	private root: string | null = null;
	/** 항목 — listSlugs(true) 순서, upsert 로 새로 든 항목은 끝에 붙는다 */
	private docs: Entry[] = [];
	private keyIndex = new Map<string, number>();
	/** 표층 토큰 → [문서 위치, 필드 번호, 빈도] 반복 — null 이면 다음 조회·저장 때 항목에서 다시 만든다 */
	private postings: Map<string, number[]> | null = null;
	/** 어간 → 표층 토큰 */
	private stemTerms = new Map<string, string[]>();
	/** 어간 오름차순 목록 — 접두 이분 탐색용 */
	private stems: string[] = [];
	/** 마지막 저장이 실패했으면 다음 sync 가 다시 저장한다 */
	private unsaved = false;
	/** 읽기 전용 검색기의 볼트 루트 — 있으면 인덱스를 저장하지 않고, isCurrent 가 이 루트의 파일과 대조한다 */
	private readOnlyRoot: string | null = null;
	/** 이 검색기가 마지막으로 적재·저장한 인덱스 파일의 신원 — 달라졌으면 지워졌거나 다른 프로세스가 덮어쓴 것이다 */
	private indexStat: FileStat | null = null;

	/**
	 * 훅용 읽기 전용 검색기 — 볼트의 인덱스 파일만 읽는다. 인덱스가 없거나 손상·버전 불일치면 null.
	 * 파일을 만들거나 지우지 않고 기억 파일도 읽지 않는다. 결과가 색인 뒤 바뀌었는지는 isCurrent 로 대조한다.
	 */
	static openReadOnly(vaultRoot: string): LexicalRetriever | null {
		const root = path.resolve(vaultRoot);
		const data = readIndexFile(path.join(root, INDEX_DIR, INDEX_FILE));
		if (!data) return null;
		const r = new LexicalRetriever();
		r.adopt(data);
		r.root = root;
		r.readOnlyRoot = root;
		return r;
	}

	/**
	 * 읽기 전용 검색기에서 slug 의 항목이 지금 파일과 같은 파일 신원인지 — 파일이 없거나 바뀌었으면 false.
	 * 그 slug 의 파일만 stat 한다. 읽기 전용이 아니면 sync 가 이미 대조했으므로 항상 true.
	 */
	isCurrent(slug: string, currentFilePath?: string): boolean {
		const root = this.readOnlyRoot;
		if (!root) return true;
		const keys = [entryKey(slug, false), entryKey(slug, true)].filter((k) => this.keyIndex.has(k));
		return keys.length > 0 && keys.every((k) => {
			const source = currentFilePath ?? keyPath(root, k);
			return sameStat(this.docs[this.keyIndex.get(k) as number].stat, fileStat(source));
		});
	}

	/** 볼트의 인덱스 파일을 적재한다 — 없으면 빈 상태, 손상·버전 불일치면 지우고 빈 상태에서 다시 만든다 */
	private load(vault: Storage): void {
		this.root = path.resolve(vault.root);
		this.docs = [];
		this.keyIndex = new Map();
		this.postings = null;
		this.unsaved = false;
		this.indexStat = null;
		if (vault.nativeMemoryFiles.length > 0) return; // 남의 저장소에는 인덱스를 두지 않는다 (T26)
		const fp = path.join(this.root, INDEX_DIR, INDEX_FILE);
		// 읽기 전에 뜬다 — 읽는 사이 다른 프로세스가 바꾸면 신원이 달라져 다음 sync 가 다시 저장한다
		const st = fileStat(fp);
		const data = readIndexFile(fp);
		if (data === null) {
			logWarn(`역색인 손상·버전 불일치(재생성): ${fp}`);
			try {
				fs.rmSync(fp, { force: true });
			} catch {
				/* 지우지 못해도 다음 저장이 통째로 덮어쓴다 */
			}
			return;
		}
		if (!data) return;
		this.adopt(data);
		this.indexStat = st;
	}

	/** 인덱스 파일 내용을 항목·posting·어간 사전으로 옮긴다 */
	private adopt(data: IndexFile): void {
		this.docs = data.docs.map((d) => ({
			key: d.key,
			stat: d.stat,
			record: d.record,
			titleT: d.title,
			tagT: d.tags,
			descT: d.description,
			bodyT: d.body,
			titleDescT: d.titleDesc,
		}));
		this.keyIndex = new Map(this.docs.map((e, i) => [e.key, i]));
		this.postings = new Map(data.postings);
		this.stemTerms = new Map(data.stems);
		this.stems = data.stems.map((s) => s[0]);
	}

	/** 인덱스 파일과 "*" 한 줄 .gitignore 를 쓴다 — 실패는 경고만 남긴다(인덱스는 캐시다) */
	private persist(vault: Storage): void {
		if (this.readOnlyRoot || !this.root || vault.nativeMemoryFiles.length > 0) return;
		const postings = this.ensurePostings();
		const data: IndexFile = {
			version: INDEX_VERSION,
			docs: this.docs.map((e) => ({
				key: e.key,
				stat: e.stat,
				len: [e.titleT.length, e.tagT.length, e.descT.length, e.bodyT.length],
				title: e.titleT,
				tags: e.tagT,
				description: e.descT,
				body: e.bodyT,
				titleDesc: e.titleDescT,
				record: e.record,
			})),
			postings: [...postings],
			stems: this.stems.map((s): [string, string[]] => [s, this.stemTerms.get(s) ?? []]),
		};
		const dir = path.join(this.root, INDEX_DIR);
		try {
			fs.mkdirSync(dir, { recursive: true });
			const ignore = path.join(dir, ".gitignore");
			if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n", "utf-8");
			writeFileAtomic(path.join(dir, INDEX_FILE), JSON.stringify(data));
			this.unsaved = false;
			this.indexStat = fileStat(path.join(dir, INDEX_FILE));
		} catch (err) {
			this.unsaved = true;
			logWarn(`역색인 저장 실패(다음 sync 에 재시도): ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** posting 과 어간 사전을 항목에서 다시 만든다 — 항목이 바뀐 뒤 첫 조회·저장 때 한 번 */
	private ensurePostings(): Map<string, number[]> {
		if (this.postings) return this.postings;
		const postings = new Map<string, number[]>();
		this.docs.forEach((e, doc) => {
			[e.titleT, e.tagT, e.descT, e.bodyT].forEach((tokens, field) => {
				const tf = new Map<string, number>();
				for (const u of tokens) tf.set(u, (tf.get(u) ?? 0) + 1);
				for (const [u, n] of tf) {
					const list = postings.get(u);
					if (list) list.push(doc, field, n);
					else postings.set(u, [doc, field, n]);
				}
			});
		});
		const stemTerms = new Map<string, string[]>();
		for (const u of postings.keys()) {
			const s = stripParticle(u);
			const terms = stemTerms.get(s);
			if (terms) terms.push(u);
			else stemTerms.set(s, [u]);
		}
		this.postings = postings;
		this.stemTerms = stemTerms;
		this.stems = [...stemTerms.keys()].sort();
		return postings;
	}

	/**
	 * tokenMatch(t, u) 가 참인 표층 토큰 u 전부.
	 * 어간이 t 의 어간과 같은 것, t 의 어간으로 시작하고 2자 이내로 긴 어간(정렬 목록 이분 탐색),
	 * t 의 어간이 그것으로 시작하고 2자 이내로 짧은 3자 이상 어간(접두 직접 조회)을 모은 뒤 tokenMatch 로 다시 거른다.
	 */
	private termsMatching(t: string): string[] {
		const nt = stripParticle(t);
		const found = new Set<string>();
		const addStem = (s: string) => {
			for (const u of this.stemTerms.get(s) ?? []) found.add(u);
		};
		addStem(nt);
		if (nt.length >= 3) {
			let lo = 0;
			let hi = this.stems.length;
			while (lo < hi) {
				const mid = (lo + hi) >>> 1;
				if (this.stems[mid] < nt) lo = mid + 1;
				else hi = mid;
			}
			for (let i = lo; i < this.stems.length && this.stems[i].startsWith(nt); i++) {
				if (this.stems[i].length - nt.length <= 2) addStem(this.stems[i]);
			}
			for (let len = Math.max(3, nt.length - 2); len < nt.length; len++) addStem(nt.slice(0, len));
		}
		return [...found].filter((u) => tokenMatch(t, u));
	}

	/** 필드 문자열이 같으면 이전 토큰을 재사용하고 레코드·파일 신원만 새것으로 바꾼 항목을 만든다 */
	private entryFor(rec: MemoryRecord, archived: boolean, prev: Entry | undefined, stat: FileStat | null): Entry {
		const key = entryKey(rec.slug, archived);
		const tags = rec.tags.join(" ");
		if (
			prev &&
			prev.record.title === rec.title &&
			prev.record.description === rec.description &&
			prev.record.body === rec.body &&
			prev.record.tags.join(" ") === tags
		) {
			return { ...prev, key, stat, record: rec };
		}
		return {
			key,
			stat,
			record: rec,
			titleT: tokenize(rec.title),
			tagT: tokenize(tags),
			descT: tokenize(rec.description),
			bodyT: tokenize(stripLinkSection(rec.body)), // 링크 메타데이터 제외 (D6)
			titleDescT: tokenize(rec.title + " " + rec.description),
		};
	}

	/**
	 * 볼트를 listSlugs(true) 순서로 맞춘다. 파일마다 stat 을 먼저 떠 기록된 파일 신원과 같으면 항목을 그대로 쓰고,
	 * 다르면 vault.read 로 다시 읽는다(T38 읽기 캐시와 같은 키·순서). 바뀐 것이 있으면 인덱스 파일을 통째로 교체한다.
	 * 기억 파일이 그대로여도 인덱스 파일이 마지막 적재·저장 때와 다르면(지워짐·다른 프로세스가 덮어씀) 교체한다.
	 */
	sync(vault: Storage): void {
		if (path.resolve(vault.root) !== this.root) this.load(vault);
		const next: Entry[] = [];
		let changed = false;
		let reindex = false;
		for (const { slug, archived } of vault.listSlugs(true)) {
			const at = this.keyIndex.get(entryKey(slug, archived));
			const prev = at === undefined ? undefined : this.docs[at];
			// 읽기 전에 뜬다 — 뒤에 뜨면 "옛 내용 + 새 신원" 이 기록돼 다음 변경까지 낡은 항목이 남는다
			const st = fileStat(vault.filePath(slug, archived));
			let e = prev;
			if (!prev || !sameStat(prev.stat, st)) {
				const rec = vault.read(slug, archived);
				if (!rec) continue;
				e = this.entryFor(rec, archived, prev, st);
				changed = true;
				if (!prev || e.titleT !== prev.titleT) reindex = true;
			}
			if (at !== next.length) {
				changed = true;
				reindex = true;
			}
			next.push(e as Entry);
		}
		if (next.length !== this.docs.length) {
			changed = true;
			reindex = true;
		}
		this.docs = next;
		this.keyIndex = new Map(next.map((e, i) => [e.key, i]));
		if (reindex) this.postings = null;
		const replaced = !!this.indexStat && !sameStat(this.indexStat, fileStat(path.join(vault.root, INDEX_DIR, INDEX_FILE)));
		if (changed || this.unsaved || replaced) this.persist(vault);
	}

	/** 항목을 추가하거나 교체한다 — 새 항목은 순서의 끝에 붙고, 디스크와의 대조·저장은 다음 sync 가 한다 */
	upsert(rec: MemoryRecord, archived = false): void {
		const key = entryKey(rec.slug, archived);
		const at = this.keyIndex.get(key);
		const prev = at === undefined ? undefined : this.docs[at];
		const e = this.entryFor(cloneRecord(rec), archived, prev, null);
		if (at === undefined) {
			this.keyIndex.set(key, this.docs.length);
			this.docs.push(e);
			this.postings = null;
		} else {
			this.docs[at] = e;
			if (e.titleT !== prev?.titleT) this.postings = null;
		}
	}

	/** slug 의 항목을 memories·archive 양쪽에서 지운다 */
	remove(slug: string): void {
		const gone = new Set([entryKey(slug, false), entryKey(slug, true)]);
		const kept = this.docs.filter((e) => !gone.has(e.key));
		if (kept.length === this.docs.length) return;
		this.docs = kept;
		this.keyIndex = new Map(kept.map((e, i) => [e.key, i]));
		this.postings = null;
	}

	/** 항목 키와 레코드를 항목 순서대로 — 레코드는 공유 참조라 변이하면 안 된다 */
	entries(): { key: string; record: MemoryRecord }[] {
		return this.docs.map((e) => ({ key: e.key, record: e.record }));
	}

	/** 항목 키의 점수 0 후보 — 레코드는 복제하고 제목+설명 토큰은 search 결과와 같은 배열을 쓴다. 없거나 범위 밖이면 null */
	candidate(key: string, filter: ScopeFilter): Candidate | null {
		const at = this.keyIndex.get(key);
		if (at === undefined) return null;
		const e = this.docs[at];
		const m = e.record;
		if ((filter.type && m.type !== filter.type) || !inScope(m, filter.project)) return null;
		return { slug: m.slug, score: 0, fields: [], record: cloneRecord(m), titleDescTokens: e.titleDescT };
	}

	/**
	 * BM25F 통계를 색인 전체(보관·다른 프로젝트 포함, 범위 필터 전)에서 계산한다.
	 * 문서 빈도는 퍼지로 맞은 표층 토큰이 네 필드 가운데 하나라도 있는 문서 수, IDF 는 log(1+(N-df+0.5)/(df+0.5)) 다.
	 */
	private bm25fStats(q: ParsedQuery, hits: Map<number, number[]>): Bm25fStats {
		const n = this.docs.length;
		const sum = [0, 0, 0, 0];
		for (const e of this.docs) {
			sum[0] += e.titleT.length;
			sum[1] += e.tagT.length;
			sum[2] += e.descT.length;
			sum[3] += e.bodyT.length;
		}
		const avg = sum.map((s) => (n > 0 && s > 0 ? s / n : 1));
		const idf = q.expanded.map((_, ti) => {
			let df = 0;
			for (const h of hits.values()) if (h[ti * 4] > 0 || h[ti * 4 + 1] > 0 || h[ti * 4 + 2] > 0 || h[ti * 4 + 3] > 0) df++;
			return Math.log(1 + (n - df + 0.5) / (df + 0.5));
		});
		return { idf, avg };
	}

	/**
	 * 키워드 점수가 0 보다 큰 후보를 항목 순서대로 돌려준다. 점수는 scorer 로 고른다(기본 legacy).
	 * 후보가 k 를 넘으면 점수 상위 k 건(동점은 앞선 항목)만 남기되 순서는 유지한다.
	 * 레코드는 복제해 내보낸다 — 호출부(강화)가 변이해도 항목이 바뀌지 않게 한다.
	 */
	search(q: ParsedQuery, k: number, filter: ScopeFilter, scorer: Scorer = "legacy"): Candidate[] {
		// 필드를 **사전 토큰화**해 비교한다(감사 D4). 종전에는 includes/indexOf 라
		// 토큰 경계가 없어 'cat' 질의가 Concatenation·concat·category 를 포함한
		// 무관한 기억을 고득점(7.68/3.84)으로 끌어왔고, 반환된 결과는 능동 인출로
		// 강화까지 받아 오탐이 시간이 갈수록 더 잘 회상되는 방향으로 드리프트했다.
		// 조사 흡수는 tokenMatch 가 담당하므로 한국어 회수율 손실은 없다.
		const postings = this.ensurePostings();
		const width = q.expanded.length * 4;
		// 문서 위치 → [질의 토큰 × 필드] 적중 수 (본문은 일치 토큰 등장 횟수)
		const hits = new Map<number, number[]>();
		q.expanded.forEach((t, ti) => {
			for (const u of this.termsMatching(t)) {
				const list = postings.get(u);
				if (!list) continue;
				for (let i = 0; i < list.length; i += 3) {
					let h = hits.get(list[i]);
					if (!h) hits.set(list[i], (h = new Array<number>(width).fill(0)));
					h[ti * 4 + list[i + 1]] += list[i + 2];
				}
			}
		});
		const bm = scorer === "bm25f" ? this.bm25fStats(q, hits) : null;
		const out: Candidate[] = [];
		for (const doc of [...hits.keys()].sort((a, b) => a - b)) {
			const e = this.docs[doc];
			const m = e.record;
			if ((filter.type && m.type !== filter.type) || !inScope(m, filter.project)) continue;
			const h = hits.get(doc) as number[];
			let keyword = 0;
			const fields: FieldHit[] = [];
			if (bm) keyword = bm25fScore(q, h, e, bm, fields);
			else
				q.expanded.forEach((t, ti) => {
					const w = q.exact.has(t) ? 1 : SYNONYM_WEIGHT;
					if (h[ti * 4] > 0) {
						keyword += 5 * w;
						fields.push({ field: "title", token: t, weight: 5 * w });
					}
					if (h[ti * 4 + 1] > 0) {
						keyword += 4 * w;
						fields.push({ field: "tags", token: t, weight: 4 * w });
					}
					if (h[ti * 4 + 2] > 0) {
						keyword += 3 * w;
						fields.push({ field: "description", token: t, weight: 3 * w });
					}
					const body = Math.min(3, h[ti * 4 + 3]);
					keyword += body * w;
					if (body > 0) fields.push({ field: "body", token: t, weight: body * w });
				});
			if (keyword === 0) continue;
			out.push({ slug: m.slug, score: keyword, fields, record: cloneRecord(m), titleDescTokens: e.titleDescT });
		}
		if (out.length <= k) return out;
		const keep = out
			.map((_, i) => i)
			.sort((a, b) => out[b].score - out[a].score || a - b)
			.slice(0, Math.max(0, k))
			.sort((a, b) => a - b);
		return keep.map((i) => out[i]);
	}
}
