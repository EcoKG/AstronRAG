---
id: mem-fx155
title: "Explicit queries over ORM magic"
description: "Use the query builder and avoid lazy loading"
type: preference
tags:
  - "orm"
  - "sql"
  - "db"
confidence: 0.6
storage_strength: 6
status: active
created: '2026-05-06T05:00:00.000Z'
updated: '2026-05-21T05:00:00.000Z'
last_accessed: '2026-05-21T05:00:00.000Z'
last_reinforced: '2026-05-21T05:00:00.000Z'
access_count: 9
links: []
history:
  - "2026-05-06: created"
---

Prefer explicit query builder calls with joins over ORM lazy loading so the query count is visible.
