---
id: mem-fx063
title: "Add a new API version"
description: "Copy routes under /v2 and keep v1 for six months with a Deprecation header"
type: procedural
tags:
  - "api"
  - "versioning"
confidence: 0.9
storage_strength: 1
status: active
created: '2026-05-02T09:00:00.000Z'
updated: '2026-05-21T09:00:00.000Z'
last_accessed: '2026-05-21T09:00:00.000Z'
last_reinforced: '2026-05-21T09:00:00.000Z'
access_count: 4
links: []
history:
  - "2026-05-02: created"
---

Create the /v2 router, keep /v1 running for six months, and add a Deprecation header with the sunset date to v1 responses.
