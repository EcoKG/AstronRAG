# 운영과 이관

[README로](../README.md) · [설정](configuration.md) · [도구](tools.md)

## 저장소 선택

기본은 SQLite(`ASTRONRAG_STORE=sqlite`), Markdown은 `ASTRONRAG_STORE=file`입니다. SQLite의 기본 DB는 `<볼트>/.bbm/store.sqlite`입니다. Markdown 파일 편집이나 뷰어 내보내기는 **파일 저장소 데이터**에 적용합니다. SQLite DB를 쓰면서 `memories/*.md`만 편집해도 DB의 기억이 바뀌지는 않습니다.

SQLite 테이블은 기억과 부속 데이터용 `memories`·`memory_tags`·`memory_links`·`memory_history`·`memory_derived_from`·`memory_revisions`, 사용 이벤트용 `usage_events`, 벡터용 `embeddings`, 메타데이터용 `store_meta`, 추천 피드백용 `recommendation_feedback`입니다. 추천 피드백에는 검증된 식별자·구조화 신호·수치형 결과·판정과 생성 시각을 저장하며 본문·설명은 저장하지 않습니다. file store에서 `record_recommendation_feedback`를 호출하면 unsupported 오류입니다. 입력·중복·신뢰도 반영 조건은 [피드백 도구](tools.md#record_recommendation_feedback)를 따릅니다.

근거: `src/stores/sqlite-store.ts`의 `SqliteStore.constructor`·`SqliteStore.recordRecommendationFeedback`·`SqliteStore.recommendationFeedbackStats`, `src/index.ts`의 `server.registerTool`의 `record_recommendation_feedback` 등록.

## MCP 도구 노출 확인

빌드한 서버를 사용하도록 MCP 클라이언트의 실행 경로를 확인하고 서버 프로세스를 재시작한 뒤 재연결합니다. 클라이언트의 도구 목록에서 11개 도구와 `model_catalog`·`record_recommendation_feedback`를 확인합니다. 두 도구는 저장소 종류·온톨로지 유효성과 관계없이 등록되며, 호출 시의 지원 여부·오류는 [도구 문서](tools.md)를 따릅니다.

근거: `src/index.ts`의 `server.registerTool`의 각 도구 등록·`main`, `scripts/regress-mcp-config.mjs`의 `expected`.

## Markdown에서 SQLite로 이관

운영 MCP 프로세스를 멈추고 실행합니다. 아래 경로를 실제 경로로 바꿉니다.

```bash
npm run migrate:vault -- --vault <vault> --store-path <db> --dry-run
npm run migrate:vault -- --vault <vault> --store-path <db>
```

원본은 읽기 전용으로 다룹니다. DB를 열기 전에 볼트 사본과 파일별 SHA-256 manifest를 볼트·저장소 밖에 만들고 사본 해시를 검증합니다. 기본 백업은 `%LOCALAPPDATA%/AstronRAG/backups/<UTC 시각>`이며 `--backup-dir <경로>`로 지정할 수 있습니다. `LOCALAPPDATA`가 없으면 명시해야 합니다. 검증된 백업은 자동 삭제하지 않습니다. 완료를 확인한 뒤 서버를 SQLite 설정으로 시작합니다. 원본 Markdown으로 복귀하려면 `ASTRONRAG_STORE=file`로 시작합니다. 전환 뒤 DB에서 생긴 변경은 원본 파일에 자동 반영되지 않으므로 먼저 내보내기를 검토합니다.

근거: `scripts/migrate-vault-to-store.mjs`의 `parseCli`·`createBackup`·`runMigration`, `src/stores/index.ts`의 `validMigrationTimestamp` 및 `requiresVaultMigration`.

## SQLite에서 Markdown으로 내보내기

```bash
node scripts/export-store-to-vault.mjs --store-path ./data/store.sqlite --dry-run
node scripts/export-store-to-vault.mjs --store-path ./data/store.sqlite --out ./vault-export
```

DB를 읽기 전용으로 열어 새 Markdown 볼트로 내보냅니다. `--out` 생략 시 현재 작업 폴더 아래 고유한 새 폴더를 사용합니다. 출력은 작업 폴더 안의 빈 폴더만 허용하며 운영 볼트·원본 DB 디렉터리와 겹치는 경로, 링크를 거부합니다. `--dry-run`은 전체 검증과 예상 건수만 출력하고 파일을 만들지 않습니다.

기억·보관 기억·교정 스냅샷·사용 이벤트·벡터를 보존합니다. 손상 행이나 볼트 형식으로 손실 없이 표현할 수 없는 값은 쓰기 전에 실패합니다. 벡터는 단일 모델·같은 차원만 지원합니다. 출력 폴더를 확인한 뒤 FileStore 경로로 사용합니다. 근거: `scripts/export-store-to-vault.mjs`의 `defaultOut`·`parseCli`·`exportStoreToVault`, `src/stores/sqlite-store.ts`의 `SqliteStore.integrityCheck`.

`recommendation_feedback`는 Markdown 볼트로 내보내지 않습니다. 추천 피드백을 보존하려면 원본 SQLite DB도 보관합니다. 근거: `src/stores/sqlite-store.ts`의 `SqliteStore.exportVaultSnapshot`, `scripts/export-store-to-vault.mjs`의 `exportStoreToVault`.

## Markdown 볼트 구조

```text
vault/
├── MEMORY.md                 자동 생성 인덱스
├── .bigbrain-vault           볼트 마커
├── memories/                 활성·대체 기억, 한 기억당 Markdown 하나
├── archive/                  보관 기억
│   └── revisions/            교정 직전 구본, 기억당 최근 3세대
├── quarantine/               손상 파일 원본
├── .bbm/                     훅 세션 상태
│   └── sessions/             <sha256(session_id)>.json
└── .bbm-index/               파생 검색 캐시
```

`memories/`·`archive/`는 초기화 시 생성하며 revisions·quarantine은 필요한 상황에 만듭니다. 파일명과 점 디렉터리는 저장 형식의 일부입니다. 이동할 때는 `MEMORY.md`, 마커와 점 파일을 포함한 루트 전체를 옮깁니다. Obsidian 그래프에서 활성 기억만 보려면 archive·quarantine을 필터에서 제외합니다(`src/vault.ts`의 `Vault.constructor`, `src/vault.ts`의 `Vault.snapshotRevision`).

`.bbm/sessions/`는 저장소 종류와 별개로 훅이 유효한 `session_id`의 시작 기준선을 기록할 때 만듭니다. 세션별 마커에는 기준 건수·경고 여부·턴 수·자동 회상 주입 slug 목록을 보관합니다. 유효한 id의 시작 이벤트에서 마지막 갱신 후 7일을 초과한 세션 파일·임시 파일을 정리합니다(`scripts/session-guard.mjs`의 `sessionDirectory`·`markerPath`·`markerDirectoryReady`·`readMarker`·`writeMarker`·`collectSessionMarkers`).

공개 픽스처 [perf-profile-node.md](../eval/fixture-vault/memories/perf-profile-node.md)의 원문 예시입니다. 타임스탬프는 UTC ISO, history의 날짜는 로컬 날짜입니다.

```markdown
---
id: mem-fx059
title: "Profile a Node service"
description: "Run with --cpu-prof and open the profile in Chrome DevTools"
type: procedural
tags:
  - "profiling"
  - "node"
  - "cpu"
confidence: 0.95
storage_strength: 2
status: active
created: '2026-05-24T05:00:00.000Z'
updated: '2026-05-31T05:00:00.000Z'
last_accessed: '2026-05-31T05:00:00.000Z'
last_reinforced: '2026-05-31T05:00:00.000Z'
access_count: 5
links: []
history:
  - "2026-05-24: created"
---

Start the service with node --cpu-prof, reproduce the slow path, stop it, and load the .cpuprofile file in Chrome DevTools.
```

선택 필드: `source`, `project`, `review_after`, `derived_from`, `supersedes`, `superseded_by`, `archive_reason`. 근거: `src/vault.ts`의 `Vault.serialize`의 선택 frontmatter 필드, `src/types.ts`의 `MemoryRecord`.

## 볼트를 직접 편집할 때

Markdown 저장소는 직접 편집할 수 있습니다. 다음 계약을 지킵니다.

- `created: 2026-10-01` 같은 인용부호 없는 YAML 날짜도 보존됩니다.
- 알려진 frontmatter 키만 읽습니다. 임의 키(예: `cssclass`)는 다음 저장에서 사라지므로 보존할 정보는 본문에 둡니다.
- `MEMORY.md`는 쓰기 연산으로 재생성되는 인덱스이므로 직접 편집하지 않습니다. 내용이 같으면 다시 쓰지 않습니다.
- 빈 파일, 닫는 `---`가 없는 파일, frontmatter 파싱 실패 파일은 `quarantine/<slug>.<타임스탬프>.md`로 이동합니다. 원본 바이트를 보존하고 다른 기억은 계속 읽습니다. 기동 시 `quarantined=N(!)`으로 알립니다. 고친 뒤 `memories/`로 복귀시킬 수 있습니다.

근거: `src/vault.ts`의 `Vault.serialize` 및 `Vault.writeIndex`, `src/vault.ts`의 `Vault.read`의 `quarantine` 분기, `src/vault.ts`의 `Vault.fromFrontmatter`, `src/index.ts`의 `main`의 `quarantined` 경고 분기.

## 잘못된 교정 복구

`revise`는 **본문이 바뀔 때만** 교정 직전 원본을 보관합니다. 확신도만 조정하는 재확인은 스냅샷을 만들지 않습니다. 기억당 최근 3세대이며 4번째에는 가장 오래된 세대가 제거됩니다. 파일 저장소는 `archive/revisions/<slug>.<타임스탬프>.md`에 둡니다. 원하는 세대를 `memories/<slug>.md`로 복사해 복구합니다. 파일명 사전순으로 시각을 정렬할 수 있습니다.

SQLite는 스냅샷을 DB의 `memory_revisions`에 저장합니다. 파일 복구 절차가 필요한 경우 DB를 Markdown으로 내보내고 결과를 확인합니다. 3세대 스냅샷은 별도 백업을 대체하지 않습니다. 파일 볼트는 별도 Git 저장소로 관리하고 주기적으로 백업할 수 있습니다. 근거: `src/store.ts`의 `MemoryService.revise`의 `contentChanged` 분기, `src/vault.ts`의 `Vault.snapshotRevision`, `src/stores/sqlite-store.ts`의 `SqliteStore.snapshotRevision`.

## 네이티브 메모리에서 이관

Claude Code 프로젝트별 `memory/*.md`를 **별도 볼트**로 가져옵니다. 네이티브 memory 폴더 자체를 `ASTRONRAG_VAULT`로 지정하지 않습니다. 레이아웃이 다르며 서버는 `node_type: memory`·`originSessionId` 등 내용으로 감지해 인덱스·마커를 건드리지 않고 경고합니다.

```bash
npm run import:native
npm run import:native -- --apply
```

기본 실행은 미리보기이며 쓰지 않습니다. `--projects-dir <경로>`, `--vault <경로>`, `--project-map <슬러그>=<이름>`을 지정할 수 있으며 프로젝트 매핑은 반복 지정할 수 있습니다. **원본 노트는 유지**하며 `source`의 원본 경로로 중복 이관을 건너뜁니다.

| 네이티브 유형 | 매핑 |
|---|---|
| user | preference |
| feedback | 실행 지침이 있으면 procedural, 아니면 preference |
| project | 사건·시점이면 episodic, 아니면 semantic |
| reference | procedural |

타입 선정 이유를 출력하므로 확인한 뒤 `revise`로 교정할 수 있습니다. 제목은 네이티브 인덱스의 표시 제목을 우선하고 없으면 `name`을 사용합니다. 연결은 확정된 새 슬러그로 재작성합니다. 실제 이관에서 슬러그 변경이 있어 연결 재작성 처리를 거치면 남은 깨진 링크 수를 보고합니다(`scripts/import-native.mjs`의 `renamed`의 링크 재작성 분기, `scripts/import-native.mjs`의 `dangling` 및 `store.reflect` 호출). 프로젝트명은 등록된 실제 경로에서 역매핑하고 실패 시 슬러그와 사유를 출력합니다. 명시한 `--project-map`이 역매핑보다 우선하며 같은 슬러그를 반복 지정하면 마지막 값이 적용됩니다. 네이티브 인덱스에는 recall 안내와 핵심 목록을 담은 [브리지](recall-triggers.md#세-가지-노출-채널)를 둘 수 있습니다.

근거: `scripts/import-native.mjs`의 `renamed`, `scripts/import-native.mjs`의 `titlesByProject` 및 `resolveProjectName`, `scripts/import-native.mjs`의 `renamed`의 링크 재작성 분기, `src/vault.ts`의 `detectNativeMemoryFiles`.

## 웹 뷰어

```bash
npm run viewer:export
```

`ASTRONRAG_VAULT`(설정이 없으면 저장소의 `vault`)의 `memories/`·`archive/` 바로 아래 Markdown을 `viewer/data.js`로 내보냅니다. `viewer/index.html`을 브라우저로 열면 됩니다. 별도 서버·빌드는 필요하지 않습니다. 데이터가 없으면 **볼트 폴더 열기**나 파일 선택으로 같은 파서를 사용할 수 있습니다. SQLite DB를 직접 읽는 뷰어가 아니므로 DB 기억은 내보내기를 거칩니다.

목록, 제목·설명·태그·본문 검색, 유형·상태·프로젝트 필터, 본문 렌더링, 위키링크·links·supersedes·derived_from 이동을 제공합니다. 3D와 글꼴은 CDN에서 받으며 오프라인에서도 목록·상세는 동작합니다. 편집 기능은 없습니다. 현재 테마는 고정 다크입니다.

`viewer/data.js`에는 원문이 들어 있으며 Git 제외 대상입니다. 캡처나 공유가 끝나면 제거합니다. README 캡처는 운영 볼트가 아닌 `eval/fixture-vault`의 임시 사본만 사용합니다. 근거: `scripts/export-viewer-data.mjs`의 `vaultEnv` 및 `vaultDir`, `viewer/app.js`의 `boot`·`readFiles`·`runSearch`·`renderInspector`, `viewer/index.html`의 `:root`·`--void`·`--ink` 테마.

## 동시 사용 안전성

- **SQLite:** rollback journal `DELETE`, `busy_timeout=5000`ms를 사용합니다. 강화·간격 게이트는 `BEGIN IMMEDIATE` 안에서 최신 레코드를 읽어 계산합니다. BUSY 계열 오류만 총 3회까지 시도합니다. 끝내 강화하지 못하면 stderr와 `reinforcement_unapplied` 이벤트에 `busy_exhausted` 또는 `exception_swallowed`를 남깁니다. 이벤트 시각은 입력의 `ts: undefined`와 무관하게 ISO 기본값을 보장합니다.
- **WAL 조건:** `DELETE` 저널은 SQLite [WAL-reset 결함](https://www.sqlite.org/wal.html)을 피하기 위한 설정이며, 세션마다 다중 프로세스가 같은 DB를 씁니다(`src/stores/sqlite-store.ts`의 `SqliteStore.constructor`의 `JOURNAL_MODE` 설정). 코드에 적힌 재검토 조건은 SQLite 3.51.3 이상 또는 3.50.7 백포트입니다. 여기서는 런타임 버전과 무관하게 현재 설정인 `DELETE`만 설명합니다.
- **파일:** 임시 파일→rename의 원자적 쓰기, 신규 기억의 배타적 생성으로 같은 제목을 동시에 저장해도 접미 슬러그로 둘 다 보존합니다. 강화 직전 다시 읽어 증분만 적용하므로 다른 프로세스의 교정·망각을 덮어쓸 위험을 줄입니다. read-modify-write 전체를 잠그는 구조는 아니므로 경합 가능성은 남습니다.

근거: `src/stores/sqlite-store.ts`의 `BUSY_TIMEOUT_MS` 및 `JOURNAL_MODE`, `src/stores/sqlite-store.ts`의 `SqliteStore.transaction`의 BEGIN IMMEDIATE·BUSY 재시도, `src/store.ts`의 `MemoryService.reinforce`의 `updateRecord` 분기, `src/stores/sqlite-store.ts`의 `SqliteStore.appendUsageEvent`, `src/vault.ts`의 `writeFileAtomic` 및 `Vault.tryCreateExclusive`.

## 조회의 디스크 부작용

`recall`·`read_memory`는 간격 게이트가 열리면 강화와 메타데이터를 씁니다. 기본 바닥은 10분이며 확장 간격은 더 길 수 있습니다. `ASTRONRAG_FLUSH_EVERY_ACCESS`가 꺼져 있으면 닫힌 게이트의 조회는 디스크에 접근 횟수도 기록하지 않습니다. 이 횟수는 순위에 쓰지 않습니다. `list_memories`·`reflect`는 접근 강화 쓰기를 하지 않습니다. 기동·색인 동기화·사용 로그 쓰기는 별도 동작입니다(`src/store.ts`의 `FLUSH_EVERY_ACCESS`, `src/store.ts`의 `MemoryService.reinforce`의 `FLUSH_EVERY_ACCESS` 분기).

## 사용 계측

```bash
npm run usage:report
npm run usage:report -- --json
npm run usage:report -- --since 2026-10-01
```

파일 저장소는 `.bbm-usage.jsonl` append-only 로그를 쓰며 SQLite 저장소는 `usage_events` 테이블에 사용 이벤트를 기록합니다. 훅도 선택한 저장소에 위임합니다. 두 저장소 모두 `ASTRONRAG_USAGE_LOG_MAX_BYTES`(기본 5MiB)를 적용해 파일은 `.old`로 회전하고 SQLite는 평균 행 크기로 허용 행 수를 추정해 오래된 행을 삭제하는 근사 상한이므로 정확한 바이트 한도는 아니지만 로그가 무한히 커지지 않습니다([설정](configuration.md)). 로그는 볼트와 함께 옮깁니다. 근거: `src/stores/file-store.ts`의 `USAGE_FILE`·`FileStore.appendUsageEvent`, `src/stores/sqlite-store.ts`의 `SqliteStore.appendUsageEvent`·`insertUsageRow`, `src/env.ts`의 `usageLogMaxBytes`, `scripts/session-guard.mjs`의 `logUsage`.

훅은 세션 시작·종료·부호화 큐 이벤트와 자동 회상의 `tool: auto_recall` 이벤트를 기록합니다. `--prompt`의 검색은 읽기 경로이며, 자동 회상 검색이 완료되면(주입 0건 포함) 유효한 `session_id`에 대해 마커 추적 여부와 관계없이 사용 이벤트를 기록합니다(`astron:<id>` 포함). 빈 `session_id`는 기록하지 않습니다. 자동 회상 이벤트에는 `sessionId`·`injected` 건수·`topScore` 같은 식별자·수치와 이벤트 구분·시각만 남기며 질의 원문·기억 내용은 기록하지 않습니다. 근거: `scripts/session-guard.mjs`의 `selectedStore` 초기화·`autoRecall`·`logUsage`, `scripts/session-guard.mjs`의 `mode`의 prompt·start·stop 분기, `src/stores/sqlite-store.ts`의 `SqliteStore.appendUsageEvent`, `src/stores/file-store.ts`의 `FileStore.appendUsageEvent`.

SQLite 자동 회상 사용 기록은 검색 연결과 별도의 짧은 쓰기 연결을 사용합니다. `USAGE_WRITE_TIMEOUT_MS`의 재시도 예산은 125ms이며 busy·잠금이면 짧게 재시도하다 포기합니다. 기록 실패 시 stderr에 `astronrag usage: write failed (<code>)` 한 줄을 남기고 회상 출력과 종료 코드 0을 유지합니다. 이 예산은 훅 전체 실행 시간의 상한이 아닙니다. 여러 쓰기 프로세스가 같은 SQLite를 동시에 쓰는 고경합에서는 훅 기록이 빠질 수 있는 best-effort 방식이므로 사용 로그를 완전한 감사 기록으로 취급하지 않습니다. 근거: `scripts/session-guard.mjs`의 `USAGE_WRITE_TIMEOUT_MS`·`logUsage`·`emitPrompt`, `src/stores/sqlite-store.ts`의 `SqliteStore.appendUsageEvent`.

서버 도구 사용 이벤트는 기본적으로 질의문·본문·제목을 기록하지 않으며, `ASTRONRAG_LOG_QUERIES=1`로 서버 `recall`의 질의문 기록을 켭니다. 훅 자동 회상에는 질의문 기록 경로가 없습니다(`src/usage.ts`의 `queryField`, `scripts/session-guard.mjs`의 `logUsage`의 `auto_recall` 호출). 강화 실패 이벤트 `reinforcement_unapplied`에는 기억 slug(제목에서 만든 값)와 원문 오류 메시지가 남습니다(`src/store.ts`의 `MemoryService.reinforce`의 강화 실패 분기, `src/vault.ts`의 `Vault.makeSlug`). `shadowTop5`는 두 점수 방식의 목록 일치율입니다.

`ASTRONRAG_USAGE_LOG=0`은 서버의 일반 도구 사용 로그를 끕니다. 저장소에 직접 쓰는 강화 실패 이벤트 `reinforcement_unapplied`는 이 설정의 영향을 받지 않습니다. 훅 사용 로그를 끄려면 훅 프로세스 환경에도 별도로 `ASTRONRAG_USAGE_LOG=0`을 설정해야 합니다. 근거: `src/usage.ts`의 `DISABLED`, `src/usage.ts`의 `logUsage`, `src/store.ts`의 `MemoryService.reinforce`의 강화 실패 분기, `scripts/session-guard.mjs`의 `logUsage`.

`access_count`는 게이트가 열린 조회만 기록될 수 있으므로 전체 조회수 대신 사용할 수 없습니다. 저장률이 높은 조건에서는 ‘세션당 저장>0’이 천장효과를 보이므로 저장까지 걸린 턴 수 같은 연속량을 함께 봅니다. 비교 실험에서는 훅 조건을 양쪽에 같게 둡니다. 근거: `src/usage.ts`의 `DISABLED`, `src/usage.ts`의 `queryField`, `scripts/usage-report.mjs`의 `report`의 `sessions`·`recall`·`remember` 집계, `scripts/session-guard.mjs`의 `logUsage`.

## 빌드와 시험

```bash
npm ci
npm run build
npm test
```

빌드는 TypeScript를 컴파일하고 `ontology/ontology.yaml`에서 런타임용 `ontology/ontology.json`을 생성합니다. js-yaml은 개발 의존성입니다. 전체 시험은 실제 stdio MCP 서버와 임시 볼트를 사용하므로 시간이 걸립니다. 단언 수는 고정된 계약으로 두지 않습니다.

| 개별 명령 | 검증 대상 |
|---|---|
| `npm run test:smoke` | 전체 기억 사이클 |
| `npm run test:hook` | 훅 경로·무저장 감지 |
| `npm run test:config` | MCP 스폰 계약 |
| `npm run test:corruption` | 손상 파일 내성 |
| `npm run test:concurrency` | 다중 프로세스 경합 |
| `npm run test:edit` | 손편집·교정 스냅샷 |
| `npm run test:trigger` | 회상 트리거·경고 |
| `npm run test:scoping` | 프로젝트 스코핑 |
| `npm run test:staleness` | 나이·검토일 |
| `npm run test:quiet` | 조회 부작용 |
| `npm run test:activation` | 기저활성·임계 |
| `npm run test:spacing` | 간격·강화 |
| `npm run test:search` | 동의어·정밀도 |
| `npm run test:prompt` | 정리 프롬프트 |
| `npm run test:import` | 네이티브 이관 |
| `npm run test:perf` | id 캐시·상한·예약명 |

전체 스크립트 이름은 [package.json](../package.json)에 있습니다. 실제 측정 명령은 [평가](evaluation.md)를 따릅니다.

## 기술 스택

`@modelcontextprotocol/sdk` 1.x의 McpServer·StdioServerTransport, TypeScript, zod 입력 스키마, gray-matter frontmatter 파서, Node 내장 SQLite를 사용합니다. `@huggingface/transformers`는 선택 의존성입니다. `package.json`의 `dependencies` 및 `optionalDependencies`, `src/stores/sqlite-store.ts`의 `DatabaseSync` 및 `SqliteStore`가 근거입니다.
