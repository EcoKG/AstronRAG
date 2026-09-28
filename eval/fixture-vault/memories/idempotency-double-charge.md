---
id: mem-fx111
title: "Double charge without an idempotency key"
description: "The mobile client retried a POST on timeout"
type: episodic
tags:
  - "payment"
  - "idempotency"
  - "retry"
confidence: 0.7
storage_strength: 3
status: active
created: '2026-01-28T09:00:00.000Z'
updated: '2026-01-31T09:00:00.000Z'
last_accessed: '2026-01-31T09:00:00.000Z'
last_reinforced: '2026-01-31T09:00:00.000Z'
access_count: 6
links: []
history:
  - "2026-01-28: created"
---

An old mobile client retried the payment POST after a timeout without an Idempotency-Key and 40 customers were charged twice.
