---
id: mem-fx081
title: "Connection pool exhaustion outage"
description: "Pool exhaustion outage after scale-out"
type: episodic
tags:
  - "incident"
  - "postgres"
  - "pool"
confidence: 0.7
storage_strength: 7
status: active
created: '2026-04-18T15:00:00.000Z'
updated: '2026-05-01T15:00:00.000Z'
last_accessed: '2026-05-01T15:00:00.000Z'
last_reinforced: '2026-05-01T15:00:00.000Z'
access_count: 8
links:
  - "db-postgres-connection-pool"
history:
  - "2026-04-18: created"
---

Autoscaling to 15 pods pushed total connections past max_connections and the API returned 500s for 25 minutes.

## 연관 기억
- [[db-postgres-connection-pool]]
