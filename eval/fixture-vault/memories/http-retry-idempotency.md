---
id: mem-fx036
title: "Idempotency keys"
description: "POST payment endpoints require an Idempotency-Key header"
type: semantic
tags:
  - "api"
  - "idempotency"
  - "payment"
confidence: 0.7
storage_strength: 6
status: active
created: '2026-05-23T12:00:00.000Z'
updated: '2026-06-20T12:00:00.000Z'
last_accessed: '2026-06-20T12:00:00.000Z'
last_reinforced: '2026-06-20T12:00:00.000Z'
access_count: 6
links: []
history:
  - "2026-05-23: created"
---

Payment POST endpoints reject requests without an Idempotency-Key header. Keys are remembered for 24 hours.
