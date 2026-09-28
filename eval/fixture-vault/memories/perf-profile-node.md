---
id: mem-fx059
title: "Profile a Node service"
description: "Run with --cpu-prof and open the profile in Chrome DevTools"
type: procedural
tags:
  - "profiling"
  - "node"
  - "cpu"
confidence: 0.95
storage_strength: 2
status: active
created: '2026-05-24T05:00:00.000Z'
updated: '2026-05-31T05:00:00.000Z'
last_accessed: '2026-05-31T05:00:00.000Z'
last_reinforced: '2026-05-31T05:00:00.000Z'
access_count: 5
links: []
history:
  - "2026-05-24: created"
---

Start the service with node --cpu-prof, reproduce the slow path, stop it, and load the .cpuprofile file in Chrome DevTools.
