---
id: mem-fx099
title: "Major upgrade broke date parsing"
description: "date-fns v3 changed its default imports"
type: episodic
tags:
  - "dependencies"
  - "upgrade"
  - "breaking"
confidence: 0.95
storage_strength: 6
status: active
created: '2026-04-04T21:00:00.000Z'
updated: '2026-04-11T21:00:00.000Z'
last_accessed: '2026-04-11T21:00:00.000Z'
last_reinforced: '2026-04-11T21:00:00.000Z'
access_count: 9
links: []
history:
  - "2026-04-04: created"
---

Renovate merged date-fns v3 and imports that relied on default exports broke at runtime in two services.
