---
id: mem-fx060
title: "레디스 캐시 수동 무효화"
description: "SCAN 으로 키 패턴을 찾아 UNLINK, KEYS 금지"
type: procedural
tags:
  - "redis"
  - "캐시"
  - "무효화"
confidence: 0.6
storage_strength: 7
status: active
created: '2026-01-11T12:00:00.000Z'
updated: '2026-01-31T12:00:00.000Z'
last_accessed: '2026-01-31T12:00:00.000Z'
last_reinforced: '2026-01-31T12:00:00.000Z'
access_count: 7
links: []
history:
  - "2026-01-11: created"
---

redis-cli --scan --pattern 'product:*' 로 키를 모아 UNLINK 한다. KEYS 명령은 운영에서 서버를 멈추므로 쓰지 않는다.
