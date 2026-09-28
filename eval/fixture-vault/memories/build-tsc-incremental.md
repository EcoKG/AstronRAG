---
id: mem-fx003
title: "TypeScript incremental build cache"
description: "tsbuildinfo lives in .cache and goes stale after branch switches"
type: semantic
tags:
  - "typescript"
  - "tsc"
  - "cache"
confidence: 0.9
storage_strength: 2
status: active
created: '2026-04-22T21:00:00.000Z'
updated: '2026-05-31T21:00:00.000Z'
last_accessed: '2026-05-31T21:00:00.000Z'
last_reinforced: '2026-05-31T21:00:00.000Z'
access_count: 5
links: []
history:
  - "2026-04-22: created"
---

Incremental builds write tsbuildinfo into .cache. After switching branches the file can reference deleted sources and emit nothing, so clear it when output looks incomplete.
