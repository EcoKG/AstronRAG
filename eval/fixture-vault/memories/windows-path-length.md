---
id: mem-fx022
title: "Windows long path limit"
description: "MAX_PATH 260 breaks deep node_modules unless LongPathsEnabled"
type: semantic
tags:
  - "windows"
  - "path"
  - "filesystem"
confidence: 0.8
storage_strength: 6
status: active
created: '2026-05-15T10:00:00.000Z'
updated: '2026-05-21T10:00:00.000Z'
last_accessed: '2026-05-21T10:00:00.000Z'
last_reinforced: '2026-05-21T10:00:00.000Z'
access_count: 8
links:
  - "windows-longpath-enable"
history:
  - "2026-05-15: created"
---

Windows still enforces MAX_PATH 260 for many tools. Deep node_modules trees fail to extract unless LongPathsEnabled is set.

## 연관 기억
- [[windows-longpath-enable]]
