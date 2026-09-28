---
id: mem-fx095
title: "Korean text garbled in a generated file"
description: "PowerShell Set-Content wrote the file as CP949"
type: episodic
tags:
  - "encoding"
  - "powershell"
  - "korean"
confidence: 0.6
storage_strength: 7
status: active
created: '2026-04-26T17:00:00.000Z'
updated: '2026-05-31T17:00:00.000Z'
last_accessed: '2026-05-31T17:00:00.000Z'
last_reinforced: '2026-05-31T17:00:00.000Z'
access_count: 10
links: []
history:
  - "2026-04-26: created"
---

A release script used Set-Content and the changelog came out garbled when read as UTF-8. Switched to Out-File -Encoding utf8.
