---
id: mem-fx097
title: "Settlement batch ran twice"
description: "Cron ran on two hosts after failover and paid out twice"
type: episodic
tags:
  - "batch"
  - "cron"
  - "duplicate"
confidence: 0.8
storage_strength: 3
status: active
created: '2026-01-20T07:00:00.000Z'
updated: '2026-02-10T07:00:00.000Z'
last_accessed: '2026-02-10T07:00:00.000Z'
last_reinforced: '2026-02-10T07:00:00.000Z'
access_count: 4
links: []
history:
  - "2026-01-20: created"
---

After a host failover both machines had the cron entry and the settlement batch ran twice. Added a distributed lock.
