---
id: mem-fx083
title: "Build broke from lockfile drift"
description: "npm install on CI changed transitive versions"
type: episodic
tags:
  - "build"
  - "lockfile"
  - "ci"
confidence: 0.9
storage_strength: 3
status: active
created: '2026-01-12T05:00:00.000Z'
updated: '2026-02-20T05:00:00.000Z'
last_accessed: '2026-02-20T05:00:00.000Z'
last_reinforced: '2026-02-20T05:00:00.000Z'
access_count: 6
links: []
history:
  - "2026-01-12: created"
---

CI ran npm install instead of npm ci, pulled a new transitive version, and the build failed on a type error. Switched CI to npm ci.
