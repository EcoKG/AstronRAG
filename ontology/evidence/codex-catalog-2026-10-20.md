# Codex 카탈로그 관측

> 공식 문서로 보강됨(2026-10-22): 모델 필드의 정본은 OpenAI 공식 문서 값이며 [배정 기준표](owner-policy-2026-10-22.md)와 `ontology/ontology.yaml`의 모델 `sources`에 출처를 둔다. 이 문서의 관측값은 모델의 `observed`(confidence 0.3)에만 쓴다.

제공 자료의 관측 조건은 2026-10-20, Codex CLI 0.163.0의 `codex debug models`, ChatGPT 계정, visibility=list다. 이 문서는 제공된 관측을 기록하며 독립적인 공식 문서 검증이나 재측정 결과가 아니다.

| slug | 설명 | context / max | effort | 기본 effort | 입력 |
|---|---|---|---|---|---|
| gpt-6.1-sol | Latest workhorse model for coding and everyday work. | 500000 / 872000 | low~ultra | low | text, image |
| gpt-6-astra | Frontier intelligence for the most demanding work. | 272000 / 872000 | low~ultra | medium | text, image |
| gpt-6-sol | Previous generation workhorse model. | 272000 / 872000 | low~ultra | medium | text, image |
| gpt-6-luna | Fast and affordable model for easier tasks. | 272000 / 872000 | low~max | medium | text, image |
| gpt-5.6-sol | Older generation workhorse model. | 272000 / 872000 | low~ultra | low | text, image |

effort 순서는 low, medium, high, xhigh, max, ultra다. gpt-6-luna는 max까지만 지원한다. 관측 context는 `observed.contextTokens`로 기록한다. max=872000은 공식 문서에 없는 값이며 최대 출력 토큰으로 해석할 근거가 없다. 가격·최대 출력·공식 context는 공식 문서 값을 쓴다.

현재 역할 배치는 모두 gpt-6.1-sol이다. research·ship·coordinator는 medium, plan·impl·review는 high이고 위험 high는 high를 우선한다. gpt-6-astra는 카탈로그에 기록하되 추천과 후보에서 제외한다.

gpt-6.1-sol 역할별 실측이 없으므로 confidence는 0.1이다. [기존 측정](measurements-2026-10-19.md)의 gpt-5.6-sol high impl 105세션은 별도 모델 자료이며 gpt-6.1-sol 성능 근거로 일반화하지 않는다.

확인 필요: ops 역할은 지정된 배치가 없어 gpt-6.1-sol medium fallback을 가정한다. 위험 high에서는 high를 사용한다.
