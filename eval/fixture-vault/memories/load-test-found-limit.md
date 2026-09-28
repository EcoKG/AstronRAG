---
id: mem-fx101
title: "Load test found the DB CPU ceiling"
description: "At 400 virtual users the primary CPU hit 95%"
type: episodic
tags:
  - "load-test"
  - "db"
  - "cpu"
confidence: 0.7
storage_strength: 2
status: active
created: '2026-06-17T11:00:00.000Z'
updated: '2026-06-30T23:00:00.000Z'
last_accessed: '2026-06-30T23:00:00.000Z'
last_reinforced: '2026-06-30T23:00:00.000Z'
access_count: 3
links: []
history:
  - "2026-06-17: created"
---

The k6 run reached 400 virtual users before primary CPU hit 95%. Most time went to the order search query.
