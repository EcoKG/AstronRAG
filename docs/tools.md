# MCP 도구와 정리 프롬프트

[README로](../README.md) · [기억 모델](memory-guide.md) · [설정](configuration.md)

## 도구 입력

도구 9개는 모두 조건 없이 등록됩니다. 아래 표에서 필수 외 항목은 선택입니다. `id`는 id 또는 슬러그를 뜻합니다. 기억 유형은 `episodic`·`semantic`·`procedural`·`preference`입니다.

| 도구 | 필수 | 선택 입력·기본값 | 근거 |
|---|---|---|---|
| `remember` | `title`, `content`, `type` | `description`(본문 첫 줄), `tags`, `links`, `confidence`(0.8, 범위 0~1), `source`, `project`, `supersedes`, `slug`, `derived_from`, `review_after`(YYYY-MM-DD) | `src/index.ts`의 `server.registerTool`의 `remember` 등록 |
| `recall` | `query` | `alt_queries`(최대 3개 사용), `type`, `limit`(1~20, 기본 5), `include_linked`(기본 true), `project` | `src/index.ts`의 `server.registerTool`의 `recall` 등록 |
| `read_memory` | `id` | 없음. 간격 게이트를 통과하면 저장강도 +0.5(능동 recall은 기본 +1, 낮은 활성일 때 +0.5 추가 보너스) | `src/index.ts`의 `server.registerTool`의 `read_memory` 등록, `src/store.ts`의 `MemoryService.read`·`MemoryService.reinforce` |
| `revise` | `id`, `reason` | `content`, `title`, `description`, `tags`, `confidence`(0~1), `source`, `project`, `type`, `review_after` | `src/index.ts`의 `server.registerTool`의 `revise` 등록 |
| `forget` | `id`, `reason` | 없음 | `src/index.ts`의 `server.registerTool`의 `forget` 등록 |
| `link` | `source`, `target` | `relation` | `src/index.ts`의 `server.registerTool`의 `link` 등록 |
| `reflect` | 없음 | 없음 | `src/index.ts`의 `server.registerTool`의 `reflect` 등록 |
| `list_memories` | 없음 | `type`, `status`(active/superseded/archived), `project` | `src/index.ts`의 `server.registerTool`의 `list_memories` 등록 |
| `recommend` | `description`(공백 제거 후 1~4000자), `role` | `platform`(claude/codex). role: research/plan/impl/review/ship/ops/coordinator | `src/index.ts`의 `server.registerTool`의 `recommend` 등록 |

`recommend`는 패키지의 온톨로지에서 모델과 effort를 추천합니다. 플랫폼 필터를 받을 수 있고, 파일 읽기·스키마 검증 실패는 `isError` 응답입니다. 외부 모델을 호출해 실행하는 도구는 아닙니다.

## 기억 응답과 경계 동작

기억 요약의 공통 필드: `id`, `slug`, `title`, `description`, `type`, `tags`, `confidence`, `storage_strength`, `status`, `access_count`, `source`, `project`, `links`, `updated`, `age_days`. 설정된 `review_after`와 해당하는 `stale_hint`도 반환됩니다. `read_memory`는 `body`와 기억 자체의 `history`를 포함합니다(`src/index.ts`의 `brief` 및 `ageInfo`, `src/index.ts`의 `full`).

- **낡음:** 마지막 갱신으로부터 episodic 14일, semantic·procedural 60일, preference 180일 이상이거나 검토일이 지나면 경고합니다. `ASTRONRAG_STALE_DAYS`로 일괄 임계를 지정할 수 있습니다.
- **중복·모순:** `remember`는 `similar_existing_memories`를 알려 줍니다. 양쪽에 서로 다른 숫자·버전(날짜 제외)이 있거나 부정어가 다르면 `possible_contradiction`과 `number`/`negation` 사유를 알립니다. 자동 병합·삭제는 하지 않습니다.
- **비밀정보:** remember·revise의 제목·설명·본문은 API 키 패턴, 개인키 헤더, password 대입값 등을 탐지하면 저장을 거부합니다. 값 대신 설정 파일 위치나 키 이름을 저장합니다. 이 탐지는 모든 비밀을 보장하는 범용 검사기는 아닙니다.
- **긴 본문:** 1,500자 초과는 저장하되 사실 단위로 나누고 링크하도록 `hint`를 반환합니다.
- **위키링크:** 존재하지 않는 슬러그를 향한 본문 링크는 `broken_links`로 알립니다. 선행 참조를 허용하므로 저장을 차단하지 않습니다.
- **회상:** `total_matched`는 잘라내기 전 매칭 수이며 잘렸으면 `truncated` 안내가 있습니다. 결과에는 `score`, `activation`, `inhibited`, `snippet`이 붙습니다. 0건이면 `note`로 다른 표현의 재질의를 안내합니다. 변형 질의 초과분은 앞 3개만 쓰고 `alt_queries_note`로 알립니다.
- **스코프 변경:** `revise`의 `project: ""`는 전역 전환, `review_after: ""`는 검토일 해제입니다. `revise`로 유형도 교정할 수 있습니다.
- **연결:** `link`는 양방향 위키링크를 만듭니다. `relation`은 본문 `## 연관 기억`에 라벨로 남습니다. 같은 기억끼리 연결하거나 한쪽이 없으면 오류입니다.
- **목록:** `list_memories`는 최근 갱신순입니다. 스코핑 계약은 [설정](configuration.md#프로젝트-스코핑)을 따릅니다.
- **혼용 주의:** `review_after`를 지원하지 않는 서버가 같은 기억을 다시 쓰면 검토일이 없어질 수 있습니다. 필드를 지원하는 서버로 통일하고 필요하면 `revise`로 다시 지정합니다.

비밀정보 거부·경고 코드는 `src/index.ts`의 `findSecret`, `src/index.ts`의 `server.registerTool`의 `remember` 등록·`findSecret` 호출, `src/index.ts`의 `server.registerTool`의 `revise` 등록·`findSecret` 호출, 회상 응답은 `src/index.ts`의 `server.registerTool`의 `recall` 등록·응답 분기, 목록은 `src/index.ts`의 `server.registerTool`의 `list_memories` 등록에서 확인합니다.

## reflect와 공고화

`reflect`는 다음 항목을 반환하며, 후보 제시만 합니다(`src/index.ts`의 `server.registerTool`의 `reflect` 등록·응답).

| 응답 | 의미 |
|---|---|
| `weakened_hard_to_recall` | 유예기간과 활성 하위 비율을 함께 충족한 기억 |
| `forget_candidates` | 망각 검토 후보 |
| `trusted_but_faded` | 약해졌지만 확신도가 높아 망각 후보에서 제외된 건수 |
| `low_confidence` | 낮은 확신도 |
| `possible_duplicates` | 중복 후보 |
| `orphans_without_links` | 연결이 없는 기억 |
| `broken_links` | 존재하지 않는 슬러그를 가리키는 링크 |
| `consolidation_candidates` | 태그별 미추상화 일화가 3건 이상 모인 공고화 후보 |

## 정리 프롬프트

`consolidate`는 매개변수 없는 MCP 프롬프트입니다. Claude Code에서 `/mcp__astronrag__consolidate`로 불러옵니다(`src/index.ts`의 `server.registerPrompt`의 `consolidate` 등록).

프롬프트는 `reflect` 호출 → 중복 쌍의 양쪽 전문 비교와 보강·보관 → 망각 후보의 유효성 확인 → 확신도가 높지만 약해진 기억의 표본 점검 → 낮은 확신도의 근거 확인 → 고립 기억 연결 → `reflect` 재확인 순서를 안내합니다. 애매한 경우에는 확신도를 낮추도록 안내하며, 프롬프트가 스스로 도구를 강제 호출하거나 자동 삭제하지는 않습니다.

별도 수동 작업으로 `reflect`의 깨진 링크를 대상 생성 또는 본문 교정으로 처리하고, 공고화 후보의 원문을 확인해 규칙이 성립하면 `remember`의 `derived_from`으로 출처를 명시할 수 있습니다. 두 작업은 `consolidate`에 내장된 절차가 아닙니다.
