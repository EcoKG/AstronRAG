---
id: mem-fx045
title: "Triage a slow query"
description: "EXPLAIN ANALYZE, look for seq scans, add the index in staging first"
type: procedural
tags:
  - "query"
  - "explain"
  - "performance"
confidence: 0.6
storage_strength: 2
status: active
created: '2026-05-16T03:00:00.000Z'
updated: '2026-06-10T03:00:00.000Z'
last_accessed: '2026-06-10T03:00:00.000Z'
last_reinforced: '2026-06-10T03:00:00.000Z'
access_count: 3
links: []
history:
  - "2026-05-16: created"
---

Run EXPLAIN ANALYZE with the real parameters, look for sequential scans and row estimate errors, then try the index in staging before production.
