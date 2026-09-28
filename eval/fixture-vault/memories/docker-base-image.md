---
id: mem-fx031
title: "도커 베이스 이미지"
description: "node:20-alpine 을 쓰되 네이티브 모듈이 있으면 slim"
type: semantic
tags:
  - "docker"
  - "이미지"
confidence: 0.7
storage_strength: 2
status: active
created: '2026-05-08T01:00:00.000Z'
updated: '2026-05-11T01:00:00.000Z'
last_accessed: '2026-05-11T01:00:00.000Z'
last_reinforced: '2026-05-11T01:00:00.000Z'
access_count: 5
links: []
history:
  - "2026-05-08: created"
---

서비스 이미지는 node:20-alpine 을 쓴다. sharp 같은 네이티브 모듈이 있는 서비스는 glibc 가 필요해 node:20-slim 을 쓴다.
