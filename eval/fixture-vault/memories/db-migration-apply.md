---
id: mem-fx043
title: "Apply a schema migration safely"
description: "Expand, backfill, then contract in separate releases"
type: procedural
tags:
  - "migration"
  - "schema"
  - "db"
confidence: 0.9
storage_strength: 6
status: active
created: '2026-03-03T13:00:00.000Z'
updated: '2026-04-11T13:00:00.000Z'
last_accessed: '2026-04-11T13:00:00.000Z'
last_reinforced: '2026-04-11T13:00:00.000Z'
access_count: 9
links:
  - "migration-lock-table"
history:
  - "2026-03-03: created"
---

Add new columns as nullable first, backfill in batches, switch reads, and drop the old column in a later release. Never add a column with a volatile default on a large table.

## 연관 기억
- [[migration-lock-table]]
