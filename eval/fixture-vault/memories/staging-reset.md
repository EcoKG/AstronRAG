---
id: mem-fx069
title: "Reset the staging database"
description: "Run make staging-reset to restore the masked Monday snapshot"
type: procedural
tags:
  - "staging"
  - "reset"
  - "db"
confidence: 0.95
storage_strength: 3
status: active
created: '2026-01-04T03:00:00.000Z'
updated: '2026-01-21T03:00:00.000Z'
last_accessed: '2026-01-21T03:00:00.000Z'
last_reinforced: '2026-01-21T03:00:00.000Z'
access_count: 4
links: []
history:
  - "2026-01-04: created"
---

Run make staging-reset from the ops repo. It restores the masked Monday snapshot and reapplies pending migrations.
