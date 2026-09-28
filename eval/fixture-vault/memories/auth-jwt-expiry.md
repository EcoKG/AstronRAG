---
id: mem-fx009
title: "JWT 만료 시간 정책"
description: "액세스 토큰 15분, 리프레시 토큰 14일"
type: semantic
tags:
  - "인증"
  - "jwt"
  - "토큰"
confidence: 0.95
storage_strength: 4
status: active
created: '2026-06-13T15:00:00.000Z'
updated: '2026-06-30T23:00:00.000Z'
last_accessed: '2026-06-30T23:00:00.000Z'
last_reinforced: '2026-06-30T23:00:00.000Z'
access_count: 5
links: []
history:
  - "2026-06-13: created"
---

액세스 토큰은 15분, 리프레시 토큰은 14일 뒤 만료된다. 리프레시 토큰은 사용할 때마다 새로 발급하고 이전 것은 폐기한다.
