---
id: mem-fx119
title: "Connection pool exhaustion outage follow-up"
description: "Pool exhaustion outage fixed after pgbouncer"
type: episodic
tags:
  - "incident"
  - "pgbouncer"
  - "pool"
confidence: 0.95
storage_strength: 1
status: active
created: '2026-06-03T17:00:00.000Z'
updated: '2026-06-30T17:00:00.000Z'
last_accessed: '2026-06-30T17:00:00.000Z'
last_reinforced: '2026-06-30T17:00:00.000Z'
access_count: 4
links:
  - "inc-pool-exhaustion"
history:
  - "2026-06-03: created"
---

We put pgbouncer in front of the primary and capped per-pod pools, so scale-out no longer multiplies connections.

## 연관 기억
- [[inc-pool-exhaustion]]
