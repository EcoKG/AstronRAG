---
id: mem-fx103
title: "Stale feature flag caused a bug"
description: "A removed flag defaulted to on in one service"
type: episodic
tags:
  - "feature-flag"
  - "bug"
confidence: 0.9
storage_strength: 5
status: active
created: '2026-03-13T01:00:00.000Z'
updated: '2026-04-01T01:00:00.000Z'
last_accessed: '2026-04-01T01:00:00.000Z'
last_reinforced: '2026-04-01T01:00:00.000Z'
access_count: 8
links: []
history:
  - "2026-03-13: created"
---

One service still read a deleted flag and its local default was true, so an unfinished screen appeared for a day.
