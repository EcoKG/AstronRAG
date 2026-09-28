---
id: mem-fx002
title: "주문 테이블 인덱스 구성"
description: "orders 테이블은 user_id, created_at 복합 인덱스를 쓴다"
type: semantic
tags:
  - "인덱스"
  - "쿼리"
  - "orders"
confidence: 0.8
storage_strength: 4
status: active
created: '2026-03-16T14:00:00.000Z'
updated: '2026-04-11T14:00:00.000Z'
last_accessed: '2026-04-11T14:00:00.000Z'
last_reinforced: '2026-04-11T14:00:00.000Z'
access_count: 6
links: []
history:
  - "2026-03-16: created"
---

주문 목록 조회는 user_id 와 created_at 복합 인덱스를 탄다. status 단독 인덱스는 선택도가 낮아 제거했다.
