---
id: mem-fx109
title: "Bisect found the regression commit"
description: "Twelve steps led to a refactor that dropped a sort"
type: episodic
tags:
  - "bisect"
  - "regression"
  - "git"
confidence: 0.95
storage_strength: 7
status: active
created: '2026-05-04T19:00:00.000Z'
updated: '2026-05-21T19:00:00.000Z'
last_accessed: '2026-05-21T19:00:00.000Z'
last_reinforced: '2026-05-21T19:00:00.000Z'
access_count: 8
links: []
history:
  - "2026-05-04: created"
---

git bisect took twelve steps and pointed at a refactor that removed the ORDER BY from the export query.
