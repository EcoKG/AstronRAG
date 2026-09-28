---
id: mem-fx027
title: "외부 API 호출 한도"
description: "결제 대행사 API 는 초당 50건 제한"
type: semantic
tags:
  - "api"
  - "한도"
  - "결제"
confidence: 0.8
storage_strength: 3
status: active
created: '2026-05-30T21:00:00.000Z'
updated: '2026-06-30T21:00:00.000Z'
last_accessed: '2026-06-30T21:00:00.000Z'
last_reinforced: '2026-06-30T21:00:00.000Z'
access_count: 6
links: []
history:
  - "2026-05-30: created"
---

결제 대행사 API 는 가맹점 키당 초당 50건으로 제한된다. 초과하면 429 를 돌려주고 1분간 차단된다.
