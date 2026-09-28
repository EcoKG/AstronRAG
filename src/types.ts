/** 사람의 기억 분류를 본뜬 기억 유형 */
export type MemoryType = "episodic" | "semantic" | "procedural" | "preference";

/** active: 살아있는 기억 / superseded: 새 기억으로 대체됨 / archived: 망각(잘못된 기억 등) */
export type MemoryStatus = "active" | "superseded" | "archived";

/**
 * 기억 1건. 리포트(docs/memory-model-report.md) P1에 따라 세 축을 분리한다:
 *  - confidence      : 진실성 — 이 기억이 옳다고 믿는 정도 (revise로만 변함)
 *  - storageStrength : 저장강도 — 단조 증가. 간격 둔 능동 회상으로만 오름 (Bjork)
 *  - 인출강도        : 저장하지 않고 질의 시 기저활성으로 계산 (ACT-R power law)
 */
export interface MemoryRecord {
  id: string;
  /** 파일명(.md 제외). Obsidian 위키링크 대상 */
  slug: string;
  title: string;
  /** 회상 판단에 쓰이는 한 줄 요약 */
  description: string;
  type: MemoryType;
  tags: string[];
  /** 0.0 ~ 1.0 — 진실성(옳다고 믿는 정도). 접근으로 변하지 않는다 */
  confidence: number;
  /** 저장강도 n (Bjork). 기저활성 계산의 빈도항. 단조 증가 */
  storageStrength: number;
  status: MemoryStatus;
  created: string;
  updated: string;
  lastAccessed: string;
  /** 마지막으로 저장강도가 오른 시각 — 간격 게이트 기준 (간격효과) */
  lastReinforced: string;
  /** 원문 접근 총횟수 (정보용, 기저활성엔 미사용) */
  accessCount: number;
  /** 출처 — 인간의 출처혼동(source-monitoring error)을 역보완 (리포트 P8) */
  source?: string;
  /**
   * 소속 프로젝트. 없으면(undefined) **전역 기억** — 어느 프로젝트에서도 회상된다.
   * 네이티브 메모리는 프로젝트별로 저장소가 갈려 교차 프로젝트 지식을 공유할 수 없는데,
   * 이 필드는 격리(프로젝트 기억)와 공유(전역 기억)를 한 볼트에서 양립시킨다.
   */
  project?: string;
  /** 연결된 기억의 slug 목록 (연상 네트워크) */
  links: string[];
  /**
   * 공고화 출처 — 이 기억이 어떤 에피소드들에서 **추상화**돼 나왔는지 (T35).
   *
   * 사람의 뇌는 휴식·수면 중 해마의 개별 에피소드를 재생해 신피질의 의미기억으로
   * 추상화한다. BBM 에는 그 전이 경로가 없었다 — `type` 은 생성 시 한 번 정해지고
   * 어디서도 바뀌지 않았다.
   *
   * **P8 과의 긴장을 여기서 푼다.** 추상화 자체는 위반이 아니다. *추상화가 원본을
   * 대체하는 것*이 위반이다(인간 기억의 버그는 원본 에피소드가 소실되고 스키마만
   * 남는 것이다). 그래서 파생물은 원본을 **한 바이트도 바꾸지 않고** 새 파일로만
   * 생기며, 이 필드가 근거를 영구히 붙들어 둔다. frontmatter 에 두는 이유가 그것이다 —
   * 본문에만 적으면 revise 한 번에 출처가 사라져 손으로 쓴 단정문과 구별되지 않는다.
   */
  derivedFrom?: string[];
  /** 검토일(YYYY-MM-DD). 이 날이 지나면 나이와 무관하게 낡음으로 표시한다 */
  reviewAfter?: string;
  supersedes?: string;
  supersededBy?: string;
  archiveReason?: string;
  /** 생성/수정/망각 이력 ("ISO날짜: 내용") */
  history: string[];
  /** frontmatter를 제외한 마크다운 본문 */
  body: string;
}

export interface RememberInput {
  title: string;
  content: string;
  description?: string;
  type: MemoryType;
  tags?: string[];
  links?: string[];
  confidence?: number;
  source?: string;
  project?: string;
  supersedes?: string;
  /** 이 기억이 추상화한 근거 에피소드들의 slug (T35 공고화) */
  derivedFrom?: string[];
  /** 검토일(YYYY-MM-DD) */
  reviewAfter?: string;
  /**
   * 파일명·위키링크 대상으로 쓸 슬러그. 생략하면 제목에서 파생된다.
   * 제목과 분리한 이유: 종전에는 링크 대상을 안정적으로 두려면 제목 자체를 영문 케밥으로
   * 강제해야 했다 — 파일명 규칙과 사람이 읽는 이름은 별개의 요구다.
   */
  slug?: string;
}

export interface ReviseInput {
  content?: string;
  title?: string;
  description?: string;
  tags?: string[];
  confidence?: number;
  source?: string;
  project?: string;
  /**
   * 기억 유형 교정 (T35).
   * 종전에는 `type` 이 생성 시 한 번 정해진 뒤 **어디서도 바뀌지 않아 오분류조차 고칠 수
   * 없었다.** 사람의 기억은 반복 경험이 쌓이면 일화가 의미로 넘어간다 — 그 전이를
   * 표현할 길이 없었다는 뜻이다.
   */
  type?: MemoryType;
  /** 검토일(YYYY-MM-DD). 빈 문자열이면 해제한다 */
  reviewAfter?: string;
  reason: string;
}

export interface SearchOutcome {
  results: SearchResult[];
  /** 컷오프 전 직접 매칭 총 건수 — 에이전트가 누락 존재를 알 수 있게 (감사 D5) */
  totalMatched: number;
}

export interface SearchResult {
  record: MemoryRecord;
  score: number;
  /** 질의 시점 기저활성 (인출강도의 로그) — 디버깅/설명용 */
  activation: number;
  snippet: string;
  /** 측면억제(RIF)로 순위가 눌렸는지 */
  inhibited?: boolean;
  /**
   * 누구에게 눌렸는지 (slug). 억제는 순위를 절반으로 깎는 강한 효과인데 종전에는
   * 눌렸다는 사실만 알 뿐 **주체를 알 수 없어** 오억제를 추적할 수 없었다.
   * 공고화 도입 후에는 특히 중요하다 — "파생물이 근거를 눌렀는가" 가 P8 계약이기 때문이다.
   */
  inhibitedBy?: string;
}
