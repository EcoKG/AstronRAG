import type { Vault } from "./vault.js";
import type { MemoryRecord, SearchOutcome, SearchResult } from "./types.js";
import { type Candidate, type ParsedQuery, inScope, overlap, stripLinkSection } from "./retriever.js";

const HOUR_MS = 3_600_000;

// --- 리포트(docs/memory-model-report.md) 기반 파라미터 -------------------
/** ACT-R 기저활성 감쇠 파라미터 (거듭제곱 망각). 기본 0.5 = ACT-R 표준 */
export const DECAY_D = 0.5;
/**
 * 회상/reflect에서 "약해진 기억"으로 보는 기저활성 임계 τ (P6).
 *
 * 활성식을 최근 연습항 분리형으로 바꾸면서(감사 C1) 척도가 통째로 내려갔다:
 * 종전 근사식은 n=1 구간에서 상수항 `ln(1/(1−d))` = ln(2) ≈ 0.693 을 얹고 있었는데
 * 새 식에는 그 항이 없다. 그래서 임계도 **같은 폭만큼 내려야** 종전 판정이 보존된다.
 * (검산: n=1 기억이 τ 를 밑도는 시점이 종전과 동일하게 약 16.2시간)
 */
export const RETRIEVAL_THRESHOLD = -0.7 - Math.log(1 / (1 - 0.5)); // ≈ -1.393
/** 회상 순위 측면억제 overlap 임계 (감사 D3, 종전 0.5) */
export const RIF_THRESHOLD = 0.35;
// -----------------------------------------------------------------------

/**
 * ACT-R 기저활성 (거듭제곱 망각) — 리포트 P2, **최근 연습항 분리형**.
 *
 *   B = ln( (n−1)·L^−d / (1−d)  +  t_last^−d )
 *   n = 저장강도(빈도), L = 생성 후 경과[시], t_last = 마지막 강화 후 경과[시], d = 0.5
 *
 * 종전에는 순수 optimized-learning 근사식 `ln(n/(1−d)) − d·ln(L)` 을 썼는데,
 * 이 식은 **연습이 생애 전체에 균등 분포한다**는 전제 위에서만 성립한다.
 * 실사용은 불균등하게 강화되므로 전제가 깨지고, 그 결과 감쇠 시계가 사실상
 * "생성 시각"에만 묶여 최근성이 랭킹에 전혀 반영되지 않았다(감사 C1):
 * created 와 n 이 같으면 **어제 강화한 기억과 1년 방치한 기억의 활성이 완전히 동일**했고
 * (실측 둘 다 −2.2364), 어제 5회 쓴 핵심 기억이 몇 초 전 저장한 잡메모에 밀렸다
 * (5.75 vs 7.68). 도구 설명이 광고하던 "frequency+recency" 중 recency 는 허위였다.
 *
 * 이제 **마지막 1회를 정확항 t_last^−d 로 분리**하고 나머지 n−1 회만 근사한다
 * (Petrov 2006 하이브리드 근사의 k=1 형태). 정확식 B = ln(Σ t_j^−d) 의 방향·간격을
 * 잘 따라간다 — 위 시나리오에서 정확식 −1.40/−2.93 대비 이 식은 −1.24/−2.34 로
 * 순서와 격차를 모두 복원한다. 스키마 변경은 없다(lastReinforced 는 이미 저장 중).
 *
 * n=1 일 때는 tail 이 0 이라 B = −d·ln(t_last) 로, 정확식과 **완전히 일치**한다.
 * (종전 근사식은 이 구간에서 +ln(2)≈0.69 만큼 과대평가했다)
 */
export function baseLevelActivation(storageStrength: number, ageMs: number, sinceLastReinforceMs: number): number {
	const n = Math.max(1, storageStrength);
	const L = Math.max(ageMs, 60_000) / HOUR_MS; // 최소 1분 → 0 나눗셈/음수 폭주 방지
	// 마지막 강화는 생성보다 앞설 수 없다. 값이 깨졌으면 생성 시각으로 폴백.
	const raw = Number.isFinite(sinceLastReinforceMs) ? Math.min(sinceLastReinforceMs, ageMs) : ageMs;
	const tLast = Math.max(raw, 60_000) / HOUR_MS;
	const tail = ((n - 1) * L ** -DECAY_D) / (1 - DECAY_D);
	return Math.log(tail + tLast ** -DECAY_D);
}

/** 레코드로부터 기저활성을 계산 — 감쇠 시계 인자를 한 곳에서만 조립한다 */
export function activationOf(m: MemoryRecord, now: number = Date.now()): number {
	return baseLevelActivation(
		m.storageStrength,
		now - Date.parse(m.created),
		now - Date.parse(m.lastReinforced),
	);
}

/** 활성값을 (0,1) 인출강도로 압축 (로지스틱) */
export function retrievalStrength(activation: number): number {
	return 1 / (1 + Math.exp(-(activation - RETRIEVAL_THRESHOLD)));
}

/**
 * 스니펫 — **질의 토큰을 가장 많이 덮는 구간**을 고른다 (감사 D7).
 *
 * 종전에는 토큰 배열 순서대로 훑어 첫 매칭 토큰의 첫 등장 위치만 잘랐다.
 * 그래서 두 토큰이 모두 있는 결론 문장이 본문에 있어도 서두의 일반론이 나왔고,
 * 질의 어순만 바꿔도 결과가 달라졌다("타임아웃 30초" vs "30초 타임아웃").
 * 고정 폭 윈도를 후보 위치마다 대보고 서로 다른 토큰을 가장 많이 포함하는 곳을 쓴다.
 *
 * 링크 메타데이터(`## 연관 기억` 섹션과 [[위키링크]])는 검색·스니펫 대상에서
 * 제외한다 — link() 가 본문에 주입하는 것이라 콘텐츠가 아니다 (감사 D6).
 */
export function snippet(m: MemoryRecord, tokens: string[]): string {
	const body = stripLinkSection(m.body);
	if (!body) return m.description;
	const lower = body.toLowerCase();

	// 토큰별 등장 위치 수집
	const spots: { at: number; token: string }[] = [];
	for (const t of tokens) {
		let idx = -1;
		let seen = 0;
		while (seen < 5 && (idx = lower.indexOf(t, idx + 1)) !== -1) {
			spots.push({ at: idx, token: t });
			seen++;
		}
	}
	if (spots.length === 0) return m.description;

	// 각 등장 위치를 시작점 후보로 삼아 윈도가 덮는 고유 토큰 수를 센다
	// 동점일 때는 **앞선 위치**를 택한다 — 순회 순서(=질의 어순)로 승자가 갈리면
	// "타임아웃 30초" 와 "30초 타임아웃" 의 결과가 달라진다.
	const WIN = 150;
	let best = { start: 0, covered: -1 };
	for (const s of spots) {
		const start = Math.max(0, s.at - 60);
		const end = start + WIN;
		const covered = new Set(spots.filter((x) => x.at >= start && x.at < end).map((x) => x.token)).size;
		if (covered > best.covered || (covered === best.covered && start < best.start)) {
			best = { start, covered };
		}
	}
	const end = Math.min(body.length, best.start + WIN);
	return (
		(best.start > 0 ? "…" : "") +
		body.slice(best.start, end).replace(/\s+/g, " ").trim() +
		(end < body.length ? "…" : "")
	);
}

/** 키워드 점수에 진실성·기저활성·상태 가중을 곱해 검색 결과 1건을 만든다 */
export function finish(m: MemoryRecord, keyword: number, now: number, expanded: string[]): SearchResult {
	const activation = activationOf(m, now);
	let score = keyword;
	score *= 0.5 + 0.5 * m.confidence; // P1: 진실성 가중 (인출과 독립)
	score *= 0.55 + 0.9 * retrievalStrength(activation); // P2: 기저활성(빈도·최근성) 가중
	if (m.status !== "active") score *= 0.2; // 망각/대체된 기억은 희미하게
	return { record: m, score, activation, snippet: snippet(m, expanded) };
}

/** RIF 판정 단위 — 검색 결과와 그 제목+설명 토큰 */
export interface Scored {
	result: SearchResult;
	tokens: string[];
}

/**
 * 측면억제(RIF)를 적용해 최종 점수 상위 limit 건을 돌려준다. scored 는 점수 내림차순이어야 한다.
 *
 * 억제는 점수를 반으로 깎기만 하므로 아직 안 본 후보의 최종 점수는 지금 후보의 점수를 넘지 못한다.
 * 그래서 이미 본 후보의 limit 번째 최종 점수가 지금 후보의 점수 이상이면 멈춰도 결과가 전체 비교와 같다.
 */
export function inhibit(scored: Scored[], limit: number): SearchResult[] {
	// P5: 측면억제(RIF) — 상위 결과와 유사한 하위 경쟁 기억은 순위에서만 눌린다.
	// 저장된 진실성·저장강도는 절대 건드리지 않는다(오삭제 위험 차단).
	//
	// **공고화 3조 ③ — 파생물은 자기 근거를 누르지 않는다 (T35).**
	// 파생물은 정의상 근거 에피소드들과 토큰이 겹치므로 RIF 임계를 넘긴다. 그대로 두면
	// 요약이 원본을 순위에서 밀어내고, 모델이 보는 것이 verbatim 원본 대신 요지가 된다.
	// 저장 상태는 그대로라 P5 의 형식은 지키지만, **작동 계층에서 요지가 원본을 대체**하는
	// 것이라 P8 의 취지를 정면으로 어긴다. 그래서 그 쌍만 예외로 둔다.
	const suppresses = (winner: SearchResult, loser: SearchResult) =>
		!(winner.record.derivedFrom ?? []).includes(loser.record.slug) &&
		!(loser.record.derivedFrom ?? []).includes(winner.record.slug);

	// 반감이 점수를 낮춘다는 성질은 유한한 0 이상 점수에서만 성립한다 (created 가 깨지면 NaN)
	const stoppable = scored.every((s) => Number.isFinite(s.result.score) && s.result.score >= 0);
	const kept: Scored[] = [];
	const top: number[] = []; // 처리한 후보의 최종 점수 상위 limit 개, 내림차순
	for (const s of scored) {
		if (stoppable && top.length >= limit && top[limit - 1] >= s.result.score) break;
		const rivalOf = kept.find(
			(k) => suppresses(k.result, s.result) && overlap(k.tokens, s.tokens) >= RIF_THRESHOLD,
		);
		if (rivalOf) {
			s.result.score *= 0.5;
			s.result.inhibited = true;
			s.result.inhibitedBy = rivalOf.result.record.slug;
		}
		kept.push(s);
		if (stoppable) {
			let i = top.length;
			while (i > 0 && top[i - 1] < s.result.score) i--;
			top.splice(i, 0, s.result.score);
			if (top.length > limit) top.pop();
		}
	}
	const results = kept.map((k) => k.result);
	results.sort((a, b) => b.score - a.score);
	return results.slice(0, limit);
}

/** 순위화 옵션 — 컷오프, 기준 시각, 연상 확산 여부와 스코프, 연상 이웃을 찾을 볼트(없으면 연상 확산을 하지 않는다) */
export interface RankOptions {
	limit: number;
	now: number;
	includeLinked?: boolean;
	project?: string;
	vault?: Vault;
}

/** 후보를 가중·정렬하고 RIF 와 연상 확산을 적용해 회상 결과를 만든다 (강화는 하지 않는다) */
export function rank(cands: Candidate[], q: ParsedQuery, opts: RankOptions): SearchOutcome {
	const { limit, now } = opts;
	const scored: Scored[] = cands.map((c) => ({
		result: finish(c.record, c.score, now, q.expanded),
		tokens: c.titleDescTokens,
	}));
	scored.sort((a, b) => b.result.score - a.result.score);
	let results = inhibit(scored, limit);

	// 연상: 상위 결과의 링크 1-hop 이웃 (P: 확산활성 근사)
	const vault = opts.vault;
	if (opts.includeLinked !== false && vault) {
		const have = new Set(results.map((r) => r.record.slug));
		const assoc: SearchResult[] = [];
		for (const r of results.slice(0, 3)) {
			for (const linkSlug of r.record.links) {
				if (have.has(linkSlug)) continue;
				const found = vault.find(linkSlug);
				// 연상으로도 스코프 밖 기억이 새어 들어오면 안 된다
				if (found && found.record.status === "active" && inScope(found.record, opts.project)) {
					have.add(linkSlug);
					const act = activationOf(found.record, now);
					assoc.push({
						record: found.record,
						score: r.score * 0.3,
						activation: act,
						snippet: `(연상: [[${r.record.slug}]] 와 연결됨) ${found.record.description}`,
					});
				}
			}
		}
		// 연상 상한도 limit 에 비례시킨다 — 종전 고정 3건은 limit 을 올려도 그대로였다 (D5)
		results = results.concat(assoc.slice(0, Math.max(1, Math.ceil(limit / 2))));
	}
	return { results, totalMatched: scored.length };
}
