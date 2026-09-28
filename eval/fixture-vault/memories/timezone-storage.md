---
id: mem-fx026
title: "Timestamps stored in UTC"
description: "All DB timestamps are UTC and the UI converts to KST"
type: semantic
tags:
  - "timezone"
  - "utc"
  - "db"
confidence: 0.7
storage_strength: 5
status: active
created: '2026-04-23T14:00:00.000Z'
updated: '2026-05-11T14:00:00.000Z'
last_accessed: '2026-05-11T14:00:00.000Z'
last_reinforced: '2026-05-11T14:00:00.000Z'
access_count: 7
links: []
history:
  - "2026-04-23: created"
---

Every timestamp column is timestamptz stored in UTC. Only the UI layer converts to Asia/Seoul for display.
