# 주인님 결정 자율 배정 기준표와 공식 문서 근거

정책 버전: 2026-10-22.1. 역할·위험·크기별 배정은 운영자 결정이고, 각 배정이 고른 모델의 성격·effort 단계는 아래 공식 문서를 근거로 한다. 공식 문서 확인일은 2026-10-22다.

## 고정 제약(운영자 결정)

- gpt-6-astra·Fable은 카탈로그에 기록하되 추천·후보에서 제외한다(`constraint:owner-exclusions`).
- 계열마다 최신 모델만 추천한다(`constraint:latest-models`).
- Haiku는 기본으로 쓰지 않고 근거 있는 운영자 예외만 허용한다(`constraint:haiku-evidence`).

## 배정과 공식 근거

| 배정(운영자 결정) | 공식 문서 인용 |
|---|---|
| Opus high~xhigh: 어려운 설계, 복잡한 근본 원인 분석, 보안 검토, 큰 구조 변경, 위험한 변경의 최종 검토 | [Choosing a model](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model): Opus 5.5는 복잡한 agentic coding용이며 "Most workloads start with Claude Opus 5.5." / [Effort](https://platform.claude.com/docs/en/build-with-claude/effort): Opus 5.5는 low~max를 지원하고 기본값은 medium이다. |
| Sonnet medium~high: 일반 구현, 문서, 검증·시험, 일반 검토, 배송·단순 조회, 원인·범위가 확정된 작은 수정 | [Choosing a model](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model): Sonnet 5.5는 일상 코딩·에이전트용이다. / [Effort](https://platform.claude.com/docs/en/build-with-claude/effort): Sonnet 5.5는 low~max를 지원하고 기본값은 high이며, agentic coding은 medium부터 시작하라고 권장한다. |
| Codex gpt-6.1-sol: 자체 프로젝트, 장기 자율 구현, 병렬 대량 작업. plan·impl·review·분석·위험 high는 high, research·ship·coordinator·작은 수정·fallback은 medium | [gpt-6.1-sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol): "Near-Astra performance for complex work at a lower cost." 공식 effort는 low~max(none·minimal 미지원)이고 기본값은 medium이다(모델 페이지와 [Reasoning](https://developers.openai.com/api/docs/guides/reasoning)). |
| 교차 검토: 구현과 검토를 Claude↔Codex의 다른 계열에 우선 배정한다. 명시 플랫폼과 보안 우선순위는 유지한다 | 공식 문서에 해당 규정이 없다. 운영자 결정이다. |

공식 권장과 다른 운영자 선택은 다음과 같다.

- 공식 문서는 대부분의 작업을 Opus 5.5로 시작하라고 하지만, 일반 작업의 기본 배정은 Sonnet 5.5다.
- Sonnet 5.5의 일반 구현·검토 effort는 high다. 공식 문서는 agentic coding을 medium부터 시작하라고 권장한다.
- 공식 문서는 gpt-6-luna를 "Our most efficient model for focused, high-volume tasks."로 설명하지만, Codex 작은 수정에도 gpt-6.1-sol medium을 배정한다.

## 신뢰도

- 규칙 confidence의 초기값(Claude 0.2, Codex 0.1)은 사전값이며 측정 결과가 아니다. 결정 표본 하한은 20건, 사전 가중치는 20이다. 판정 불명은 표본에서 제외하고, pass이면서 되돌림 0인 경우만 성공으로 집계한다.
- 공식 문서로 확인되지 않고 Codex CLI 관측으로만 아는 값(Codex 클라이언트의 context·기본 effort·`ultra` 지원·입력 형식)은 모델의 `observed`에 confidence 0.3으로 둔다. 근거는 [Codex 카탈로그 관측](codex-catalog-2026-10-20.md)이며 CLI 한 버전(0.163.0)·한 계정에서 한 번 관측한 값이다.
- 규칙의 effort는 공식 `supportedEfforts` 안에서만 고른다. 관측값만 있는 effort는 규칙에 쓸 수 없다.

## 공식 값 기록 원칙

가격 tier의 단위는 USD/100만 토큰이다. 미확인 가격·최대 출력·기본 effort·출처 URL은 추정하지 않고 생략한다.

Claude 모델 값은 2026-10-22 확인 기준으로 [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview)·[Pricing](https://platform.claude.com/docs/en/about-claude/pricing)·[Effort](https://platform.claude.com/docs/en/build-with-claude/effort)·[Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)과 일치한다. 모델 `sources`의 확인일은 공식 문서 수집기(`scripts/collect-model-docs.mjs`)가 남긴 값이다.

OpenAI 모델 값의 출처는 모델 페이지(`https://developers.openai.com/api/docs/models/<id>`), [Pricing](https://developers.openai.com/api/docs/pricing), [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), [Reasoning](https://developers.openai.com/api/docs/guides/reasoning)이다.

- context 1,050,000, 최대 출력 128,000은 다섯 모델이 같다. 최대 입력 922,000은 스키마 필드가 없어 이 문서에만 기록한다.
- 가격은 Standard 등급이다. OpenAI 캐시 쓰기는 `cacheWrite30m`(30분, 1.25배)·`cacheWrite12h`(12시간, 2.5배)로 기록한다.
- 입력 272K 초과 tier는 가격 페이지의 배수(입력·캐시 2배, 출력 1.5배)로 계산했다. gpt-6.1-sol은 원문 수치(4·0.20·5/10·15)와 같다. 문서 표기 272K는 `promptTokens: 272000`으로 기록한다.
- Batch·Flex(50%), Fast(2배), Ultrafast(gpt-6-astra·gpt-6.1-sol, 6배) 등급은 tier로 기록하지 않는다.
- gpt-6-astra의 기본 effort는 문서에 없어 생략한다.
- `minimal`은 문서 확인이 필요하다. gpt-6.1-sol은 none·minimal 미지원이 명시되어 있고, 나머지 모델은 범위 표기만 있어 기록하지 않는다.
- `ultra`는 Codex 전용 값이다. Codex config-reference는 `learn.chatgpt.com`으로 영구 이동(308)해 허용 도메인 판단을 기다리므로 공식 `supportedEfforts`에 넣지 않고 관측값에만 둔다. gpt-6-luna의 `ultra` 미지원은 Codex models 문서와 CLI 관측이 일치한다.
- gpt-5.6-sol의 $4/$20은 가격 페이지 값이다. 문서에는 "promotional pricing is available at least through November 21, 2026"라는 문구가 있어, 이 값이 프로모션가인지 정가인지는 모른다. 2026-11-21 이후 가격 페이지를 다시 확인한다.
- 지식 cutoff는 gpt-6.1-sol·gpt-6-astra가 2026-04-30, gpt-6-sol이 2026-04-20, gpt-6-luna가 2026-05-18, gpt-5.6-sol이 2026-02-16이다. 스키마 필드가 없어 이 문서에만 기록한다.
- CLI의 `max=872000`은 공식 문서에 없는 값이다.
