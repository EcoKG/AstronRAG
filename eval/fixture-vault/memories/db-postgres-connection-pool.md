---
id: mem-fx000
title: "Postgres connection pool limit"
description: "API pool max is 20 connections per instance"
type: semantic
tags:
  - "postgres"
  - "db"
  - "pool"
confidence: 0.6
storage_strength: 1
status: active
created: '2026-01-01T00:00:00.000Z'
updated: '2026-01-01T00:00:00.000Z'
last_accessed: '2026-01-01T00:00:00.000Z'
last_reinforced: '2026-01-01T00:00:00.000Z'
access_count: 1
links:
  - "inc-pool-exhaustion"
history:
  - "2026-01-01: created"
---

Each API instance opens at most 20 connections through pgbouncer in transaction mode. Raising it past 20 exhausted max_connections=200 on the primary during a scale-out.

## 연관 기억
- [[inc-pool-exhaustion]]
