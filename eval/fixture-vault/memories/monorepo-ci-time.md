---
id: mem-fx113
title: "Monorepo CI took 40 minutes"
description: "Every package rebuilt, so affected-only filtering was added"
type: episodic
tags:
  - "monorepo"
  - "ci"
  - "speed"
confidence: 0.9
storage_strength: 6
status: active
created: '2026-04-12T23:00:00.000Z'
updated: '2026-05-11T23:00:00.000Z'
last_accessed: '2026-05-11T23:00:00.000Z'
last_reinforced: '2026-05-11T23:00:00.000Z'
access_count: 7
links: []
history:
  - "2026-04-12: created"
---

CI rebuilt every package on each PR and took 40 minutes. Filtering to affected packages cut it to 12.
