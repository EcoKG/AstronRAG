---
id: mem-fx038
title: "Worker memory ceiling"
description: "Workers restart at 1.5GB RSS via pm2 max_memory_restart"
type: semantic
tags:
  - "pm2"
  - "worker"
  - "rss"
confidence: 0.9
storage_strength: 2
status: active
created: '2026-02-16T02:00:00.000Z'
updated: '2026-03-02T02:00:00.000Z'
last_accessed: '2026-03-02T02:00:00.000Z'
last_reinforced: '2026-03-02T02:00:00.000Z'
access_count: 4
links: []
history:
  - "2026-02-16: created"
---

Image workers restart automatically when RSS passes 1.5GB using pm2 max_memory_restart. Restarts are counted in the dashboard.
