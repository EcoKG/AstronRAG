import type { Vault } from "./vault.js";
import type { MemoryRecord, MemoryType } from "./types.js";

/** 이보다 토큰이 적은 집합은 유사도 판단 근거가 부족하다고 보고 비교하지 않는다 */
export const MIN_OVERLAP_TOKENS = 3;
/** 동의어로만 맞은 토큰의 가중 — 정확히 일치한 기억이 여전히 위로 오게 한다 (감사 D1) */
export const SYNONYM_WEIGHT = 0.6;

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
}

/** 후보와 관련도 점수만 내는 검색기 — 가중·억제·강화는 하지 않는다 */
export interface Retriever {
	readonly name: "lexical" | "vector";
	search(q: ParsedQuery, k: number, filter: ScopeFilter): Candidate[];
	upsert(rec: MemoryRecord, archived?: boolean): void;
	remove(slug: string): void;
	sync(vault: Vault): void;
}

/** 레코드 1건의 필드 원문과 사전 토큰화 결과 */
interface Entry {
	record: MemoryRecord;
	title: string;
	description: string;
	body: string;
	tags: string;
	titleT: string[];
	descT: string[];
	bodyT: string[];
	tagT: string[];
	titleDescT: string[];
}

/** 위치와 slug 로 만드는 항목 키 — memories 와 archive 의 같은 slug 를 구분한다 */
function entryKey(slug: string, archived: boolean): string {
	return `${archived ? "a" : "m"}:${slug}`;
}

/** 필드 가중 키워드 점수(제목 5·태그 4·설명 3·본문 최대 3, 동의어 0.6배)를 내는 인메모리 검색기 */
export class LexicalRetriever implements Retriever {
	readonly name = "lexical" as const;
	private entries = new Map<string, Entry>();

	/** 필드 문자열이 같으면 이전 토큰을 재사용하고 레코드만 새것으로 바꾼 항목을 만든다 */
	private entryFor(rec: MemoryRecord, archived: boolean): Entry {
		const tags = rec.tags.join(" ");
		const prev = this.entries.get(entryKey(rec.slug, archived));
		if (
			prev &&
			prev.title === rec.title &&
			prev.description === rec.description &&
			prev.body === rec.body &&
			prev.tags === tags
		) {
			return { ...prev, record: rec };
		}
		return {
			record: rec,
			title: rec.title,
			description: rec.description,
			body: rec.body,
			tags,
			titleT: tokenize(rec.title),
			descT: tokenize(rec.description),
			bodyT: tokenize(stripLinkSection(rec.body)), // 링크 메타데이터 제외 (D6)
			tagT: tokenize(tags),
			titleDescT: tokenize(rec.title + " " + rec.description),
		};
	}

	/** 볼트를 listSlugs(true) 순서로 다시 읽어 항목을 맞춘다 — 읽기는 볼트의 파일 캐시를 탄다 */
	sync(vault: Vault): void {
		const next = new Map<string, Entry>();
		for (const { slug, archived } of vault.listSlugs(true)) {
			const rec = vault.read(slug, archived);
			if (rec) next.set(entryKey(slug, archived), this.entryFor(rec, archived));
		}
		this.entries = next;
	}

	/** 항목을 추가하거나 교체한다 — 새 항목은 순서의 끝에 붙는다 */
	upsert(rec: MemoryRecord, archived = false): void {
		this.entries.set(entryKey(rec.slug, archived), this.entryFor(rec, archived));
	}

	/** slug 의 항목을 memories·archive 양쪽에서 지운다 */
	remove(slug: string): void {
		this.entries.delete(entryKey(slug, false));
		this.entries.delete(entryKey(slug, true));
	}

	/**
	 * 키워드 점수가 0 보다 큰 후보를 항목 순서대로 돌려준다.
	 * 후보가 k 를 넘으면 점수 상위 k 건(동점은 앞선 항목)만 남기되 순서는 유지한다.
	 */
	search(q: ParsedQuery, k: number, filter: ScopeFilter): Candidate[] {
		const out: Candidate[] = [];
		for (const e of this.entries.values()) {
			const m = e.record;
			if ((filter.type && m.type !== filter.type) || !inScope(m, filter.project)) continue;
			let keyword = 0;
			const fields: FieldHit[] = [];
			// 필드를 **사전 토큰화**해 비교한다(감사 D4). 종전에는 includes/indexOf 라
			// 토큰 경계가 없어 'cat' 질의가 Concatenation·concat·category 를 포함한
			// 무관한 기억을 고득점(7.68/3.84)으로 끌어왔고, 반환된 결과는 능동 인출로
			// 강화까지 받아 오탐이 시간이 갈수록 더 잘 회상되는 방향으로 드리프트했다.
			// 조사 흡수는 tokenMatch 가 담당하므로 한국어 회수율 손실은 없다.
			for (const t of q.expanded) {
				const w = q.exact.has(t) ? 1 : SYNONYM_WEIGHT;
				if (e.titleT.some((u) => tokenMatch(t, u))) {
					keyword += 5 * w;
					fields.push({ field: "title", token: t, weight: 5 * w });
				}
				if (e.tagT.some((u) => tokenMatch(t, u))) {
					keyword += 4 * w;
					fields.push({ field: "tags", token: t, weight: 4 * w });
				}
				if (e.descT.some((u) => tokenMatch(t, u))) {
					keyword += 3 * w;
					fields.push({ field: "description", token: t, weight: 3 * w });
				}
				let hits = 0;
				for (const u of e.bodyT) {
					if (hits >= 3) break;
					if (tokenMatch(t, u)) hits++;
				}
				keyword += hits * w;
				if (hits > 0) fields.push({ field: "body", token: t, weight: hits * w });
			}
			if (keyword === 0) continue;
			out.push({ slug: m.slug, score: keyword, fields, record: m, titleDescTokens: e.titleDescT });
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
