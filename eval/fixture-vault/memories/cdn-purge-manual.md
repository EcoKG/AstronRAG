---
id: mem-fx079
title: "Purge the CDN manually"
description: "Only for non-hashed paths such as /robots.txt"
type: procedural
tags:
  - "cdn"
  - "purge"
confidence: 0.95
storage_strength: 4
status: active
created: '2026-02-03T01:00:00.000Z'
updated: '2026-03-02T01:00:00.000Z'
last_accessed: '2026-03-02T01:00:00.000Z'
last_reinforced: '2026-03-02T01:00:00.000Z'
access_count: 7
links: []
history:
  - "2026-02-03: created"
---

Hashed assets never need a purge. For fixed paths like /robots.txt call the purge API with the exact URL.
