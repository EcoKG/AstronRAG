---
id: mem-fx006
title: "CI 캐시 키 규칙"
description: "lockfile 해시로 node_modules 캐시 키를 만든다"
type: semantic
tags:
  - "ci"
  - "캐시"
  - "lockfile"
confidence: 0.7
storage_strength: 3
status: active
created: '2026-02-22T18:00:00.000Z'
updated: '2026-04-01T18:00:00.000Z'
last_accessed: '2026-04-01T18:00:00.000Z'
last_reinforced: '2026-04-01T18:00:00.000Z'
access_count: 5
links: []
history:
  - "2026-02-22: created"
---

캐시 키는 운영체제와 lockfile 해시를 합쳐 만든다. lockfile 이 바뀌면 캐시가 새로 만들어지고, 복원 키로 부분 적중을 허용한다.
