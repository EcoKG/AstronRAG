---
id: mem-fx041
title: "Rollback a bad release"
description: "Re-run the previous tag pipeline, then turn the flag off"
type: procedural
tags:
  - "rollback"
  - "release"
confidence: 0.7
storage_strength: 3
status: active
created: '2026-06-07T23:00:00.000Z'
updated: '2026-06-20T23:00:00.000Z'
last_accessed: '2026-06-20T23:00:00.000Z'
last_reinforced: '2026-06-20T23:00:00.000Z'
access_count: 4
links:
  - "rollback-success-canary"
history:
  - "2026-06-07: created"
---

1. Find the previous good tag. 2. Re-run its deploy pipeline. 3. Turn off the feature flag tied to the release. 4. Post in the incident channel.

## 연관 기억
- [[rollback-success-canary]]
