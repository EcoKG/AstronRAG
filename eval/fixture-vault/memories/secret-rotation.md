---
id: mem-fx055
title: "Rotate a leaked secret"
description: "Revoke, issue a new one, update Vault, redeploy, audit logs"
type: procedural
tags:
  - "secret"
  - "security"
  - "rotation"
confidence: 0.6
storage_strength: 3
status: active
created: '2026-06-15T01:00:00.000Z'
updated: '2026-06-30T23:00:00.000Z'
last_accessed: '2026-06-30T23:00:00.000Z'
last_reinforced: '2026-06-30T23:00:00.000Z'
access_count: 6
links:
  - "secret-leaked-commit"
history:
  - "2026-06-15: created"
---

Revoke the exposed credential immediately, issue a replacement, store it in Vault, redeploy the consumers, and review access logs for the exposure window.

## 연관 기억
- [[secret-leaked-commit]]
