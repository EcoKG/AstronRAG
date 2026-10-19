import type { MemoryStore as Storage } from "./stores/memory-store.js";
import { logWarn } from "./log.js";
import { RETRIEVAL_THRESHOLD, activationOf, rank } from "./ranker.js";
import {
  LexicalRetriever,
  fuseWeightedMax,
  type Candidate,
  type ParsedQuery,
  type Retriever,
  type Scorer,
  type ScopeFilter,
  inScope,
  overlap,
  stripParticle,
  tokenize,
} from "./retriever.js";
import type {
  MemoryRecord,
  MemoryStatus,
  MemoryType,
  RememberInput,
  ReviseInput,
  SearchOutcome,
  SearchResult,
} from "./types.js";

const HOUR_MS = 3_600_000;
/** recall 한 번에 쓰는 변형 질의 수 상한 — 넘는 것은 버린다 */
export const MAX_ALT_QUERIES = 3;
/** 키워드 점수 방식 (BIGBRAIN_SCORER) — "bm25f" 일 때만 BM25F, 그 밖의 값은 legacy */
export const SCORER: Scorer = process.env.BIGBRAIN_SCORER === "bm25f" ? "bm25f" : "legacy";
/** 그림자 모드 — legacy 로 회상할 때 bm25f 도 계산해 상위 5건 일치율만 남긴다. BIGBRAIN_SHADOW=0 이면 끈다 */
const SHADOW = SCORER === "legacy" && process.env.BIGBRAIN_SHADOW !== "0";
/** 융합에서 변형 질의 원점수에 곱하는 가중 (원 질의는 1) — BIGBRAIN_ALT_WEIGHT 가 0 초과 1 이하 수면 그 값(평가용), 아니면 0.7 */
const ALT_QUERY_WEIGHT = ((): number => {
  const v = Number(process.env.BIGBRAIN_ALT_WEIGHT);
  return process.env.BIGBRAIN_ALT_WEIGHT?.trim() && Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.7;
})();

// --- 리포트(docs/memory-model-report.md) 기반 파라미터 -------------------
// 기저활성 감쇠 DECAY_D·약해진 기억 임계 RETRIEVAL_THRESHOLD·RIF 임계는 ranker.ts 에 있다.
/** 간격 게이트 — 직전 강화 후 이 시간이 지나야 저장강도 증가 (P3, 간격효과). 환경변수로 조정 */
const SPACING_WINDOW_MS = (() => {
  const v = Number(process.env.BIGBRAIN_SPACING_MS);
  return Number.isFinite(v) && v >= 0 ? v : 10 * 60_000; // 기본 10분
})();
/**
 * 인출강도가 이 값 미만이면 "어렵게 찾은" 회상 → 바람직한 어려움 보너스 (P4).
 * τ 와 같은 이유로 ln(2) 만큼 함께 내렸다(ranker.ts 의 RETRIEVAL_THRESHOLD 주석 참조).
 * C1 수정 덕에 이제 **마지막 강화가 최근이면 활성이 높아 보너스가 자동으로 빠진다** —
 * 종전에는 감쇠 시계가 created 고정이라 매일 쓰는 기억도 "어렵게 찾은" 것으로 쳤다.
 */
const HARD_RETRIEVAL_ACTIVATION = 0.5 - Math.log(1 / (1 - 0.5)); // ≈ -0.193
/**
 * 간격 게이트에 막힌 접근도 매번 디스크에 기록할지 (기본 false).
 * accessCount/lastAccessed 는 활성 계산에 쓰이지 않는 표시용 필드라, 조회마다 쓰면
 * git working tree·Obsidian 동기화·백업이 "읽기만 했는데" 변경을 감지한다(감사 B).
 * 접근수 통계를 정확히 원하면 BIGBRAIN_FLUSH_EVERY_ACCESS=1 로 켠다.
 */
const FLUSH_EVERY_ACCESS = /^(1|true|yes)$/i.test(process.env.BIGBRAIN_FLUSH_EVERY_ACCESS ?? "");
/**
 * overlap 임계 3종 (감사 D3, 회상 RIF 임계는 ranker.ts). 분모를 min → 자카드로 바꾸면서 함께 재보정했다.
 * 같은 크기 집합 기준 환산: min 0.45→0.29, 0.5→0.33, 0.75→0.60.
 */
const SIMILAR_THRESHOLD = 0.3; // remember 의 유사 기억 보고 (종전 0.45)
const DUPLICATE_THRESHOLD = 0.6; // reflect 의 중복 후보 (종전 0.75)
/**
 * 확장 간격 계수 (P3, 감사 C3). 필요 간격이 `α · 나이 / n` 으로 늘어난다.
 * 0 이면 종전의 고정 창 동작. 기본 0.1 = 나이의 10% 를 n 으로 나눈 만큼.
 */
const SPACING_ALPHA = (() => {
  const v = Number(process.env.BIGBRAIN_SPACING_ALPHA);
  return Number.isFinite(v) && v >= 0 ? v : 0.1;
})();
/** reflect 의 weakened 유예기간 — 이보다 어린 기억은 "약해졌다" 고 보지 않는다 (P6, 감사 C2) */
const WEAKENED_GRACE_MS = (() => {
  const v = Number(process.env.BIGBRAIN_WEAKENED_GRACE_H);
  return (Number.isFinite(v) && v >= 0 ? v : 72) * HOUR_MS; // 기본 72시간
})();
/** weakened 로 제시할 상한 비율 — 활성 하위 이만큼만 (0 이면 기능 끄기) */
const WEAKENED_RATIO = (() => {
  const v = Number(process.env.BIGBRAIN_WEAKENED_RATIO);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.2; // 기본 하위 20%
})();
// -----------------------------------------------------------------------

/**
 * 사람이 읽는 이력용 **로컬** 날짜 (감사 F2).
 * 종전에는 UTC ISO 를 잘라 써서 KST 사용자는 자정~오전 9시에 history 날짜가
 * 하루 어긋났다("어제/오늘" 회고와 시간 정렬 인지에 혼선).
 * 저장되는 타임스탬프(created/updated 등)는 UTC ISO 그대로 유지한다 —
 * 활성·감쇠 계산은 그 값을 쓰므로 건드리면 안 된다.
 */
function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 이력 최대 보관 줄 수 — 초과분은 가장 오래된 것부터 접는다 (감사 F4) */
const HISTORY_CAP = 50;

/**
 * 본문에서 위키링크 대상을 뽑는다 — **코드는 제외한다.**
 *
 * 종전에는 본문 전체에 정규식을 걸어, 코드 블록이나 백틱 안에 **예시로 적은** 표기를
 * 실제 링크로 인식했다. 실사용에서 즉시 터졌다: 링크 표기법을 설명하는 메모리를 저장하자
 * 그 설명문 자체가 깨진 링크로 보고됐고, 문서 성격의 기억은 상시 broken 으로 잡혔다.
 *
 * 오탐은 침묵보다 나쁘다 — 매번 "깨졌다" 고 하는 검증기는 곧 무시당하고, 그러면 진짜
 * 깨진 링크도 함께 묻힌다. 코드 펜스와 인라인 코드 스팬을 먼저 지우고 찾는다.
 */
export function bodyWikilinks(body: string): string[] {
  const prose = body
    .replace(/```[\s\S]*?```/g, " ") // 펜스 코드 블록
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]*`/g, " "); // 인라인 코드 스팬
  const out: string[] = [];
  for (const mt of prose.matchAll(/\[\[([^\]|#]+)/g)) {
    const t = mt[1].trim().replace(/^memories\//, "");
    if (t !== "") out.push(t);
  }
  return out;
}


/** 한쪽에만 있으면 모순 신호로 보는 부정 표현(한국어·영어) */
const NEGATION_RE = /않|금지|하지\s?마|(?:^|\s)안\s|안\s?함|말\s?것|\b(?:never|not|don't|do not|doesn't|does not|isn't|won't|cannot|can't|no longer)\b/i;

/** 두 기억 텍스트가 숫자·버전 또는 부정 여부에서 갈리는 이유 목록을 돌려준다 */
export function contradictionReasons(a: string, b: string): string[] {
  const reasons: string[] = [];
  // 날짜(YYYY-MM-DD)는 기록 시점이라 비교에서 뺀다
  const nums = (s: string) => new Set(s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ").match(/\d+(?:\.\d+)*/g) ?? []);
  const na = nums(a);
  const nb = nums(b);
  if ([...na].some((n) => !nb.has(n)) && [...nb].some((n) => !na.has(n))) reasons.push("number");
  if (NEGATION_RE.test(a) !== NEGATION_RE.test(b)) reasons.push("negation");
  return reasons;
}

/** `BIGBRAIN_STALE_DAYS` 가 유효하게 설정되면 전 타입에 쓰는 단일 낡음 임계(일), 아니면 null */
const STALE_OVERRIDE = (() => {
  const raw = process.env.BIGBRAIN_STALE_DAYS;
  if (raw === undefined) return null;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : null;
})();

/** 타입별 기본 낡음 임계(일) */
const STALE_DAYS_BY_TYPE: Record<MemoryType, number> = {
  episodic: 14,
  semantic: 60,
  procedural: 60,
  preference: 180,
};

/** 검토일(review_after)이 오늘보다 앞선 날짜인지 판정한다 */
export function reviewOverdue(m: MemoryRecord): boolean {
  return !!m.reviewAfter && today() > m.reviewAfter;
}

/** 기억이 낡았는지 판정한다 — 도구 응답과 SessionStart 인덱스가 같은 기준을 쓴다 */
export function isStale(m: MemoryRecord, ageDays: number): boolean {
  if (reviewOverdue(m)) return true;
  return ageDays >= (STALE_OVERRIDE ?? STALE_DAYS_BY_TYPE[m.type]);
}

/**
 * 이력 한 줄 추가 + 상한 유지.
 * 종전에는 상한이 없어 revise/forget/supersede 마다 약 65B 씩 무한 누적됐고
 * (재확인 110회 → 935B에서 7,426B), frontmatter 전체가 매 read 마다 재파싱된다.
 * 오래된 줄은 버리되 **몇 줄을 접었는지는 남겨** 이력이 잘렸다는 사실이 보이게 한다.
 */
function pushHistory(m: MemoryRecord, line: string): void {
  m.history.push(line);
  if (m.history.length <= HISTORY_CAP) return;
  const dropped = m.history.length - HISTORY_CAP;
  const prevFolded = /^\.\.\. 이전 이력 (\d+)줄 생략$/.exec(m.history[0] ?? "");
  const total = (prevFolded ? Number(prevFolded[1]) : 0) + dropped;
  m.history = [`... 이전 이력 ${total}줄 생략`, ...m.history.slice(dropped + (prevFolded ? 1 : 0))];
}

function newId(): string {
  return `mem-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 한↔영 도메인 용어 사전 (감사 D1).
 *
 * 검색이 표층 부분문자열 매칭이라 "배포" 로 저장한 기억을 `deploy` 로 찾으면 0건이었다.
 * 0건이면 에이전트는 "기억이 없다" 고 결론 내리고 같은 사실을 재학습·중복 저장한다 —
 * RECALL FIRST 수칙의 실효를 깎는 최전선 결함이었다. 임베딩 없이도 가장 흔한
 * 한↔영 혼용만은 메우도록 질의 토큰을 확장한다.
 *
 * 양방향으로 전개되며, 사용자 사전은 BIGBRAIN_SYNONYMS 로 덧붙일 수 있다
 * (형식: "배포=deploy,릴리스;설정=config" — 그룹은 `;`, 항목은 `,`, 좌변은 대표어).
 */
const BUILTIN_SYNONYMS: string[][] = [
  ["배포", "deploy", "deployment", "디플로이", "release", "릴리스", "릴리즈", "출시"],
  ["설정", "config", "configuration", "설정값", "환경설정"],
  ["서버", "server"],
  ["빌드", "build", "컴파일", "compile"],
  ["테스트", "test", "testing", "검증"],
  ["오류", "에러", "error", "실패", "failure", "fail"],
  ["버그", "bug", "결함", "defect"],
  ["인증", "auth", "authentication", "로그인", "login"],
  ["권한", "authorization", "permission", "퍼미션"],
  ["데이터베이스", "db", "database", "디비"],
  ["메모리", "memory", "기억"],
  ["경로", "path", "패스", "디렉터리", "directory", "폴더", "folder"],
  ["파일", "file"],
  ["보안", "security", "시큐리티"],
  ["성능", "performance", "perf", "속도", "speed"],
  ["캐시", "cache", "캐싱", "caching"],
  ["로그", "log", "logging", "로깅"],
  ["의존성", "dependency", "dependencies", "패키지", "package"],
  ["마이그레이션", "migration", "migrate", "이관"],
  ["스키마", "schema"],
  ["포트", "port"],
  ["인스톨러", "installer", "설치", "install", "setup"],
  ["사용자", "user", "유저", "계정", "account"],
  ["문서", "docs", "documentation", "문서화"],
];

/** 토큰 → 동의어 집합. 소문자 키. */
const SYNONYM_INDEX: Map<string, string[]> = (() => {
  const groups = BUILTIN_SYNONYMS.map((g) => [...g]);
  // 사용자 사전 병합
  for (const raw of (process.env.BIGBRAIN_SYNONYMS ?? "").split(";")) {
    const [head, rest] = raw.split("=");
    if (!head || !rest) continue;
    const words = [head, ...rest.split(",")].map((w) => w.trim().toLowerCase()).filter(Boolean);
    if (words.length >= 2) groups.push(words);
  }
  const idx = new Map<string, string[]>();
  for (const g of groups) {
    for (const w of g) {
      const key = w.toLowerCase();
      idx.set(key, [...new Set([...(idx.get(key) ?? []), ...g.map((x) => x.toLowerCase())])]);
    }
  }
  return idx;
})();

/**
 * 질의 토큰을 동의어까지 확장한다 (원 토큰은 항상 포함).
 *
 * 조사가 붙은 토큰은 **어간으로도 한 번 더 조회한다**. 종전에는 원형만 사전에
 * 넣어봐서 "배포 방법" 은 `deploy` 로만 적힌 기억을 찾아내지만 "배포를 하려면" 은
 * 0건이었다 — 조사 흡수는 tokenMatch 가 하지만 그건 이미 만들어진 토큰끼리의
 * 비교일 뿐이고, 사전 조회 단계에서 어간을 보지 않으면 동의어가 생성 자체를
 * 안 한다. 한국어 질의는 조사가 붙는 쪽이 오히려 자연스러우므로 손실이 컸다.
 */
function expandTokens(tokens: string[]): string[] {
  const out = new Set(tokens);
  for (const t of tokens) {
    for (const syn of SYNONYM_INDEX.get(t) ?? []) out.add(syn);
    const stem = stripParticle(t);
    if (stem === t) continue;
    // 어간 자체는 넣지 않는다 — tokenMatch 가 이미 조사를 흡수하므로 회수 이득이
    // 없고, 원형과 어간이 같은 기억에 이중 가산돼 점수만 부푼다.
    for (const syn of SYNONYM_INDEX.get(stem) ?? []) if (syn !== stem) out.add(syn);
  }
  return [...out];
}

/** 질의를 토큰화하고 동의어까지 확장한다 — 원 토큰은 만점, 동의어는 낮은 가중을 받는다(감사 D1) */
export function parseQuery(query: string): ParsedQuery {
  const tokens = tokenize(query);
  return { tokens, expanded: expandTokens(tokens), exact: new Set(tokens) };
}

/** 여러 질의의 해석을 합친다 — 원 질의 토큰을 앞에 두고 순서를 지키며, 스니펫 강조에만 쓴다 */
function mergeQueries(queries: ParsedQuery[]): ParsedQuery {
  const tokens = [...new Set(queries.flatMap((pq) => pq.tokens))];
  return { tokens, expanded: [...new Set(queries.flatMap((pq) => pq.expanded))], exact: new Set(tokens) };
}

/**
 * 훅용 읽기 전용 회상 — 볼트의 영속 역색인(.bbm-index/)만 읽어 검색한다.
 * 인덱스를 만들거나 고치지 않고, 기억 파일을 읽지 않으며, 강화·연상 확산도 하지 않는다. 인덱스가 없거나 손상·버전 불일치면 빈 결과다.
 * 반환할 결과와 그 억제자만 stat 해, 서버가 마지막으로 sync 한 뒤 바뀌거나 사라진 기억은 후보에서 빼고 다시 순위화한다.
 * 세 바퀴 뒤에도 낡은 결과가 나오면 남은 후보를 모두 stat 해 한 번 더 순위화한다. 볼트 복사·일괄 편집으로 대부분이 낡아도 순위화는 네 번 이하다.
 * 그래서 limit 은 지금 파일과 맞는 후보로 채워지고, totalMatched 에서는 대조로 드러난 낡은 후보만 빠진다. 그 뒤 새로 생긴 기억은 보이지 않는다.
 */
export function searchPersistedIndex(
  vaultRoot: string,
  query: string,
  opts?: { type?: MemoryType; limit?: number; project?: string; currentFilePath?: string },
): SearchOutcome {
  const q = parseQuery(query);
  if (q.tokens.length === 0) return { results: [], totalMatched: 0 };
  const retriever = LexicalRetriever.openReadOnly(vaultRoot);
  if (!retriever) return { results: [], totalMatched: 0 };
  let candidates = retriever.search(q, Infinity, { type: opts?.type, project: opts?.project }, SCORER);
  const rankOpts = { limit: opts?.limit ?? 5, now: Date.now(), includeLinked: false, project: opts?.project };
  const current = new Map<string, boolean>();
  const isCurrent = (slug: string): boolean => {
    let ok = current.get(slug);
    if (ok === undefined) current.set(slug, (ok = retriever.isCurrent(slug, opts?.currentFilePath)));
    return ok;
  };
  const partialRounds = 3;
  for (let round = 1; ; round++) {
    const ranked = rank(candidates, q, rankOpts);
    const checked = ranked.results.flatMap((r) => (r.inhibitedBy ? [r.record.slug, r.inhibitedBy] : [r.record.slug]));
    const stale = new Set(checked.filter((slug) => !isCurrent(slug)));
    if (stale.size === 0) return ranked;
    if (round === partialRounds) return rank(candidates.filter((c) => isCurrent(c.slug)), q, rankOpts);
    candidates = candidates.filter((c) => !stale.has(c.slug));
  }
}

/**
 * 다음 강화까지 필요한 간격 — **확장 간격**(expanding spacing, 감사 C3).
 *
 * 종전에는 고정 10분 창이라 "10분짜리 벼락치기" 가 그대로 통과했다:
 * 11분 주기로 기계적으로 recall 하면 회당 +1 씩 상한 없이 부풀릴 수 있었고
 * (실측 30회 → 저장강도 1→31), 저장강도는 감소 경로가 없어 그 값이 영구히 남는다.
 * 하루 144회면 n=145 가 되어 그 기억은 reflect 의 weakened 에서 수십 년간 면제된다.
 * 간격효과 이론이 요구하는 것은 **간격의 확대**이지 고정 rate limit 이 아니다.
 *
 * 필요 간격 = max(기본창, α · 기억의 나이 / n).
 * 이미 n 번 강화된 기억은 그만큼 더 긴 간격을 요구하므로, 반복 질의로 강도를
 * 무한히 끌어올릴 수 없다. ACT-R 의 합리적 분석(연습 간격이 기억의 생애에 비례해
 * 벌어진다)과도 정합적이다.
 */
function requiredSpacing(m: MemoryRecord, now: number): number {
  const ageMs = Math.max(0, now - Date.parse(m.created));
  const n = Math.max(1, m.storageStrength);
  const expanding = (SPACING_ALPHA * ageMs) / n;
  return Math.max(SPACING_WINDOW_MS, expanding);
}

/**
 * 인간형 기억 저장소 — 리포트(docs/memory-model-report.md) 원칙 P1~P8 반영.
 * - P1: 진실성 / 저장강도 / (계산되는)인출강도 3축 분리
 * - P2: 거듭제곱 기저활성으로 회상 순위
 * - P3: 간격 게이트 강화
 * - P4: 능동>수동 + 바람직한 어려움
 * - P5: 측면억제(RIF)는 순위에만
 * - P6: 적응적 망각 제안(자동삭제 금지)
 * - P7: 재공고화의 안전한 절반(revise)
 * - P8: verbatim 저장 + 출처 필드
 */
export class MemoryService {
  /** retriever 를 넘기면 여러 진입점이 같은 검색기(후보·관련도 단계)를 공유한다 */
  constructor(
    private vault: Storage,
    readonly retriever: Retriever = new LexicalRetriever(),
    private readonly clock: () => number = Date.now,
  ) {}

  private nowMs(): number {
    return this.clock();
  }

  private nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  private today(): string {
    const date = new Date(this.nowMs());
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  /** 마지막 searchDetailed 의 그림자 비교값 — legacy·bm25f 상위 5건 slug 일치율(0~1). 그림자를 끄거나 후보가 없으면 undefined */
  shadowTop5: number | undefined = undefined;

  loadAll(includeArchived = false): MemoryRecord[] {
    const out: MemoryRecord[] = [];
    for (const { slug, archived } of this.vault.listSlugs(includeArchived)) {
      const rec = this.vault.read(slug, archived);
      if (rec) out.push(rec);
    }
    return out;
  }

  /**
   * id → slug 캐시 (감사 F1).
   *
   * slug 로 못 찾으면 id 를 찾으려고 볼트 전체를 읽어 파싱했다.
   * 1000건 볼트에서 resolve(id) 418ms, **존재하지 않는 id 는 항상 풀스캔** 384ms.
   * revise/forget/link/read_memory 가 id 를 받을 때마다 이 비용을 치렀다.
   * 한 번 스캔한 결과를 기억해 두고, 미스일 때만 다시 훑는다.
   */
  private idIndex: Map<string, string> | null = null;
  /**
   * 인덱스를 만든 시점의 볼트 시그니처 — 볼트가 변했는지 싸게 판정한다.
   *
   * 종전에는 **파일 수만** 비교했는데, 삭제 1건 + 추가 1건이 겹치면 수가 그대로라
   * 캐시를 신뢰했고, 새로 추가된 기억의 id 조회가 null 로 오답했다(풀스캔 생략 분기).
   * 시그니처는 listSlugs 가 이미 치른 readdir 결과의 (위치, slug) 정렬 결합이므로
   * 추가 비용 없이 추가·삭제·이동·개명을 전부 잡는다.
   * 남는 구멍은 "같은 파일명 안에서 id 필드만 손편집" 뿐인데, 그 경우도 히트 쪽은
   * verify 가 재읽기로 걸러낸다 — 놓치는 것은 새 id 의 부정 조회가 한 번 늦는 것뿐이다.
   */
  private idIndexSig: string | null = null;

  /** readdir 결과만으로 만드는 볼트 변화 시그니처 — 파싱 없음, 파일 수 비교와 같은 비용 */
  private vaultSignature(slugs: { slug: string; archived: boolean }[]): string {
    return slugs
      .map(({ slug, archived }) => `${archived ? "a" : "m"}:${slug}`)
      .sort()
      .join("\n");
  }

  private buildIdIndex(): Map<string, string> {
    const slugs = this.vault.listSlugs(true);
    const idx = new Map<string, string>();
    for (const { slug, archived } of slugs) {
      const rec = this.vault.read(slug, archived);
      if (rec) idx.set(rec.id, slug);
    }
    this.idIndex = idx;
    this.idIndexSig = this.vaultSignature(slugs);
    return idx;
  }

  /**
   * id 또는 slug 로 조회.
   *
   * 없는 id 도 정확히 없다고 답해야 하므로, 캐시 미스가 "정말 없음" 인지
   * "다른 프로세스가 그 사이 추가함" 인지 구분해야 한다. 전량 재파싱 대신
   * readdir 시그니처(위치+slug)로 볼트 변화를 감지한다 — 그대로면 캐시를 믿고,
   * 달라졌으면 다시 만든다. 수만 비교하던 종전 방식은 삭제+추가가 겹치면 못 봤다.
   */
  resolve(idOrSlug: string): { record: MemoryRecord; archived: boolean } | null {
    const bySlug = this.vault.find(idOrSlug);
    if (bySlug) return bySlug;

    const verify = (slug: string | undefined) => {
      if (!slug) return null;
      const found = this.vault.find(slug);
      return found && found.record.id === idOrSlug ? found : null;
    };

    if (this.idIndex) {
      const hit = verify(this.idIndex.get(idOrSlug));
      if (hit) return hit;
      // 미스 — 볼트가 그대로면 정말 없는 것이다 (풀스캔 생략)
      if (this.vaultSignature(this.vault.listSlugs(true)) === this.idIndexSig) return null;
    }
    return verify(this.buildIdIndex().get(idOrSlug));
  }

  remember(input: RememberInput): {
    record: MemoryRecord;
    similar: MemoryRecord[];
    contradictions: { record: MemoryRecord; reasons: string[] }[];
    dangling: string[];
  } {
    const now = this.nowIso();
    // 슬러그를 제목과 분리한다. 종전에는 제목에서만 파생돼, 위키링크 대상을 안정적으로
    // 유지하려면 **제목 자체를 영문 케밥으로 강제**해야 했다(실사용에서 이관 시 한국어
    // 제목을 통째로 포기했다). 파일명 규칙과 사람이 읽는 이름은 별개의 요구다.
    const slug = this.vault.makeSlug(input.slug?.trim() || input.title);
    const record: MemoryRecord = {
      id: newId(),
      slug,
      title: input.title,
      description: input.description ?? input.content.split("\n")[0].slice(0, 120),
      type: input.type,
      tags: input.tags ?? [],
      confidence: Math.min(1, Math.max(0, input.confidence ?? 0.8)),
      storageStrength: 1, // 최초 부호화 = 저장강도 1 (Bjork: 이후 단조 증가)
      status: "active",
      created: now,
      updated: now,
      lastAccessed: now,
      lastReinforced: now,
      accessCount: 0,
      source: input.source,
      project: input.project,
      // 공고화 출처 — 볼트에 실제로 있는 것만 남긴다. 없는 슬러그를 근거로 적어두면
      // "출처가 있는 것처럼 보이는데 확인 불가" 라는 최악의 상태가 된다(P8).
      derivedFrom: (() => {
        const from = (input.derivedFrom ?? []).filter((s) => this.vault.find(s) !== null);
        return from.length > 0 ? from : undefined;
      })(),
      reviewAfter: input.reviewAfter || undefined,
      links: [],
      history: [`${this.today()}: created${input.source ? ` (source: ${input.source})` : ""}`],
      body: input.content.trim(),
    };

    // 유사 기억 탐지 — 중복 저장 대신 revise를 유도하기 위한 신호 (P8: 파괴적 자동병합 금지)
    const titleTokens = tokenize(input.title + " " + record.description);
    const similar = this.loadAll()
      .filter((m) => m.status === "active")
      .filter((m) => overlap(titleTokens, tokenize(m.title + " " + m.description)) >= SIMILAR_THRESHOLD);

    // 기존 기억 대체(supersede) — 신규 레코드 쪽 표시는 **생성 전에** 해야 본문에 직렬화된다
    const found = input.supersedes ? this.resolve(input.supersedes) : null;
    const superseded = found && !found.archived ? found.record : null;
    if (superseded) {
      record.supersedes = superseded.slug;
      pushHistory(record, `${this.today()}: supersedes [[${superseded.slug}]]`);
    }

    // 모순 가능성 — 유사 기억 중 숫자·버전·부정어가 갈리는 것만 신호로 돌려준다(병합·삭제 없음, P6)
    const newText = `${record.title} ${record.description} ${record.body}`;
    const contradictions = similar
      .filter((m) => m.slug !== superseded?.slug)
      .map((m) => ({ record: m, reasons: contradictionReasons(newText, `${m.title} ${m.description} ${m.body}`) }))
      .filter((c) => c.reasons.length > 0);

    // 원자적 생성 — slug 확정과 파일 생성이 한 연산이라 동시 remember 가 서로를
    // 덮어쓰지 못한다(감사 A5). 충돌 시 record.slug 가 -2, -3 … 으로 갱신된다.
    const finalSlug = this.vault.createNew(record);

    // 구 기억 쪽 역참조는 **최종 slug 확정 뒤에** — 충돌로 -2 가 붙으면
    // 생성 전 slug 로 기록한 supersededBy 가 없는 파일을 가리키게 된다
    if (superseded) {
      superseded.status = "superseded";
      superseded.supersededBy = finalSlug;
      superseded.updated = now;
      pushHistory(superseded, `${this.today()}: superseded by [[${finalSlug}]]`);
      this.vault.write(superseded);
    }

    // 요청된 링크 연결 (양방향)
    for (const target of input.links ?? []) {
      this.link(finalSlug, target);
    }

    // 본문에 쓴 `[[위키링크]]` 도 연상망에 반영한다.
    //
    // 종전에는 `links` 인자로 넘긴 것만 연결됐고 본문 링크는 무시됐다. 그래서 Obsidian
    // 에서는 연결로 보이는데 recall 의 확산에는 안 잡히는 상태가 됐다 — 실사용에서
    // 이관한 27건이 전부 orphan 으로 남았다. 깨진 링크 검증은 이미 본문을 읽고 있었으니
    // 한쪽 눈만 뜨고 있던 셈이다.
    //
    // **단방향으로만 붙인다.** link() 는 양방향이라 대상 파일까지 고쳐 쓰는데, 기억 하나를
    // 저장했더니 남의 파일이 바뀌는 것은 놀라움의 원칙에 어긋난다(Obsidian 도 대상 파일을
    // 고치지 않는다). 확산은 링크를 가진 쪽에서 나가므로 orphan 문제는 이것으로 해소된다.
    // 양방향이 필요하면 `link` 를 명시적으로 부르면 된다.
    const stored = this.vault.read(finalSlug);
    if (stored) {
      const known = new Set(this.vault.listSlugs(true).map((s) => s.slug));
      const fromBody = bodyWikilinks(stored.body).filter(
        (t) => t !== finalSlug && known.has(t) && !stored.links.includes(t),
      );
      if (fromBody.length > 0) {
        stored.links.push(...fromBody);
        this.vault.write(stored);
      }
    }

    this.regenerateIndex();
    const final = this.vault.read(finalSlug) ?? record;
    this.retriever.upsert(final);
    return { record: final, similar, contradictions, dangling: this.danglingLinks(final) };
  }

  /**
   * 회상 — 키워드 점수 × 진실성 가중 × 기저활성 가중 (P2).
   * 회상은 능동 인출로 간주해 상위 기억을 강화하고(P4),
   * 같은 클러스터의 경쟁 유사 기억은 순위에서만 완만히 억제한다(P5, RIF).
   * 질의 토큰은 한↔영 동의어로 확장되고, 직접 매칭이 0건이면 느슨한 2차 패스로
   * 연상 확산의 시드를 만든다(D1/D2).
   */
  /** 결과 배열만 필요할 때 쓰는 편의 래퍼 (컷오프 정보가 필요하면 searchDetailed) */
  search(
    query: string,
    opts?: {
      type?: MemoryType;
      limit?: number;
      includeLinked?: boolean;
      project?: string;
      altQueries?: string[];
      vectorHits?: { key: string; score: number }[];
    },
  ): SearchResult[] {
    return this.searchDetailed(query, opts).results;
  }

  searchDetailed(
    query: string,
    opts?: {
      type?: MemoryType;
      limit?: number;
      includeLinked?: boolean;
      project?: string;
      altQueries?: string[];
      /** 벡터 검색 결과(항목 키·점수) — 어휘 후보에 없는 항목만 via "vector" 후보로 덧붙인다 */
      vectorHits?: { key: string; score: number }[];
    },
  ): SearchOutcome {
    this.shadowTop5 = undefined;
    const q = parseQuery(query);
    if (q.tokens.length === 0) return { results: [], totalMatched: 0 };
    const limit = opts?.limit ?? 5;
    this.retriever.sync(this.vault);
    const now = this.nowMs();
    const filter = { type: opts?.type, project: opts?.project };

    // 1) 질의별 Retriever 후보 — 토큰이 없거나 앞 질의와 토큰이 같은 변형은 뺀다
    const seen = new Set([q.tokens.join(" ")]);
    const alts = (opts?.altQueries ?? [])
      .slice(0, MAX_ALT_QUERIES)
      .map(parseQuery)
      .filter((a) => {
        const key = a.tokens.join(" ");
        if (a.tokens.length === 0 || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    const queries = [q, ...alts];
    const lists = queries.map((pq) => this.retriever.search(pq, Infinity, filter, SCORER));

    // 여기에 "0건이면 제목·태그를 느슨하게 재검사" 하는 2차 패스가 있었다(감사 D2).
    // T16 이 1차 패스의 매처를 includes 에서 tokenMatch 로 통일하면서 무력화됐다 —
    // 1차가 title·tag·desc·**body** 를 이미 tokenMatch 로 보므로 0건이라는 것은 곧
    // 네 필드 전부 불일치이고, 2차는 그 **부분집합**(title·tag·desc)을 **같은 매처**로
    // 다시 볼 뿐이라 결과가 나올 수 없다. 실측: 질의 3040건 중 3025건이 이 블록에
    // 진입했으나 생산은 0건이었고, 대신 진입할 때마다 후보 전체를 재토큰화하는
    // 비용만 치렀다. 되살리려면 필드를 넓히는 게 아니라 **더 느슨한 매처**가 필요하다
    // (n-gram·임베딩). T22 평가에서 둘 다 근거 부족으로 기각됐다 — GOAL.md 참조.

    // 2) 가중 최대 융합 — 변형이 없으면 단일 목록을 그대로 쓴다(출력 불변).
    // 순위 기반 융합(RRF)은 점수 차를 평평하게 만들어 Ranker 의 신뢰도·활성도 곱이 관련도를 뒤집는다.
    const fused =
      alts.length === 0 ? lists[0] : fuseWeightedMax(lists, queries.map((_, i) => (i === 0 ? 1 : ALT_QUERY_WEIGHT)));
    const candidates = opts?.vectorHits ? this.withVectorHits(fused, opts.vectorHits, filter) : fused;
    const rq = alts.length === 0 ? q : mergeQueries(queries);

    // 3) Ranker — 신뢰도·활성도·RIF·연상 확산
    const { results, totalMatched } = rank(candidates, rq, {
      limit,
      now,
      includeLinked: opts?.includeLinked,
      project: opts?.project,
      vault: this.vault,
    });
    if (SHADOW && candidates.length > 0) this.shadowTop5 = this.shadowAgreement(queries, filter, now, limit, results);

    // P4/P5: 능동 회상 → 강화. 단 **억제된 경쟁자와 연상 이웃은 강화하지 않는다**(감사 C5).
    //
    // 종전에는 반환 목록 전체를 강화해서, RIF 로 순위를 눌러놓고도 같은 델타를 줬다.
    // 그래서 중복 쌍이 질의마다 나란히 +1 씩 받아 저장강도가 영원히 동률로 가고,
    // RIF 의 목적(미래 간섭 감소)이 세션 간 전혀 실현되지 않았다.
    // 연상 이웃도 "목록에 스쳤을 뿐 실제로 인출된 것" 이 아니므로 강화 대상에서 뺀다 —
    // 자주 질의되는 주제의 이웃들이 실사용과 무관하게 일괄 적립되던 문제를 막는다.
    // (연상 이웃을 정말 쓴 경우엔 이어지는 read_memory 가 수동 강화를 준다)
    // 융합 목록은 색인 항목당 한 건이라 변형이 몇 개든 한 호출에서 기억마다 한 번만 강화된다.
    for (const r of results) {
      const isAssoc = r.snippet.startsWith("(연상");
      // 벡터로만 들어온 결과도 강화하지 않는다 — 실제로 열어 읽을 때(read_memory) 강화된다
      if (isAssoc || r.inhibited || r.via === "vector") continue;
      this.reinforce(r.record, { active: true, preActivation: r.activation });
    }
    return { results, totalMatched };
  }

  /** 어휘 후보에 없는 벡터 결과만 via "vector" 후보로 덧붙인다 — 어휘 후보의 점수·순서는 그대로 둔다 */
  private withVectorHits(cands: Candidate[], hits: { key: string; score: number }[], filter: ScopeFilter): Candidate[] {
    const have = new Set(cands.map((c) => c.titleDescTokens));
    const extra: Candidate[] = [];
    for (const h of hits) {
      const c = this.retriever.candidate(h.key, filter);
      if (!c || have.has(c.titleDescTokens)) continue;
      have.add(c.titleDescTokens);
      extra.push({ ...c, score: h.score, via: "vector" });
    }
    return extra.length === 0 ? cands : [...cands, ...extra];
  }

  /**
   * 그림자 비교 — 같은 질의·변형을 bm25f 로 순위화해(연상·강화 없음) legacy 결과와 상위 k(= min(5, limit))건 slug 일치율을 낸다.
   * 일치율은 |A∩B| / max(|A|,|B|) 이고, A 는 연상 항목을 뺀 legacy 결과다.
   */
  private shadowAgreement(queries: ParsedQuery[], filter: ScopeFilter, now: number, limit: number, results: SearchResult[]): number {
    const k = Math.min(5, limit);
    const lists = queries.map((pq) => this.retriever.search(pq, Infinity, filter, "bm25f"));
    const cands =
      lists.length === 1 ? lists[0] : fuseWeightedMax(lists, queries.map((_, i) => (i === 0 ? 1 : ALT_QUERY_WEIGHT)));
    const rq = queries.length === 1 ? queries[0] : mergeQueries(queries);
    const b = rank(cands, rq, { limit: k, now, includeLinked: false }).results.map((r) => r.record.slug);
    const a = results
      .filter((r) => !r.snippet.startsWith("(연상"))
      .slice(0, k)
      .map((r) => r.record.slug);
    const size = Math.max(a.length, b.length);
    return size === 0 ? 1 : a.filter((s) => b.includes(s)).length / size;
  }

  /** 기억을 읽으면 강화되지만, 능동 인출(recall)보다 약하다 (P4, 검사효과) */
  read(idOrSlug: string): MemoryRecord | null {
    const found = this.resolve(idOrSlug);
    if (!found) return null;
    const act = activationOf(found.record);
    this.reinforce(found.record, { active: false, preActivation: act });
    return found.record;
  }

  /**
   * 잘못된 기억 교정 — 재공고화의 안전한 절반만 취한다 (P7).
   * 이력 보존 + 재확인(내용 미변경)은 저장강도·최근성 강화. 자동 오염 경로 없음.
   */
  revise(idOrSlug: string, input: ReviseInput): MemoryRecord | null {
    const found = this.resolve(idOrSlug);
    if (!found) return null;
    const m = found.record;
    const contentChanged = input.content !== undefined && input.content.trim() !== m.body;
    // 되돌릴 수 없는 덮어쓰기를 막는다 — 내용이 실제로 바뀔 때만 구본을 남긴다 (A7)
    if (contentChanged) {
      this.vault.snapshotRevision(m.slug, found.archived);
    }
    if (input.title !== undefined) m.title = input.title;
    if (input.description !== undefined) m.description = input.description;
    if (input.content !== undefined) m.body = input.content.trim();
    if (input.tags !== undefined) m.tags = input.tags;
    if (input.confidence !== undefined) m.confidence = Math.min(1, Math.max(0, input.confidence));
    if (input.source !== undefined) m.source = input.source;
    if (input.project !== undefined) m.project = input.project || undefined; // 빈 문자열 = 전역으로 되돌리기
    if (input.reviewAfter !== undefined) m.reviewAfter = input.reviewAfter || undefined; // 빈 문자열 = 검토일 해제
    // 유형 교정 (T35). 종전에는 생성 시 정해진 뒤 바뀔 길이 없어 오분류조차 못 고쳤고,
    // 반복 경험이 일화에서 의미로 넘어가는 전이를 표현할 수단도 없었다.
    // 바뀌었을 때만 이력에 남긴다 — 무엇이 왜 재분류됐는지가 감사 대상이다.
    const typeChanged = input.type !== undefined && input.type !== m.type;
    const oldType = m.type;
    if (input.type !== undefined) m.type = input.type;
    this.ensureBodyLinks(m); // 본문 교체로 연상 링크가 소실되지 않도록 복원

    // 재공고화: 재확인/갱신은 기억을 강화하고 최근성 시계를 갱신.
    // **간격 게이트를 우회하지 않는다**(감사 C6): 종전에는 revise 가 무조건 +1 이라
    // 몇 초 안에 두 번 고치면 1→3 이 됐고, lastReinforced 리셋으로 다음 정상 강화의
    // 기준선까지 흔들렸다. instructions 가 중복 대신 revise 를 권하므로 한 세션에서
    // 여러 번 다듬는 것은 정상 경로이고, P3(간격 둔 강화만 인정)와 정면으로 어긋났다.
    // 또한 태그만 바꾸는 순수 메타데이터 편집은 "재확인" 이 아니므로 강화하지 않는다.
    const substantive = contentChanged || input.confidence !== undefined;
    const spacingOk = this.nowMs() - Date.parse(m.lastReinforced) >= requiredSpacing(m, this.nowMs());
    if (substantive && spacingOk) {
      m.storageStrength += 1;
      m.lastReinforced = this.nowIso();
    }
    m.lastAccessed = this.nowIso();
    m.updated = this.nowIso();
    if (typeChanged) pushHistory(m, `${this.today()}: reclassified ${oldType} → ${m.type}`);
    pushHistory(
      m,
      `${this.today()}: ${contentChanged ? "revised" : "reconfirmed"} — ${input.reason}${input.source ? ` (source: ${input.source})` : ""}`,
    );
    this.vault.write(m, found.archived);
    this.retriever.upsert(m, found.archived);
    this.regenerateIndex();
    return m;
  }

  /** 망각 — 삭제하지 않고 archive/로 이동, 사유 기록 (P6: 가역) */
  forget(idOrSlug: string, reason: string): MemoryRecord | null {
    const found = this.resolve(idOrSlug);
    if (!found) return null;
    const m = found.record;
    m.status = "archived";
    m.archiveReason = reason;
    m.updated = this.nowIso();
    pushHistory(m, `${this.today()}: forgotten — ${reason}`);
    if (!found.archived) {
      this.vault.write(m); // 이력 반영 후 이동
      this.vault.moveToArchive(m.slug);
    } else {
      this.vault.write(m, true);
    }
    this.retriever.remove(m.slug);
    this.regenerateIndex();
    return m;
  }

  /** 두 기억을 연상 관계로 연결 (양방향 위키링크) */
  link(sourceIdOrSlug: string, targetIdOrSlug: string, relation?: string): { source: MemoryRecord; target: MemoryRecord } | null {
    const s = this.resolve(sourceIdOrSlug);
    const t = this.resolve(targetIdOrSlug);
    if (!s || !t || s.record.slug === t.record.slug) return null;
    this.addLink(s.record, t.record.slug, relation, s.archived);
    this.addLink(t.record, s.record.slug, relation, t.archived);
    this.regenerateIndex();
    return { source: s.record, target: t.record };
  }

  /** 메타인지 — 기억 상태 점검 리포트 (P6: 망각은 제안만, 자동삭제 없음) */
  reflect(): {
    counts: { total: number; byType: Record<string, number>; byStatus: Record<string, number> };
    weakened: { slug: string; title: string; activation: number; confidence: number }[];
    forgetCandidates: { slug: string; title: string; activation: number; confidence: number }[];
    /** 약해졌지만 확신도가 높아 망각 후보에서 제외된 건수 (P6 의 보수적 설계, 감사 C6) */
    trustedButFaded: number;
    lowConfidence: MemoryRecord[];
    duplicates: [string, string][];
    orphans: MemoryRecord[];
    /** 존재하지 않는 슬러그를 가리키는 위키링크 — 연결이 끊긴 채 방치된 기억 */
    danglingLinks: { slug: string; targets: string[] }[];
    /** 공고화 후보 — 같은 주제를 반복 겪은 일화 묶음 (T35) */
    consolidationCandidates: { theme: string; slugs: string[] }[];
  } {
    const all = this.loadAll(true);
    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const m of all) {
      byType[m.type] = (byType[m.type] ?? 0) + 1;
      byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
    }
    const now = this.nowMs();
    const active = all.filter((m) => m.status === "active");

    // 기저활성이 임계 τ 미만 = 오래 안 쓰여 약해진(회상 곤란) 기억.
    //
    // 절대 임계만으로는 신생 볼트에서 전원이 걸린다(감사 C2): n=1 기억은 생성 16.2시간이면
    // τ 를 밑돌아, 저장만 하고 하루 지난 멀쩡한 기억이 전부 "정리 대상" 으로 뜬다.
    // instructions 가 주기적 reflect 후 정리를 지시하므로 오탐이 실제 삭제로 이어질 수 있다.
    // 두 겹으로 완화한다:
    //   (a) 유예기간 — 갓 만든 기억은 아직 "잊혔다" 고 볼 수 없다
    //   (b) 상대 분위 — 볼트에서 상대적으로 가장 약한 것만 고른다. 볼트가 작으면
    //       정리할 것도 없으므로 자연히 0건이 된다(절대 임계만 쓰던 종전의 노이즈 제거)
    const withAct = active.map((m) => ({
      m,
      act: activationOf(m, now),
      matured: now - Date.parse(m.created) >= WEAKENED_GRACE_MS,
    }));
    const brief = (x: (typeof withAct)[number]) => ({
      slug: x.m.slug,
      title: x.m.title,
      activation: Number(x.act.toFixed(2)),
      confidence: x.m.confidence,
    });
    const faded = withAct.filter((x) => x.matured && x.act < RETRIEVAL_THRESHOLD).sort((a, b) => a.act - b.act);
    const cap = Math.floor(active.length * WEAKENED_RATIO);
    const weakened = faded.slice(0, cap).map(brief);
    // P6 는 "진실하다고 믿는 기억은 접근성 저하만으로 버리지 않는다" 는 보수적 설계라
    // 확신도가 높으면 아무리 방치돼도 망각 후보에 오르지 않는다. 그 자체는 타당하지만
    // 그런 기억이 몇 건인지 안 보이면 정리 판단이 방치된다 — 카운트만 노출한다 (감사 C6).
    const trustedButFaded = faded.filter((x) => x.m.confidence >= 0.5).length;
    // 망각 후보 = 약해졌고(활성 낮음) + 확신도도 낮음 (적응적 망각 후보, 실제 삭제는 AI 판단).
    // 확신도 게이트가 이미 강력한 필터라 분위 상한은 걸지 않되, 유예기간은 동일하게 적용한다.
    const forgetCandidates = faded.filter((x) => x.m.confidence < 0.5).map(brief);

    const lowConfidence = active.filter((m) => m.confidence < 0.4);
    const duplicates: [string, string][] = [];
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const sim = overlap(
          tokenize(active[i].title + " " + active[i].description),
          tokenize(active[j].title + " " + active[j].description),
        );
        if (sim >= DUPLICATE_THRESHOLD) duplicates.push([active[i].slug, active[j].slug]);
      }
    }
    const orphans = active.filter((m) => m.links.length === 0);
    const danglingLinks = active
      .map((m) => ({ slug: m.slug, targets: this.danglingLinks(m) }))
      .filter((x) => x.targets.length > 0);

    // 공고화 후보 (T35) — 사람의 뇌는 같은 일을 반복 겪으면 개별 일화에서 규칙을 뽑는다.
    //
    // **서버는 후보만 내고 추상화는 하지 않는다.** 자동 일반화는 P8(허위기억 배제)과
    // P6(자동 파괴 금지)을 동시에 위협한다 — 세 건이 겹친다고 규칙이 참인 것은 아니다.
    // 어느 것이 진짜 패턴인지는 본문을 읽어야 알 수 있고, 그건 모델의 일이다.
    //
    // 후보 조건: 아직 공고화되지 않은 **일화(episodic)** 가 한 태그 아래 3건 이상.
    // 태그를 축으로 삼는 이유는 그것이 사용자가 명시한 주제 신호이기 때문이다 —
    // 토큰 유사도로 묶으면 표층이 닮았을 뿐인 무관한 기억이 한 묶음이 된다(감사 D3 의 교훈).
    const CONSOLIDATION_MIN = 3;
    const alreadyDerived = new Set(active.flatMap((m) => m.derivedFrom ?? []));
    const byTag = new Map<string, string[]>();
    for (const m of active) {
      if (m.type !== "episodic" || alreadyDerived.has(m.slug)) continue;
      for (const t of m.tags) {
        if (!byTag.has(t)) byTag.set(t, []);
        byTag.get(t)?.push(m.slug);
      }
    }
    const consolidationCandidates = [...byTag.entries()]
      .filter(([, slugs]) => slugs.length >= CONSOLIDATION_MIN)
      .map(([theme, slugs]) => ({ theme, slugs: slugs.sort() }))
      .sort((a, b) => b.slugs.length - a.slugs.length);

    return {
      counts: { total: all.length, byType, byStatus },
      weakened,
      forgetCandidates,
      trustedButFaded,
      lowConfidence,
      duplicates,
      orphans,
      danglingLinks,
      consolidationCandidates,
    };
  }

  list(opts?: { type?: MemoryType; status?: MemoryStatus; project?: string }): MemoryRecord[] {
    return this.loadAll(true)
      .filter((m) => (opts?.type ? m.type === opts.type : true))
      .filter((m) => (opts?.status ? m.status === opts.status : m.status === "active"))
      .filter((m) => inScope(m, opts?.project))
      .sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated) || a.slug.localeCompare(b.slug));
  }

  /** MEMORY.md 인덱스 재생성 (Obsidian에서 허브 노트로 사용 가능) */
  regenerateIndex(): void {
    const active = this.loadAll().filter((m) => m.status === "active");
    const groups: Record<MemoryType, MemoryRecord[]> = {
      preference: [],
      semantic: [],
      episodic: [],
      procedural: [],
    };
    for (const m of active) groups[m.type].push(m);
    const label: Record<MemoryType, string> = {
      preference: "취향/선호 (preference)",
      semantic: "지식/사실 (semantic)",
      episodic: "경험/사건 (episodic)",
      procedural: "방법/절차 (procedural)",
    };
    let md = "# BigBrainMemory 인덱스\n\n> 자동 생성 파일입니다. 직접 수정하지 마세요.\n";
    // 나이를 함께 싣는다. 이 파일은 SessionStart 훅이 통째로 컨텍스트에 주입하는
    // **주 채널**인데, 종전에는 확신도만 있고 나이가 없었다. recall 응답에는
    // age_days/stale_hint 가 붙는데 주입 채널에만 빠져 있던 비대칭이다.
    // 그 결과 낡은 단정문이 확신도 0.99 라는 권위만 달고 들어와, 모델이 코드를
    // 확인하지 않고 인용하는 프라이밍 사고가 실제로 관측됐다. 네이티브 메모리가
    // 파일을 읽을 때 "N일 전 기억 — 현재 코드와 대조하라" 를 자동으로 붙이는 것과
    // 같은 역할을 여기서 한다.
    const now = this.nowMs();
    for (const type of Object.keys(groups) as MemoryType[]) {
      const items = groups[type];
      if (items.length === 0) continue;
      md += `\n## ${label[type]}\n\n`;
      for (const m of items.sort((a, b) => b.confidence - a.confidence)) {
        const ageDays = Math.max(0, Math.floor((now - Date.parse(m.updated)) / 86_400_000));
        const age = Number.isFinite(ageDays)
          ? isStale(m, ageDays)
            ? ` · ${ageDays}일 전, 대조 필요`
            : ` · ${ageDays}일 전`
          : "";
        md += `- [[memories/${m.slug}|${m.title}]] — ${m.description} (확신도 ${m.confidence.toFixed(2)}${age})\n`;
      }
    }
    this.vault.writeIndex(md);
  }

  /**
   * 강화 (P3 간격 게이트 + P4 능동>수동 + 바람직한 어려움).
   * 저장강도는 간격이 지나야 오른다. 원문 접근수/최근성은 항상 갱신.
   *
   * **디스크 반영은 스냅샷이 아니라 재읽기 후 증분으로 한다(감사 A4).**
   * search() 는 시작 시 loadAll 로 전체 스냅샷을 뜨고 끝에서 강화를 기록하는데,
   * 그 창(볼트 스캔 1회 길이) 안에 다른 프로세스가 revise/forget 을 끝내면
   * 스냅샷 전체를 재직렬화하던 기존 구현이 상대의 변경을 흔적 없이 되돌렸다:
   *   - revise 소실: body/confidence/history 가 이전 상태로 복귀
   *   - forget 부활: archive 로 옮겨진 기억이 memories/ 에 되살아나 split-brain
   *   - 강화 소실: 2프로세스 300회씩 recall 시 84~99.5% 유실
   * 이제 쓰기 직전 파일을 다시 읽어 **그 레코드에 델타만 얹어** 기록하므로,
   * 경쟁 프로세스가 바꾼 내용(본문·확신도·이력·상태)은 그대로 보존된다.
   *
   * 강화는 best-effort 다 — 쓰기에 실패해도 던지지 않는다. 회상/열람이
   * 부수효과(강화) 실패 때문에 통째로 실패하면 안 된다.
   */
  private reinforce(m: MemoryRecord, opts: { active: boolean; preActivation: number }): void {
    const now = this.nowMs();
    const accessedAt = this.nowIso();
    const reinforcementDelta = (target: MemoryRecord): number => {
      if (now - Date.parse(target.lastReinforced) < requiredSpacing(target, now)) return 0;
      let delta = opts.active ? 1 : 0.5;
      if (opts.active && opts.preActivation < HARD_RETRIEVAL_ACTIVATION) delta += 0.5;
      return delta;
    };
    const initialDelta = reinforcementDelta(m);

    m.accessCount += 1;
    m.lastAccessed = accessedAt;
    if (initialDelta > 0) {
      m.storageStrength += initialDelta;
      m.lastReinforced = accessedAt;
    }
    if (initialDelta === 0 && !FLUSH_EVERY_ACCESS) return;

    try {
      const apply = (target: MemoryRecord) => {
        const delta = reinforcementDelta(target);
        target.accessCount += 1;
        target.lastAccessed = accessedAt;
        if (delta > 0) {
          target.storageStrength += delta;
          target.lastReinforced = accessedAt;
        }
        return target;
      };
      if (typeof this.vault.updateRecord === "function") {
        const updated = this.vault.updateRecord(m.slug, apply);
        if (!updated) throw new Error("강화 대상 레코드 없음");
        Object.assign(m, updated);
      } else {
        const fresh = this.vault.find(m.slug);
        if (fresh) Object.assign(m, apply(fresh.record));
        if (fresh) this.vault.write(m, fresh.archived);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const reason = /SQLITE_BUSY|database is locked/i.test(message) ? "busy_exhausted" : "exception_swallowed";
      logWarn(`강화 미반영: ${m.slug} — ${reason}: ${message}`);
      try {
        this.vault.appendUsageEvent({ tool: "reinforcement_unapplied", ok: false, reason, slug: m.slug, message });
      } catch (usageError) {
        logWarn(`강화 미반영 이벤트 기록 실패: ${usageError instanceof Error ? usageError.message : String(usageError)}`);
      }
    }
  }

  private addLink(m: MemoryRecord, targetSlug: string, relation: string | undefined, archived: boolean): void {
    if (!m.links.includes(targetSlug)) m.links.push(targetSlug);
    this.appendBodyLink(m, targetSlug, relation);
    m.updated = this.nowIso();
    this.vault.write(m, archived);
  }

  /**
   * 본문·links 가 가리키는 슬러그 중 **볼트에 없는 것**을 돌려준다 (깨진 위키링크).
   *
   * 왜 필요한가 — 모델은 주입된 인덱스나 기억나는 이름을 보고 `[[슬러그]]` 를 본문에
   * 그냥 쓴다. 그런데 그 이름이 존재한다는 보장이 어디에도 없다. 특히 볼트 A 의
   * 인덱스가 컨텍스트에 있는 상태에서 볼트 B 에 저장하면 통째로 깨진다.
   * 실볼트 관측: 기억 2건짜리 볼트에 이미 깨진 링크 1건이 들어 있었다.
   *
   * **차단하지 않고 보고만 한다.** 아직 안 쓴 기억을 미리 가리키는 선행 참조는
   * 정상적인 사용법이고(그래서 remember 설명이 링크를 권장한다), 저장을 막으면
   * 그 정상 경로까지 죽는다. 모델이 알고 고치게 하는 것이 목적이다.
   */
  private danglingLinks(m: MemoryRecord): string[] {
    let known: Set<string>;
    try {
      known = new Set(this.vault.listSlugs(true).map((s) => s.slug));
    } catch {
      return []; // 볼트를 못 읽으면 판정하지 않는다 — 오탐이 침묵보다 나쁘다
    }
    const targets = new Set<string>(m.links);
    for (const t of bodyWikilinks(m.body)) targets.add(t);
    return [...targets]
      // 인덱스(MEMORY.md)가 쓰는 `memories/<slug>` 표기도 같은 대상으로 본다
      .map((t) => t.replace(/^memories\//, ""))
      .filter((t) => t !== "" && t !== m.slug && !known.has(t))
      .sort();
  }

  /** frontmatter의 links 배열 기준으로 본문에 빠진 위키링크를 복원 */
  private ensureBodyLinks(m: MemoryRecord): void {
    for (const target of m.links) {
      this.appendBodyLink(m, target, undefined);
    }
  }

  private appendBodyLink(m: MemoryRecord, targetSlug: string, relation: string | undefined): void {
    if (m.body.includes(`[[${targetSlug}]]`)) return;
    const marker = "## 연관 기억";
    const line = `- [[${targetSlug}]]${relation ? ` — ${relation}` : ""}`;
    if (m.body.includes(marker)) {
      m.body = m.body.replace(marker, `${marker}\n${line}`);
    } else {
      m.body = `${m.body}\n\n${marker}\n${line}`;
    }
  }
}

export { MemoryService as MemoryStore };
