# MCP 도구와 정리 프롬프트

[README로](../README.md) · [기억 모델](memory-guide.md) · [설정](configuration.md)

## 도구 입력

도구 11개는 모두 조건 없이 등록됩니다. 아래 표에서 필수 외 항목은 선택입니다. 기억 도구의 `id`는 id 또는 슬러그를 뜻합니다. 기억 유형은 `episodic`·`semantic`·`procedural`·`preference`입니다. 추천 관련 도구의 모델 식별자는 아래 각 절의 검증을 따릅니다.

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
| `recommend` | `description`(앞뒤 공백 제거 후 1~4000자), `role` | `platform`(claude/codex), `size`(small/medium/large), `risk`(normal/high), `novelty`(new/existing), `cross_review_of` | `src/index.ts`의 `server.registerTool`의 `recommend` 등록 |
| `model_catalog` | 없음 | 없음 | `src/index.ts`의 `server.registerTool`의 `model_catalog` 등록, `src/ontology.ts`의 `modelCatalog` |
| `record_recommendation_feedback` | `event_id`, `policy_version`, `catalog_revision`, `rule_id`, `model`, `effort`, `role`, `risk`, `verdict`, `input_tokens`, `output_tokens`, `cost_usd`, `duration_ms`, `reverts` | `size`, `novelty`, `cross_review_of` | `src/recommender.ts`의 `feedbackInputSchema`·`validateFeedback` |

## recommend

패키지 온톨로지의 규칙으로 모델과 effort를 추천합니다. 외부 모델을 호출해 작업을 실행하지 않습니다.

- 필수 입력: `description`은 앞뒤 공백 제거 후 1~4000자, `role`은 research/plan/impl/review/ship/ops/coordinator 중 하나입니다.
- 선택 입력: `platform`은 claude/codex, `size`는 small/medium/large, `risk`는 normal/high, `novelty`는 new/existing입니다. `cross_review_of`는 검토 대상 모델의 등록된 ID 또는 유일한 별칭이며 앞뒤 공백 제거 후 1~100자입니다. ID·별칭은 대소문자를 구분하지 않으며 알 수 없거나 모호하면 오류입니다.
- `size`·`novelty`를 생략하면 설명의 키워드로 분류하며 해당 키워드가 없으면 각각 medium·existing입니다. 작은 작업 키워드(예: 한 줄 수정, 주석 수정, 오타 수정, 한 파일 수정)는 부분 문자열로 비교하며, 어려운 작업 키워드(예: 아키텍처, 대형 코드)가 함께 있으면 small로 보지 않습니다. 명시한 `size`가 키워드 분류보다 우선합니다. `risk`가 high이거나 보안 키워드가 있으면 위험도는 high입니다. `risk: normal`로 보안 키워드의 판정을 낮추지는 않습니다. 플랫폼 필터와 정책 우선순위 때문에 다른 계열의 교차 검토가 불가능하면 `reasons`에 사유를 돌려줍니다.
- 출력: `policy_version`, `catalog_revision`, `rule_id`, `model`, `effort`, `role`, 적용된 `size`·`novelty`, `classification`(taskType·difficulty·risk), `reasons`, `appliedConstraints`, `evidence`, `candidates`, `ruleConfidence`입니다. 같은 결과를 JSON 텍스트와 `structuredContent`로 반환합니다.
- 피드백에는 추천 응답의 버전·규칙·모델·effort·역할과 적용된 `size`·`novelty`, `classification.risk`를 사용합니다. 교차 검토를 지정했다면 같은 `cross_review_of`도 보냅니다. 온톨로지 읽기·스키마 검증 실패, 유효하지 않은 교차 검토 식별자, 허용된 추천 규칙이 없는 경우는 `isError` 응답입니다.

근거: `src/index.ts`의 `server.registerTool`의 `recommend` 등록, `src/recommender.ts`의 `recommendModel`·`classifyTask`·`resolveModel`.

## model_catalog

입력은 없습니다. 출력은 `catalog_revision`과 `models` 배열이며 JSON 텍스트와 `structuredContent`로 같은 결과를 반환합니다.

각 모델의 필드는 `id`, `aliases`, `platform`(claude/codex), `contextTokens`, `maxOutputTokens`, `supportedEfforts`, `pricing`, `sourceUrls`, `evidence`, `checkedAt`, `excluded`, `recommendable`, `observed`입니다. 값은 모델별 `sourceUrls`의 공식 문서(Claude는 platform.claude.com, Codex 모델은 developers.openai.com)에서 확인한 것만 담습니다. `supportedEfforts`는 공식 단계이며 OpenAI 모델에는 `none`이 있을 수 있습니다. `pricing`은 가격 tier 배열이며 `promptTokens`는 tier가 적용되는 프롬프트 토큰 상한(`null`은 상한 없음)입니다. 캐시 쓰기 가격은 Claude 모델이 `cacheWrite5m`·`cacheWrite1h`, OpenAI 모델이 `cacheWrite30m`·`cacheWrite12h`이고, `input`·캐시 쓰기·`cacheRead`·`output`의 단위는 **USD/100만 토큰**입니다. 미확인 최대 출력·가격·확인일은 `null`입니다.

`observed`는 공식 문서로 확인되지 않은 Codex CLI 관측값(`contextTokens`·`defaultEffort`·`supportedEfforts`·`features`)과 그 근거 문서(`evidence`)·신뢰도(`confidence`)이며, 관측 기록이 없는 모델은 `null`입니다. 추천 규칙의 effort는 공식 `supportedEfforts` 안에서만 고르므로 관측값에만 있는 단계(예: `ultra`)는 추천에 쓰이지 않습니다.

제외된 모델도 목록에 남으며 `excluded`가 true이면 `recommendable`은 항상 false입니다. 온톨로지 읽기·스키마 검증 실패는 `isError` 응답입니다.

근거: `src/index.ts`의 `server.registerTool`의 `model_catalog` 등록, `src/ontology.ts`의 `modelCatalog`·`modelCatalogSchema`·`priceTier`·`observationNode`·`isRecommendable`.

## record_recommendation_feedback

추천 결과의 검증된 식별자와 수치형 결과·판정을 SQLite의 `recommendation_feedback` 테이블에 기록합니다. 입력 스키마는 strict이며 정의되지 않은 필드와 본문·설명 같은 자유 텍스트를 거부합니다.

- 필수 식별자: `event_id`는 UUID, `policy_version`·`catalog_revision`은 영문·숫자·점·하이픈으로 된 1~64자입니다. `rule_id`는 `rule:` 뒤에 소문자·숫자·하이픈 1~100자이며, `model`은 등록된 규칙의 모델 ID입니다. `effort`는 low/medium/high/xhigh/max/ultra, `role`은 recommend와 같은 열거형, `risk`는 normal/high, `verdict`는 pass/fail/inconclusive입니다.
- 필수 수치: `input_tokens`·`output_tokens`·`duration_ms`·`reverts`는 0 이상 9,007,199,254,740,991 이하의 안전 정수입니다. `cost_usd`는 유한한 0 이상 USD 값 또는 `null`이며 생략할 수 없습니다.
- 선택 신호: `size`(small/medium/large), `novelty`(new/existing), `cross_review_of`(앞뒤 공백 제거 후 1~100자인 등록된 ID 또는 유일한 별칭)입니다. 교차 검토 식별자는 대소문자 구분 없이 해석하고 저장 전에 정식 모델 ID로 정규화합니다.
- 검증: 현재 온톨로지의 `policy_version`·`catalog_revision`과 같아야 합니다. `rule_id`에 지정된 모델·effort와 일치하고 추천 가능한 모델이어야 합니다. 역할·위험도·규모·신규성·교차 검토 계열 등 규칙의 구조화 조건을 검사합니다. 자유 텍스트를 받지 않으므로 `keyword`·`difficulty`·`analysis` 조건은 재검사하지 않습니다.
- 응답과 중복: 처음 저장하면 `recorded: true`, `duplicate: false`입니다. 같은 `event_id`에 정규화된 같은 입력을 재전송하면 `recorded: true`, `duplicate: true`이며 중복 저장하지 않습니다. 같은 ID의 값이 다르거나 검증·저장에 실패하면 `isError`입니다. 읽기 전용 SQLite에는 기록할 수 없으며, file store에서는 도구가 등록되어 있어도 unsupported 오류를 반환합니다.
- 신뢰도: 같은 정책·카탈로그 버전의 규칙별 표본에서 inconclusive를 제외합니다. 성공은 pass이면서 되돌림이 0인 경우입니다. 내장 온톨로지의 `confidencePolicy`는 최소 20건·사전 가중치 20을 사용하며, 표본이 20건 미만이면 규칙의 사전 신뢰도, 20건 이상이면 `(20 × 사전 신뢰도 + 성공 수) / (20 + 표본 수)`입니다. 이 값은 같은 우선순위 안의 정렬에만 쓰입니다. 외부 온톨로지는 그 `confidencePolicy`를 따릅니다.

근거: `src/index.ts`의 `server.registerTool`의 `record_recommendation_feedback` 등록, `src/recommender.ts`의 `feedbackInputSchema`·`validateFeedback`·`resolveModel`·`calculateRuleConfidence`·`recommendModel`, `src/stores/sqlite-store.ts`의 `SqliteStore.recordRecommendationFeedback`·`SqliteStore.recommendationFeedbackStats`, `ontology/ontology.json`의 `confidencePolicy`.

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
