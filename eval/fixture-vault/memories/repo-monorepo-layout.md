---
id: mem-fx018
title: "Monorepo layout"
description: "apps/ holds deployables, packages/ holds shared libraries"
type: semantic
tags:
  - "monorepo"
  - "layout"
confidence: 0.9
storage_strength: 7
status: active
created: '2026-06-06T06:00:00.000Z'
updated: '2026-06-30T23:00:00.000Z'
last_accessed: '2026-06-30T23:00:00.000Z'
last_reinforced: '2026-06-30T23:00:00.000Z'
access_count: 9
links: []
history:
  - "2026-06-06: created"
---

Deployable services live under apps/ and shared libraries under packages/. A package may not import from apps/.
