# 회상 트리거와 자동 회상

[README로](../README.md) · [설정](configuration.md) · [평가](evaluation.md)

## 세 가지 노출 채널

MCP 서버는 모델에 도구 호출을 강제하지 않습니다. `recall`은 모델이 선택해야 하므로 볼트에 무엇이 있는지 컨텍스트에 노출합니다.

서버의 행동 수칙은 작업 전에 recall, 지속할 사실을 얻으면 remember, 모순되면 revise/forget, 주기적으로 reflect입니다. 빈 회상에서도 저장할 사실이 있는지 별도로 판단합니다.

| 채널 | 내용 | 한계 |
|---|---|---|
| 서버 instructions | 행동 수칙, 볼트 상태·스코프, 제목·설명·타입 인덱스 | 서버 기동 시 스냅샷. 새 기억은 recall에는 즉시 반영되지만 이 인덱스는 재시작까지 고정 |
| Claude Code 세션 훅 | SessionStart 인덱스, 턴 시작 큐, Stop 무저장 감지 | 클라이언트 훅 지원과 설치 필요 |
| 네이티브 메모리 브리지 | 네이티브 `~/.claude/projects/<프로젝트>/memory/MEMORY.md`는 매 세션 자동 주입되며, 훅이 없는 클라이언트에서는 이 브리지가 유일한 자동 노출 경로 | 자동 동기화 기능이 아니며 사용자가 recall 안내·핵심 항목 목록을 관리 |

클라이언트 동작의 원자료는 `git show f402db4:README.md`의 **③ 네이티브 메모리 브리지** 절입니다. 네이티브 메모리의 자동 주입 전제와 별도 볼트가 필요한 경로 구분은 `src/vault.ts`의 `detectNativeMemoryFiles`에서도 확인할 수 있습니다.

채널을 병행할 수 있습니다. 세션 훅은 대화 컨텍스트에 단서를 제공하는 주 메커니즘입니다. 훅이 없으면 서버 instructions에 미설치 경고가 붙으며 `ASTRONRAG_HOOK_CHECK=0`으로 경고만 끌 수 있습니다. 저장 행동·클라이언트별 주입 효과를 보장하지는 않습니다. 근거: `src/index.ts`의 `computeHookWarning`, `src/index.ts`의 `buildInstructions` 및 `vaultState`, `scripts/session-guard.mjs`의 `mode`의 `start`·`prompt`·`stop` 분기.

## instructions 예산과 빈 볼트

서버 기본 문자 예산은 2,048자, 인덱스 최대 건수는 40입니다. `ASTRONRAG_INSTRUCTIONS_BUDGET`·`ASTRONRAG_INDEX_LIMIT`로 조정합니다. 인덱스 상한 0은 목록만 생략하고 스코프 안내는 남깁니다.

우선순위는 **볼트 경고 → 행동 수칙 → 볼트 상태·스코프 → 남는 예산의 인덱스**입니다. 상태는 블록 단위 전문·축약형을 사용하고, 버린 항목은 stderr에 알립니다. 도구 스키마의 description은 이 instructions 예산과 별개입니다. 빈 볼트에는 기억 인덱스 대신 즉시 저장을 유도하는 COLD START 지침을 보냅니다. 빈 검색은 기억할 사실이 없다는 증거가 아닙니다.

근거: `src/index.ts`의 `INDEX_LIMIT`, `src/index.ts`의 `buildInstructions`, `src/index.ts`의 `buildInstructions`의 `INSTRUCTIONS_BUDGET` 처리.

## 훅 설치와 제거

아래는 로컬 Claude 설정을 바꾸는 명령입니다. 프로젝트 루트에서 미리보기를 먼저 확인합니다.

```bash
npm run setup:hook -- --dry-run
npm run setup:hook
npm run setup:hook -- --remove
npm run setup:hook -- --vault <경로>
npm run setup:hook -- --settings <경로>
```

| 훅 | 역할 |
|---|---|
| `SessionStart` | MEMORY.md 인덱스와 볼트 출처·건수·나이 경고 주입 |
| `UserPromptSubmit` | 부호화 큐. 옵션 활성 시 읽기 전용 자동 회상 |
| `Stop` | 작업 세션의 새 기억 저장이 0건이면 경고 |

본체는 `scripts/session-guard.mjs`입니다. 등록 명령은 셸 표현식 대신 Node 실행 파일과 스크립트 인수를 사용하며 Node는 절대 경로로 등록합니다. 자동 postinstall 설치는 하지 않습니다.

설치기는 기존 설정에 병합하며 재실행 시 중복 등록하지 않습니다. 인식하는 셸 훅은 교체합니다. 저장 전 실행 검증, 타임스탬프 백업, 저장 후 JSON 재파싱 및 실패 시 복구를 수행하며 BOM이 있는 설정도 읽습니다. 훅은 오류 때문에 세션 종료를 막지 않도록 정상 종료 코드 0으로 마칩니다(`scripts/setup-hook.mjs`의 `applyHook`·`buildCommands`·`loadSettings`·`backup` 및 `bak` 저장·복구 분기, `scripts/session-guard.mjs`의 `mode`의 `start`·`prompt`·`stop` 분기).

설치 완료 안내에 따라 Claude를 재시작하면 SessionStart의 인덱스 주입, UserPromptSubmit의 부호화 큐·선택적 자동 회상, Stop의 무저장 감지가 적용됩니다. 세 훅은 같은 `session_id`의 세션별 마커로 상태를 공유합니다(`scripts/setup-hook.mjs`의 `buildCommands`·`results`·`REMOVE`, `scripts/session-guard.mjs`의 `markerPath`).

## 볼트 해석과 주입

훅은 실행 때마다 **환경 `ASTRONRAG_VAULT` → 프로젝트 `.mcp.json` → `~/.claude.json`의 해당 프로젝트 → 전역 → 설치 폴백** 순으로 서버 설정을 탐지합니다. `--vault`로 명시해 설치한 값은 자동 탐지보다 우선합니다. 주입 블록은 `<astronrag-index vault="..." memories="...">`로 출처를 밝힙니다. 서버와 훅이 같은 볼트를 가리키는지 확인합니다.

인덱스는 최대 200줄을 주입하며, 잘리면 총량과 나머지를 recall로 조회하라는 안내를 붙입니다. 빈 볼트에도 도구의 전체 이름이 있는 콜드 스타트 지침을 주입해 지연 로드된 도구를 찾도록 합니다. 기억이 있지만 인덱스를 못 읽으면 건수라도 알립니다. 볼트 디렉터리 자체가 없으면 침묵하므로 경로를 먼저 점검합니다.

인덱스 각 줄은 확신도와 마지막 갱신 후 나이를 표시하고 오래됐거나 검토일이 지난 항목은 ‘대조 필요’를 붙입니다. 인덱스는 검색의 출발점입니다. 원문과 현재 자료를 확인한 뒤 사실로 사용합니다. 근거: `scripts/session-guard.mjs`의 `resolveVault`, `scripts/session-guard.mjs`의 `mode` === "start" 분기의 인덱스·콜드 스타트 주입, `src/store.ts`의 `STALE_OVERRIDE` 및 `STALE_DAYS_BY_TYPE`.

## 무저장 감지

판정 기준은 mtime이 아닌 **선택한 저장소의 `inspect().memories` 증가**입니다. 파일 저장소는 `memories/`의 기억 수, SQLite는 보관 상태가 아닌 기억 수를 셉니다. 강화 쓰기는 신규 저장으로 세지 않으며 같은 구간의 보관 처리는 증가분을 줄일 수 있습니다. 세션 마커는 `sessionId`, `count`, `warned` 등을 보관합니다(`scripts/session-guard.mjs`의 `countMemories` 및 `readMarker`, `scripts/session-guard.mjs`의 `stored`의 저장 증가 판정).

마커 경로는 `<볼트>/.bbm/sessions/<sha256(session_id)>.json`으로 세션마다 파일 하나입니다. 입력 id·파일 안 id·해시 파일명이 모두 일치하고 기준 건수가 유효해야 추적합니다. 서로 다른 세션의 기준선·경고 여부·턴 수·주입 slug 목록은 별도 파일에 보관합니다(`scripts/session-guard.mjs`의 `sessionDirectory`·`markerPath`·`readMarker`).

- SessionStart는 startup·resume·clear·compact에서 발화할 수 있습니다. 유효한 마커가 있는 같은 `session_id`의 기준선은 보존합니다. `source`만으로 세션을 추정하지 않습니다.
- 빈 문자열·공백뿐인 id나 문자열이 아닌 id는 추적하지 않습니다. 깨진 stdin 입력 JSON도 추적하지 않으며 마커를 쓰지 않습니다. 입력이 없거나 시간 초과로 유효한 id를 얻지 못한 경우도 같습니다.
- 마커의 깨진 JSON·id 불일치·해시 파일명 불일치는 추적하지 않으며 prompt·stop에서 마커를 쓰지 않습니다. 유효한 id의 `--start`는 해당 세션의 유효한 마커가 없으면 새 기준선을 만듭니다.
- 구형 단일 마커 파일 `.bbm-session-start`는 읽지도 쓰지도 않습니다. 새 경로의 마커가 없는 세션은 유효한 id로 `--start`를 받아야 추적합니다.
- Stop은 추적 중인 세션에만 무저장 경고를 내며, 매 응답에 발화할 수 있지만 경고는 세션당 한 번만 냅니다. 출력은 `hookSpecificOutput`의 `hookEventName: "Stop"`, `additionalContext`에 넣은 JSON이며 종료 코드는 0입니다.
- 도구 호출이 기본 3회 이상일 때 경고합니다. `ASTRONRAG_STOP_MIN_TOOLS`로 조정하며 서브에이전트 위임 세션은 이 게이트를 통과합니다. 도구 호출 수를 측정할 수 없으면 게이트를 생략하고 경고합니다. 대화 줄 수는 기준이 아닙니다.
- stdin 이벤트의 `session_id`·`source`·`transcript_path`·`prompt`를 사용하고 입력은 최대 250ms 기다립니다. SessionStart의 인덱스 주입은 세션 추적 여부와 별개입니다.
- 유효한 id의 `--start` 때 마지막 갱신 후 7일을 초과한 세션 파일과 남은 임시 파일을 정리합니다. 같은 id의 재시작도 마커를 다시 써 갱신 시각을 유지하며, 정리 실패는 훅을 막지 않습니다.
- 쓰기는 같은 폴더의 임시 파일에 JSON을 쓴 뒤 rename합니다. Windows의 `EPERM`·`EBUSY`·`EACCES` 오류는 짧게 재시도하며, 쓰기 실패에도 기존 최종 JSON을 보존하고 훅을 막지 않습니다.

근거: `scripts/session-guard.mjs`의 `readHookInput`·`STDIN_TIMEOUT_MS`, `scripts/session-guard.mjs`의 `readMarker`·`sameSession`·`writeMarker`, `scripts/session-guard.mjs`의 `MARKER_RETENTION_MS`·`collectSessionMarkers`, `scripts/session-guard.mjs`의 `mode`·`MIN_TOOL_USES`·`toolUses`·`m`·`tool`.

## 부호화 큐

UserPromptSubmit에서 유효한 세션 마커가 있을 때만 정정·놀라움에 관한 정규식 신호 또는 마지막 저장 이후 기본 8턴 경과를 감지해 기억할 사항이 있는지 묻습니다. 큐는 정규식 추측임을 밝히고 출처·유형을 대신 단정하지 않습니다. **자동 저장하지 않습니다.** 같은 세션의 큐는 기본 15턴 쿨다운을 지킵니다. `ASTRONRAG_CUE_TURNS`·`ASTRONRAG_CUE_COOLDOWN`으로 조정합니다. 프롬프트가 없으면 어휘 신호 없이 턴 기준을 사용합니다(`scripts/session-guard.mjs`의 `readMarker`·`tracked`·`COOLDOWN`·`TURN_CUE`·`LEXICAL`·`lexicalHit`).

## 자동 회상

**기본 꺼짐, 전환 조건 미충족.** 설치된 UserPromptSubmit 훅이 사용자 프롬프트와 관련된 기억의 요약을 주입하는 기능입니다. 훅을 받는 셸에서만 선택적으로 켭니다.

```powershell
$env:ASTRONRAG_AUTO_RECALL = "1"
claude
```

사용자 환경에 지속 설정하려면 `setx ASTRONRAG_AUTO_RECALL 1`을 사용할 수 있으며 새 셸부터 적용됩니다. MCP 서버의 `env`에만 넣어서는 훅에 전달되지 않습니다.

- **질의:** 8자 미만 또는 `/`로 시작하는 프롬프트는 생략합니다. 백틱·틸드 코드 펜스를 제거한 앞 500자만 씁니다.
- **선택:** active이며 아직 같은 세션에서 주입하지 않은 결과 중 절대 점수 기본 9 이상이면서 활성 결과 1위 점수의 50% 이상인 최대 3건을 주입합니다. 1위 계산에는 이미 주입한 active 결과도 포함합니다.
- **형식:** 본문 없이 slug·설명·타입·확신도·나이를 넣으며 태그 포함 전체 예산은 기본 1,500자입니다. 낡음 판정은 recall과 같은 타입별 임계·검토일을 사용합니다.
- **중복:** 추적 중인 세션별 마커의 `autoSlugs`로 재주입을 막고 같은 id의 compact 시작 이벤트에서 다시 넣을 수 있게 비웁니다. 최근 200개 slug를 보관합니다. SessionStart 인덱스에 나온 기억도 자동 회상 대상입니다.
- **마커 없는 세션:** 해당 id의 유효한 마커가 없으면 조건을 충족하는 회상 블록만 출력하고 마커를 만들지 않습니다. 부호화 큐는 내지 않고 세션 중복 제외 상태·자동 회상 사용 로그를 기록하지 않으므로 다음 프롬프트에서 같은 기억을 다시 주입할 수 있습니다. 빈 id도 이 경로를 따릅니다.
- **출력:** `hookSpecificOutput`의 `hookEventName: "UserPromptSubmit"`, `additionalContext`에 넣은 JSON 하나입니다. 같은 턴의 부호화 큐는 회상 블록 뒤에 붙입니다.
- **읽기 전용 검색:** 영속 `.bbm-index/lexical.v2.json`을 읽습니다. 처음 6개 후보부터 필요할 때 범위를 늘려 저장소 신원이 달라진 기억과 삭제된 기억을 제외합니다. 파일 저장소는 파일 stat을 대조하고, SQLite는 `getIdentity`로 내용 해시를 대조하여 강화 메타데이터만 바뀐 기억은 유지합니다. 색인이 없거나 손상됐으면 침묵합니다. 색인을 고쳐 쓰거나 벡터·무거운 파서를 로드하지 않습니다. 세션 마커·사용 로그 기록은 검색과 별개입니다.
- **강화 없음:** 자동 주입으로 storage_strength·last_accessed를 바꾸지 않습니다. 추적 중인 세션의 사용 이벤트에는 `tool: auto_recall`, sessionId·injected 건수·topScore를 기록하며 프롬프트는 남기지 않습니다. 사용 로그를 끄면 이 이벤트도 남기지 않습니다.

서버를 띄우지 않은 볼트는 색인이 없고, 서버가 꺼진 동안 추가한 기억은 색인 동기화 전까지 잡히지 않습니다. 직접 수정한 파일이나 내용이 바뀐 SQLite 기억은 색인과 신원이 달라져 제외됩니다. 점수 방식과 하한, 프로젝트·낡음 설정은 [훅 환경변수](configuration.md#훅-환경변수)를 확인합니다.

근거: `scripts/session-guard.mjs`의 `autoRecall`, `scripts/session-guard.mjs`의 `autoRecall`의 `eligible`·`picked` 선택, `scripts/session-guard.mjs`의 `autoRecall`의 `AUTO_BUDGET` 적용, `scripts/session-guard.mjs`의 `readMarker`·`tracked`·`AUTO_SLUG_KEEP`·`sameSession`·`emitPrompt`·`logUsage`, `src/retriever.ts`의 `LexicalRetriever.openReadOnly` 및 `LexicalRetriever.isCurrent`.

클라이언트의 실제 컨텍스트 주입 효과는 별도 확인이 필요합니다. CLI·데스크톱 Code 탭·VS Code 확장 각각에 대해 동일한 동작을 보장하지 않습니다. 스크립트 출력 형식의 회귀 시험과 클라이언트 끝단 실측을 구별합니다. 오탐·지연과 기본 꺼짐의 근거는 [조건별 참고 결과](evaluation.md#조건별-참고-결과)를 참고합니다.

| 클라이언트 | 자동 회상 주입 | 비고 |
|---|---|---|
| Claude Code CLI | 미실측 | 훅 스크립트 단독 출력 형식은 회귀 시험으로 확인 |
| 데스크톱 앱 Code 탭 | 미실측 | |
| VS Code 확장 | 미실측 | `UserPromptSubmit` 주입이 누락된다는 보고가 있음(이슈 #49063) |
