---
id: mem-fx004
title: "프론트 번들 크기 예산"
description: "메인 번들은 gzip 기준 250KB 상한"
type: semantic
tags:
  - "번들"
  - "webpack"
  - "프론트엔드"
confidence: 0.95
storage_strength: 7
status: active
created: '2026-05-29T04:00:00.000Z'
updated: '2026-06-10T04:00:00.000Z'
last_accessed: '2026-06-10T04:00:00.000Z'
last_reinforced: '2026-06-10T04:00:00.000Z'
access_count: 7
links: []
history:
  - "2026-05-29: created"
---

메인 번들 예산은 gzip 250KB 이다. 초과하면 CI 의 size-limit 단계가 실패한다. 차트 라이브러리는 동적 import 로 분리했다.
