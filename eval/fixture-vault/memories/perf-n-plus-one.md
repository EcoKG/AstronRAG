---
id: mem-fx090
title: "N+1 쿼리로 목록 API 느려짐"
description: "ORM 지연 로딩 때문에 쿼리가 300번 나갔다"
type: episodic
tags:
  - "성능"
  - "쿼리"
  - "orm"
confidence: 0.6
storage_strength: 3
status: active
created: '2026-04-11T06:00:00.000Z'
updated: '2026-04-21T06:00:00.000Z'
last_accessed: '2026-04-21T06:00:00.000Z'
last_reinforced: '2026-04-21T06:00:00.000Z'
access_count: 5
links: []
history:
  - "2026-04-11: created"
---

주문 목록 API 가 항목마다 사용자 정보를 따로 불러 요청당 쿼리가 300번 나갔다. 조인으로 바꿔 응답이 2초에서 150ms 로 줄었다.
