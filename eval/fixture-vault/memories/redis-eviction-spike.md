---
id: mem-fx088
title: "레디스 메모리 초과로 키 축출"
description: "maxmemory 에 도달해 세션 키가 축출되고 대량 로그아웃"
type: episodic
tags:
  - "redis"
  - "축출"
  - "세션"
confidence: 0.9
storage_strength: 7
status: active
created: '2026-01-27T16:00:00.000Z'
updated: '2026-02-20T16:00:00.000Z'
last_accessed: '2026-02-20T16:00:00.000Z'
last_reinforced: '2026-02-20T16:00:00.000Z'
access_count: 7
links: []
history:
  - "2026-01-27: created"
---

캐시와 세션이 같은 Redis 를 쓰다가 maxmemory 에 닿아 세션 키가 축출됐다. 사용자 수천 명이 한꺼번에 로그아웃됐다.
