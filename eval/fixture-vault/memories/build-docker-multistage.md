---
id: mem-fx047
title: "Multi-stage Docker build"
description: "Build in node:20, copy dist into a slim runtime image"
type: procedural
tags:
  - "docker"
  - "build"
confidence: 0.8
storage_strength: 5
status: active
created: '2026-02-09T17:00:00.000Z'
updated: '2026-02-20T17:00:00.000Z'
last_accessed: '2026-02-20T17:00:00.000Z'
last_reinforced: '2026-02-20T17:00:00.000Z'
access_count: 8
links:
  - "docker-image-bloat"
history:
  - "2026-02-09: created"
---

Compile in a node:20 builder stage, run npm prune --omit=dev, and copy only dist and production node_modules into the runtime stage.

## 연관 기억
- [[docker-image-bloat]]
