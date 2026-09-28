---
id: mem-fx093
title: "Canary caught a bad release"
description: "Error rate on the 10% canary triggered an automatic rollback"
type: episodic
tags:
  - "canary"
  - "rollback"
  - "release"
confidence: 0.9
storage_strength: 4
status: active
created: '2026-02-11T03:00:00.000Z'
updated: '2026-02-20T03:00:00.000Z'
last_accessed: '2026-02-20T03:00:00.000Z'
last_reinforced: '2026-02-20T03:00:00.000Z'
access_count: 5
links:
  - "deploy-rollback-steps"
history:
  - "2026-02-11: created"
---

The 10% canary showed a 4% error rate within six minutes and the pipeline rolled back automatically.

## 연관 기억
- [[deploy-rollback-steps]]
