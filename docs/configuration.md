# 설정

[README로](../README.md) · [회상 트리거](recall-triggers.md) · [운영](operations.md)

## 서버 환경변수

MCP 클라이언트가 서버에 전달하는 환경에 지정합니다. 서버 환경변수를 바꾸면 MCP 서버를 재시작해야 적용됩니다(`src/store.ts`의 `SCORER`, `src/index.ts`의 `INDEX_LIMIT`, `src/usage.ts`의 `DISABLED`). 상대 경로의 `ASTRONRAG_VAULT`·`ASTRONRAG_SQLITE_PATH`는 프로세스 작업 폴더 기준입니다. 볼트 기본값은 서버가 설치된 저장소의 `vault`입니다.

| 변수 | 기본값 | 적용과 코드 근거 |
|---|---|---|
| `ASTRONRAG_VAULT` | `<저장소>/vault` | 저장소 루트. 명시 경로에 기억·마커가 없으면 경고. `src/index.ts`의 `vaultOverride` 및 `vaultDir` |
| `ASTRONRAG_STORE` | `sqlite` | `sqlite` 또는 `file`. 다른 값은 오류. `src/stores/index.ts`의 `createMemoryStore` |
| `ASTRONRAG_SQLITE_PATH` | `<볼트>/.bbm/store.sqlite` | SQLite 저장소 선택 시에만 DB 경로로 적용. FileStore에서는 읽지 않음. `src/stores/index.ts`의 `STORE_FACTORIES`의 sqlite 항목, `src/stores/index.ts`의 `STORE_FACTORIES`의 file 항목 |
| `ASTRONRAG_ONTOLOGY_PATH` | 내장 `ontology/ontology.json` | `recommend`·`model_catalog`·`record_recommendation_feedback`가 함께 읽는 온톨로지 경로. 빈 값은 내장 설정. `src/index.ts`의 `ontologyOverride`·`ontologyPath` 및 `server.registerTool`의 각 도구 등록 |
| `ASTRONRAG_PROJECT` | 설정 없음 | 기본 조회 스코프. 공백 제거 후 빈 값은 전체. `src/index.ts`의 `DEFAULT_PROJECT` |
| `ASTRONRAG_SYNONYMS` | 추가 없음 | `대표어=동의어1,동의어2;대표어2=동의어3`. 내장 사전과 합쳐 양방향 확장. 예: `사내망=intranet,internalnet;웹메일=webmail`. `src/store.ts`의 `SYNONYM_INDEX` |
| `ASTRONRAG_INDEX_LIMIT` | `40` | instructions의 인덱스 최대 건수. `0`은 목록 생략, 스코프 안내 유지. `src/index.ts`의 `INDEX_LIMIT` |
| `ASTRONRAG_INSTRUCTIONS_BUDGET` | `2048` | instructions 전체 문자 예산. 양수만 허용. `src/index.ts`의 `INSTRUCTIONS_BUDGET` |
| `ASTRONRAG_HOOK_CHECK` | 켜짐 | `0`이면 훅 미설치 경고 생략. `src/index.ts`의 `computeHookWarning` |
| `ASTRONRAG_ALWAYS_LOAD` | 켜짐 | `0`이면 remember·recall의 `anthropic/alwaysLoad` 메타데이터 생략. 클라이언트의 해석에 달림. `src/index.ts`의 `ALWAYS_LOAD` |
| `ASTRONRAG_STALE_DAYS` | episodic 14 / semantic 60 / procedural 60 / preference 180일 | 지정하면 전 타입 단일 낡음 임계. `review_after` 경과는 별도 적용. `src/store.ts`의 `STALE_OVERRIDE` 및 `STALE_DAYS_BY_TYPE` |
| `ASTRONRAG_SPACING_MS` | `600000` | 강화 최소 간격의 바닥값, 10분. `src/store.ts`의 `SPACING_WINDOW_MS` |
| `ASTRONRAG_SPACING_ALPHA` | `0.1` | 필요 간격 = `max(바닥값, α·나이/저장강도)`. `0`이면 고정 창. `src/store.ts`의 `SPACING_ALPHA` |
| `ASTRONRAG_WEAKENED_GRACE_H` | `72`시간 | 더 어린 기억은 reflect의 약화 후보에서 제외. `src/store.ts`의 `WEAKENED_GRACE_MS` |
| `ASTRONRAG_WEAKENED_RATIO` | `0.2` | 활성 하위 비율 상한. `0`은 약화 후보 끔, 범위 0~1. `src/store.ts`의 `WEAKENED_RATIO` |
| `ASTRONRAG_FLUSH_EVERY_ACCESS` | 꺼짐 | `1`·`true`·`yes`(대소문자 무관)는 간격 게이트가 닫혀도 접근 메타데이터 기록. `src/store.ts`의 `FLUSH_EVERY_ACCESS` |
| `ASTRONRAG_SCORER` | `legacy` | 정확히 `bm25f`일 때만 BM25F. `src/store.ts`의 `SCORER` |
| `ASTRONRAG_SHADOW` | 켜짐 | 서버의 legacy 회상에서 BM25F 상위 목록 일치율 계측. `0`은 끔, scorer가 bm25f여도 끔. `src/store.ts`의 `SHADOW`, `src/store.ts`의 `MemoryService.searchDetailed`의 `shadowAgreement` 호출 |
| `ASTRONRAG_ALT_WEIGHT` | `0.7` | 서버 회상의 변형 질의 가중. 0 초과 1 이하. 평가 스크립트에서 환경값은 지우고 `--alt-weight` 인수로 지정한 값을 사용하며, 생략 시 `0.7`. `src/store.ts`의 `ALT_QUERY_WEIGHT`, `src/store.ts`의 `MemoryService.searchDetailed`의 `fuseWeightedMax` 호출, `scripts/eval-retrieval.mjs`의 `opts.altWeight`의 환경변수 설정 분기 |
| `ASTRONRAG_VECTOR` | 꺼짐 | 정확히 `1`일 때만 벡터 모듈 동적 로드. `src/index.ts`의 `main`의 `ASTRONRAG_VECTOR` 분기 |
| `ASTRONRAG_USAGE_LOG` | 켜짐 | `0`이면 서버 도구 사용 로그를 끔. 저장소로 직접 쓰는 강화 실패 이벤트에는 적용되지 않음. `src/usage.ts`의 `DISABLED`, `src/usage.ts`의 `logUsage`, `src/store.ts`의 `MemoryService.reinforce`의 강화 실패 분기 |
| `ASTRONRAG_LOG_QUERIES` | 꺼짐 | `1`·`true`·`yes`(대소문자 무관)일 때 서버 recall의 질의문 기록. 훅에는 질의문 기록 경로 없음. 민감한 질의는 활성화 전 확인. `src/usage.ts`의 `LOG_QUERIES`, `src/usage.ts`의 `queryField`, `src/index.ts`의 `server.registerTool`의 `recall` 등록·`queryField` 호출, `scripts/session-guard.mjs`의 `logUsage`의 `auto_recall` 호출 |
| `ASTRONRAG_USAGE_LOG_MAX_BYTES` | `5242880` (5MiB) | 사용 로그 상한(바이트). FileStore·SqliteStore·서버·훅에 모두 적용. 미설정·0·음수·비정수 값은 기본값. FileStore는 초과 시 `.old`로 회전, SqliteStore는 `usage_events` 페이로드 바이트 합이 상한을 넘으면 오래된 행부터 삭제. `src/env.ts`의 `usageLogMaxBytes`, `src/stores/file-store.ts`의 `FileStore.appendUsageEvent`, `src/stores/sqlite-store.ts`의 `insertUsageRow` |

서버는 `initUsageLog(vault)`로 저장소 객체를 넘기므로(`src/index.ts`의 `initUsageLog(vault)` 호출) 사용 이벤트를 해당 저장소에 위임합니다. FileStore는 `<볼트>/.bbm-usage.jsonl`을 쓰며, 다음 기록 직전에 기존 파일 크기가 `ASTRONRAG_USAGE_LOG_MAX_BYTES`를 초과했으면 `.old`로 순환합니다(`src/stores/file-store.ts`의 `FileStore.appendUsageEvent`). SQLite는 `usage_events`에 삽입하며 삽입한 행 번호가 64의 배수일 때 같은 트랜잭션에서 페이로드 바이트 합이 상한을 넘은 오래된 행을 삭제하고 최신 행은 남깁니다(`src/stores/sqlite-store.ts`의 `insertUsageRow`). 합산 비용을 줄이려고 64건마다만 계산하므로 삭제 사이에 상한을 최대 64행 분량까지 넘을 수 있습니다. 훅도 선택한 저장소에 직접 위임하므로 같은 동작입니다(`scripts/session-guard.mjs`의 `logUsage`의 `selectedStore.appendUsageEvent` 호출).

저장소 없이 `initUsageLog(볼트 경로 문자열)`로 초기화한 `src/usage.ts`의 직접 파일 기록 경로도 같은 값을 읽습니다(`src/usage.ts`의 `MAX_BYTES`, `src/usage.ts`의 `logUsage`의 `logPath` 분기). 값은 모두 `src/env.ts`의 `usageLogMaxBytes`가 읽으며, 호환 별칭 `BIGBRAIN_USAGE_LOG_MAX_BYTES`도 같은 규칙을 따릅니다.

호환 별칭 `BIGBRAIN_VAULT`·`BIGBRAIN_PROJECT`·`BIGBRAIN_SYNONYMS`·`BIGBRAIN_INDEX_LIMIT`·`BIGBRAIN_INSTRUCTIONS_BUDGET`·`BIGBRAIN_HOOK_CHECK`·`BIGBRAIN_ALWAYS_LOAD`·`BIGBRAIN_STALE_DAYS`·`BIGBRAIN_SPACING_MS`·`BIGBRAIN_SPACING_ALPHA`·`BIGBRAIN_WEAKENED_GRACE_H`·`BIGBRAIN_WEAKENED_RATIO`·`BIGBRAIN_FLUSH_EVERY_ACCESS`·`BIGBRAIN_SCORER`·`BIGBRAIN_SHADOW`·`BIGBRAIN_ALT_WEIGHT`·`BIGBRAIN_VECTOR`·`BIGBRAIN_USAGE_LOG`·`BIGBRAIN_LOG_QUERIES`·`BIGBRAIN_USAGE_LOG_MAX_BYTES`·`BIGBRAIN_AUTO_RECALL`·`BIGBRAIN_AUTO_MIN_SCORE`·`BIGBRAIN_AUTO_BUDGET`·`BIGBRAIN_CUE_TURNS`·`BIGBRAIN_CUE_COOLDOWN`·`BIGBRAIN_STOP_MIN_TOOLS`는 같은 접미사의 `ASTRONRAG_*`에 대응하고, `BBM_STORE`→`ASTRONRAG_STORE`·`BBM_SQLITE_PATH`→`ASTRONRAG_SQLITE_PATH`·`BBM_ONTOLOGY_PATH`→`ASTRONRAG_ONTOLOGY_PATH`도 지원하며, 공식 이름이 정의되어 있으면 빈 문자열이라도 우선하고 별칭을 대체값으로 쓰면 프로세스당 한 번 안내합니다(`src/env.ts`의 `readEnv`). 안내는 stderr에만 출력하며 MCP stdout에는 쓰지 않습니다(`src/env.ts`의 `readEnv`의 `LEGACY_WARNING_SYMBOL` 경고 분기).

## 숫자와 빈 문자열

대부분의 서버 숫자 설정은 `Number(값)`으로 해석합니다. **빈 문자열·공백은 0**이므로 `SPACING_MS`·`SPACING_ALPHA`·`INDEX_LIMIT`·`STALE_DAYS`·`WEAKENED_GRACE_H`·`WEAKENED_RATIO`에 0으로 적용될 수 있습니다. 기본값을 원하면 변수를 지정하지 않습니다. 숫자가 아니거나 허용 범위를 벗어나면 기본값을 사용합니다.

예외: `ASTRONRAG_ALT_WEIGHT`·`ASTRONRAG_AUTO_MIN_SCORE`는 빈 값도 기본값으로, 양수가 필요한 예산·로그 크기·큐 간격 역시 빈 값은 기본값으로 처리합니다. 허용 범위는 위 표와 아래 표를 따릅니다.

## 훅 환경변수

훅은 별도 Node 프로세스입니다. **MCP 서버 `env`만 설정해서는 자동 회상이 켜지지 않습니다.** Claude Code를 실행하는 셸 등 훅에 상속되는 환경에 지정합니다. 볼트와 프로젝트는 등록 설정에서 탐지할 수도 있습니다.

| 변수 | 기본값 | 적용과 코드 근거 |
|---|---|---|
| `ASTRONRAG_STORE` | `sqlite` | 훅이 열 저장소. MCP 등록의 env에서 자동 탐지하지 않으므로 훅 환경에 지정. `scripts/session-guard.mjs`의 `selectedStore` 초기화의 `createMemoryStore` 호출 |
| `ASTRONRAG_SQLITE_PATH` | `<볼트>/.bbm/store.sqlite` | 훅 환경에서 지정하는 SQLite 경로. 서버와 같은 DB를 가리켜야 함. `src/stores/index.ts`의 `STORE_FACTORIES`의 sqlite 항목 |
| `ASTRONRAG_AUTO_RECALL` | 꺼짐 | 정확히 `1`일 때만 활성. 검색은 읽기 경로이며, 검색 완료 시(주입 0건 포함) 유효한 session_id의 `auto_recall` 사용 이벤트를 마커 유무와 관계없이 별도로 기록. `scripts/session-guard.mjs`의 `autoRecall`·`selectedStore` 초기화·`logUsage` |
| `ASTRONRAG_AUTO_MIN_SCORE` | `9` | 0 이상 유한수. 빈 값은 기본값. legacy 척도이며 BM25F 사용 시 다시 정함. `scripts/session-guard.mjs`의 `AUTO_MIN_SCORE` |
| `ASTRONRAG_AUTO_BUDGET` | `1500`자 | 태그 포함 전체 블록 상한. 양수의 정수부 사용. `scripts/session-guard.mjs`의 `AUTO_BUDGET` |
| `ASTRONRAG_CUE_TURNS` | `8` | 마지막 저장 뒤 부호화 큐를 낼 턴 임계. 양수만 허용. `scripts/session-guard.mjs`의 `TURN_CUE` |
| `ASTRONRAG_CUE_COOLDOWN` | `15` | 부호화 큐 사이 최소 턴 간격. 양수만 허용. `scripts/session-guard.mjs`의 `COOLDOWN` |
| `ASTRONRAG_STOP_MIN_TOOLS` | `3` | 무저장 경고를 낼 최소 도구 호출 수. 0 이상이며 빈 문자열·공백은 0으로 적용되어 도구 호출 수 게이트를 생략. `scripts/session-guard.mjs`의 `MIN_TOOL_USES`, `scripts/session-guard.mjs`의 `MIN_TOOL_USES`·`toolUses` 게이트 분기 |
| `ASTRONRAG_PROJECT` | 등록 설정 또는 설정 없음 | 공백이 아닌 환경값 우선. 이후 프로젝트 `.mcp.json` → 사용자 설정의 해당 프로젝트 → 전역 설정 순으로 첫 서버를 선택하고 그 `project`를 사용. 해당 서버에 값이 없으면 전체 조회로 뒤 설정 탐색 중단. `scripts/session-guard.mjs`의 `resolveProject` |
| `ASTRONRAG_STALE_DAYS` | 서버와 같은 타입별 값 | 훅 환경에서 지정. 서버에만 설정하면 훅은 타입별 값을 사용. `scripts/session-guard.mjs`의 `autoRecall`의 공유 store 모듈 로드, `src/store.ts`의 `STALE_OVERRIDE` 및 `STALE_DAYS_BY_TYPE` |
| `ASTRONRAG_SCORER` | `legacy` | 훅이 불러온 공유 어휘 검색기의 점수 방식. 훅 환경에서 지정하며 서버 설정과 별개. `src/store.ts`의 `SCORER`, `src/store.ts`의 `searchPersistedIndex`, `scripts/session-guard.mjs`의 `autoRecall`의 `searchPersistedIndex` 호출 |
| `ASTRONRAG_USAGE_LOG` | 켜짐 | 훅 프로세스 환경에서 `0`이면 훅 사용 로그를 끔. 서버의 환경 설정과 별개. 유효한 session_id가 없으면 기록하지 않으며, 자동 회상 검색 완료 시 마커 없는 id도 기록 대상. SQLite 기록은 125ms 재시도 예산으로 시도하며 실패해도 회상 출력·종료 코드 0을 유지. `scripts/session-guard.mjs`의 `logUsage`·`USAGE_WRITE_TIMEOUT_MS`·`emitPrompt`, `src/stores/sqlite-store.ts`의 `SqliteStore.appendUsageEvent` |

## 프로젝트 스코핑

- `project` 없는 기억은 전역이며 특정 프로젝트를 조회해도 함께 반환됩니다.
- `recall`·`list_memories`는 서버의 기본 프로젝트를 따릅니다. `project: ""`로 전체를 조회합니다. 서버 설정도 없으면 전체 조회입니다.
- **`remember`는 `project` 생략 시 전역으로 저장**합니다. 조회 스코프를 저장에 자동 적용하지 않습니다.
- `read_memory`·`revise`·`forget`·`link`는 id/슬러그로 지정하고 `reflect`는 볼트 전체를 보므로 조회 스코프를 적용하지 않습니다. 스코핑은 접근 권한 경계가 아닙니다.
- 볼트를 프로젝트별로 분리할 수도 있지만, 전역 기억도 함께 분리됩니다.

```json
{
	"mcpServers": {
		"astronrag": {
			"command": "node",
			"args": ["<설치 경로>/dist/index.js"],
			"env": { "ASTRONRAG_PROJECT": "my-app" }
		}
	}
}
```

볼트 경로를 지정하려면 서버 `env`에 `ASTRONRAG_VAULT`를 추가합니다. Claude Code CLI에서는 `claude mcp add --scope user -e ASTRONRAG_VAULT="./vault" astronrag -- node "<설치 경로>/dist/index.js"`처럼 등록할 수 있습니다. 새 빈 경로의 첫 경고는 경로 확인을 위한 것이며, 기억이 생기면 해소됩니다. 경로를 바꿀 때는 루트 전체를 이동합니다.
