---
id: mem-fx085
title: "Migration locked the orders table"
description: "ALTER TABLE with a default rewrote the table for 12 minutes"
type: episodic
tags:
  - "migration"
  - "lock"
  - "orders"
confidence: 0.6
storage_strength: 6
status: active
created: '2026-03-27T19:00:00.000Z'
updated: '2026-04-21T19:00:00.000Z'
last_accessed: '2026-04-21T19:00:00.000Z'
last_reinforced: '2026-04-21T19:00:00.000Z'
access_count: 7
links: []
history:
  - "2026-03-27: created"
---

Adding a column with a volatile default rewrote the orders table and held an exclusive lock for 12 minutes during peak.
