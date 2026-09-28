---
id: mem-fx015
title: "상품 캐시 TTL"
description: "Redis 상품 캐시 TTL 은 10분"
type: semantic
tags:
  - "캐시"
  - "redis"
  - "ttl"
confidence: 0.6
storage_strength: 6
status: active
created: '2026-02-15T09:00:00.000Z'
updated: '2026-03-22T09:00:00.000Z'
last_accessed: '2026-03-22T09:00:00.000Z'
last_reinforced: '2026-03-22T09:00:00.000Z'
access_count: 9
links: []
history:
  - "2026-02-15: created"
---

상품 상세 캐시는 Redis 에 10분 TTL 로 둔다. 가격 변경 이벤트가 오면 해당 키를 즉시 지운다.
