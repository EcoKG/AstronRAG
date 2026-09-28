---
id: mem-fx091
title: "Review missed a null check"
description: "An optional field crashed checkout for guest users"
type: episodic
tags:
  - "review"
  - "bug"
  - "checkout"
confidence: 0.7
storage_strength: 1
status: active
created: '2026-05-18T13:00:00.000Z'
updated: '2026-06-10T13:00:00.000Z'
last_accessed: '2026-06-10T13:00:00.000Z'
last_reinforced: '2026-06-10T13:00:00.000Z'
access_count: 4
links: []
history:
  - "2026-05-18: created"
---

A PR assumed customer.email was always present. Guest checkouts crashed for an hour before the hotfix.
