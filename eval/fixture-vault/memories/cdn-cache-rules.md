---
id: mem-fx037
title: "CDN 캐시 무효화 규칙"
description: "정적 자산은 content hash 파일명이라 purge 가 필요 없다"
type: semantic
tags:
  - "cdn"
  - "캐시"
  - "정적자산"
confidence: 0.8
storage_strength: 4
status: active
created: '2026-01-10T19:00:00.000Z'
updated: '2026-01-11T19:00:00.000Z'
last_accessed: '2026-01-11T19:00:00.000Z'
last_reinforced: '2026-01-11T19:00:00.000Z'
access_count: 5
links: []
history:
  - "2026-01-10: created"
---

빌드 산출 정적 자산은 content hash 가 파일명에 들어가 1년 캐시한다. 해시가 없는 경로만 짧은 TTL 을 준다.
