# 기억 모델과 검색

[README로](../README.md) · [도구](tools.md) · [운영](operations.md)

## 설계 원칙

ACT-R, 저장강도와 인출강도의 구분, 간격효과, 재공고화, 간섭·인출유도망각을 선택적으로 적용합니다. 기억의 강점인 강화·연상은 활용하고 재구성적 오기억·출처 혼동은 피합니다. 원문과 출처를 보존하며 파괴적 자동 병합은 하지 않습니다. 원칙은 [기억 이론 리포트](memory-model-report.md)에 있고, 수치와 현재 수식은 아래 코드 계약을 따릅니다.

| 개념 | 동작 | 코드 근거 |
|---|---|---|
| 기억 유형 | 사건 `episodic`, 지식 `semantic`, 절차 `procedural`, 선호 `preference` | `src/types.ts`의 `MemoryType` |
| 3축 분리 | `confidence`는 진실성으로 revise에서 교정. `storage_strength`는 단조 증가하는 저장강도. 인출강도는 질의 때 계산하며 저장하지 않음 | `src/types.ts`의 `MemoryRecord`, `src/ranker.ts`의 `activationOf` |
| 거듭제곱 기저활성 | `B = ln((n−1)·L^−d/(1−d) + t_last^−d)`. n=저장강도, L=생성 후 경과[시], t_last=마지막 강화 후 경과[시], d=0.5. 시간 하한은 1분 | `src/ranker.ts`의 `baseLevelActivation` |
| 순위 | 키워드 점수 × `(0.5+0.5·confidence)` × `(0.55+0.9·σ(B))`. active가 아니면 0.2배 | `src/ranker.ts`의 `finish` |
| 확장 간격 | `max(10분, α·기억 나이/n)`, α 기본 0.1. 같은 창의 반복 조회로 강도를 부풀리지 않음 | `src/store.ts`의 `SPACING_WINDOW_MS`, `src/store.ts`의 `requiredSpacing` |
| 바람직한 어려움 | 능동 recall이며 활성이 낮을 때 +0.5 보너스. 최근 강화한 기억은 높은 활성으로 제외 | `src/store.ts`의 `HARD_RETRIEVAL_ACTIVATION`, `src/store.ts`의 `MemoryService.reinforce`의 `reinforcementDelta` |
| 인출유도망각(RIF) | 유사한 하위 경쟁 기억은 순위 점수 0.5배, 해당 회상에서 강화 제외. 저장강도·진실성은 깎지 않음 | `src/ranker.ts`의 `inhibit`, `src/store.ts`의 `MemoryService.searchDetailed`의 강화 제외 분기 |
| 연상 | 양방향 위키링크. 상위 3건에서 1-hop, 최대 `ceil(limit/2)`건 추가. 연상으로 들어온 기억은 강화하지 않음 | `src/ranker.ts`의 `rank`의 `includeLinked` 분기, `src/store.ts`의 `MemoryService.searchDetailed`의 강화 제외 분기 |
| 교정 | `revise`는 본문 변경 전 최근 3세대 스냅샷. 본문이 바뀌거나 `confidence` 인수를 제공하면 간격 게이트 통과 시 저장강도 +1. 확신도가 같아도 인수를 제공하면 재확인으로 강화. `confidence` 생략과 본문 불변이 함께 성립하면 강화하지 않음 | `src/store.ts`의 `MemoryService.revise`, `src/store.ts`의 `MemoryService.revise`의 `substantive`·`spacingOk` 판정, `src/vault.ts`의 `Vault.snapshotRevision`, `src/stores/sqlite-store.ts`의 `SqliteStore.snapshotRevision` |
| 망각 | `forget`은 archived 상태로 보관. 파일 저장소는 `archive/` 이동으로 복원 가능 | `src/store.ts`의 `MemoryService.forget`, `src/vault.ts`의 `Vault.moveToArchive` |
| 메타인지 | 약화 후보는 나이 72시간 이상·활성 임계 미만을 충족한 기억 중 활성 오름차순으로 선택하며 활성 기억 수의 20%를 내림한 건수까지 제시. 자동 삭제 없음 | `src/store.ts`의 `WEAKENED_GRACE_MS`, `src/store.ts`의 `MemoryService.reflect`의 `weakened` 계산 |

σ는 임계값을 중심으로 하는 sigmoid 인출강도입니다(`src/ranker.ts`의 `retrievalStrength`). 리포트의 이론식은 설계 설명이며 현재 구현식과 구별합니다.

## 어휘 검색

기본 검색은 임베딩 없는 토큰 매칭입니다. 내장 **24개 동의어 그룹**을 양방향 확장합니다. 예: 배포↔deploy↔release↔출시, 설정↔config, 빌드↔build. 동의어만 맞으면 0.6배 가중이며 추가 사전은 `ASTRONRAG_SYNONYMS`입니다(`src/store.ts`의 `BUILTIN_SYNONYMS`, `src/retriever.ts`의 `SYNONYM_WEIGHT`).

조사는 명시적으로 떼어 비교하므로 ‘모드를’과 ‘모드’가 매칭됩니다. 복합어 접두 흡수는 짧은 쪽 길이 3 이상, 길이 차이 2 이하일 때만 허용하므로 ‘릴리스노트’와 ‘릴리스’가 매칭됩니다. 단어 경계를 지켜 서버리스/서버, 인증서/인증 같은 오탐을 줄입니다. 회상 0건은 기억 부재를 보장하지 않으므로 동의어·태그로 재질의합니다(`src/retriever.ts`의 `tokenMatch`).

`alt_queries`는 최대 3개를 사용합니다. 원 질의 1.0, 변형 기본 0.7로 가중한 점수의 기억별 최댓값을 채택한 뒤 진실성·활성·RIF·연상을 적용합니다. 변형이 없으면 단일 질의 경로입니다. 같은 호출에서 같은 기억을 중복 강화하지 않습니다(`src/retriever.ts`의 `fuseWeightedMax`, `src/store.ts`의 `MemoryService.searchDetailed`의 결과별 강화 루프).

| 점수 방식 | 필드 가중과 정규화 |
|---|---|
| legacy · 기본 | 제목 5, 태그 4, 설명 3, 본문 최대 3 |
| BM25F · 선택 | 제목 5, 태그 4, 설명 3, 본문 1. k1=1.2, b=0.3/0.3/0.3/0.75. IDF는 보관·타 프로젝트를 포함한 색인 전체 문서 빈도 |

BM25F는 `ASTRONRAG_SCORER=bm25f`로 선택합니다. 동의어 가중·토큰 흡수와 영속 색인 형식은 같습니다. 점수 척도가 다르므로 자동 회상 하한을 별도로 정합니다(`src/retriever.ts`의 `BM25F_W`·`BM25F_B`·`BM25F_K1`, `src/retriever.ts`의 `LexicalRetriever.bm25fStats`).

**그림자 계측:** legacy 회상은 BM25F도 계산해 상위 5개(요청 limit가 더 작으면 그 수) slug 목록의 일치율 `shadowTop5`만 사용 이벤트에 남깁니다. 후보가 없으면 생략하며 결과·강화는 바꾸지 않습니다. 질의·slug·본문을 이 지표에 기록하지 않습니다. `ASTRONRAG_SHADOW=0`으로 끕니다(`src/store.ts`의 `SHADOW`, `src/index.ts`의 `server.registerTool`의 `recall` 등록·`shadowTop5` 기록).

## 공고화

`reflect`는 태그 하나 아래 미추상화 일화가 3건 이상이면 후보를 제시합니다. 서버는 추상화하지 않으며, 모델이 원문들을 읽고 규칙이 성립하는지 확인한 뒤 `remember`의 `derived_from`에 근거 슬러그를 지정합니다(`src/store.ts`의 `MemoryService.reflect`의 `CONSOLIDATION_MIN`·`byTag`).

1. **원문 불변:** 파생 기억 생성은 근거 기억을 수정·삭제하지 않습니다. 회귀 시험은 볼트 전체의 경로별 SHA-256을 대조합니다.
2. **출처 영속:** `derived_from`을 frontmatter/레코드에 보관하므로 본문 교정과 독립적입니다.
3. **인출 우선순위:** 파생물과 자기 근거 사이에는 RIF 억제를 적용하지 않습니다. 요지가 원문을 밀어내지 않도록 합니다.

근거: `src/store.ts`의 `MemoryService.remember`의 `derivedFrom` 검증, `src/ranker.ts`의 `inhibit`의 `suppresses`, `scripts/regress-consolidation.mjs`의 `vaultHashes` 및 `check`.

## 선택형 벡터 계층

**기본 꺼짐, 전환 조건 미충족.** `ASTRONRAG_VECTOR=1`일 때만 서버가 모듈을 불러옵니다. 선택 의존성 `@huggingface/transformers`가 필요하며 npm의 선택 의존성 설치 실패 시에도 어휘 검색을 사용할 수 있습니다.

- 모델: `Xenova/multilingual-e5-small`, q8 ONNX. 서버 프로세스 안에서 계산합니다.
- 지연 로드: 서버는 모델 준비를 기다리지 않습니다. 준비 중 `vector: "warming"`, 준비 후 `"ready"`, 패키지가 없으면 `"unavailable"`과 `vector_note` 안내를 반환합니다.
- 융합: 어휘 후보 점수는 유지하고 코사인 0.90 이상, 상위 10건의 벡터 전용 후보를 `1 × 코사인`으로 추가한 뒤 기존 순위화를 적용합니다. 전용 결과에는 `via: "vector"`가 붙습니다.
- 강화: 벡터 전용 결과는 recall에서 강화하지 않으며 `read_memory`로 읽을 때 기존 강화 규칙을 따릅니다.
- 훅: 자동 회상은 벡터 모듈·transformers를 불러오지 않습니다.
- 저장: 제목·설명·태그·본문 앞 1,000자의 해시가 변한 기억만 재계산합니다. 파일 저장소 캐시는 `.bbm-index/vectors.v1.bin`(Float32)과 `vectors.v1.meta.json`(모델 ID·항목 키·임베딩 대상 텍스트 해시 포함)입니다(`src/vector-retriever.ts`의 `VectorRetriever.persist`). SQLite 저장소는 해당 저장소의 임베딩 테이블을 사용합니다. 모델 변경·손상 시 재계산합니다.
- 네트워크: 모델 파일은 최초 사용 시 Hugging Face Hub에서 OS 임시 디렉터리의 모델 캐시로 받습니다. 모델 캐시 경로는 `src/vector-retriever.ts`의 `MODEL_CACHE_DIR`에 정의되어 있습니다. 기억 임베딩은 로컬에서 계산합니다.

근거: `src/vector-retriever.ts`의 `MODEL_ID`·`DTYPE`·`VECTOR_WEIGHT`·`VECTOR_MIN_COS`·`VECTOR_TOP_K`, `src/vector-retriever.ts`의 `loadEmbedder`, `src/index.ts`의 `vector`·`vectorHits`·`vectorField`, `src/index.ts`의 `main`의 `ASTRONRAG_VECTOR` 분기, `scripts/regress-vector.mjs`의 `defaultChecks`. 모델 크기·메모리·지연 참고 결과는 [평가 문서](evaluation.md#조건별-참고-결과)에 있습니다.
