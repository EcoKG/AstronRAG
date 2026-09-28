---
id: mem-fx011
title: "시크릿 보관 위치"
description: "운영 시크릿은 Vault KV 에만 두고 .env 커밋 금지"
type: semantic
tags:
  - "보안"
  - "시크릿"
  - "vault"
confidence: 0.7
storage_strength: 7
status: active
created: '2026-03-09T05:00:00.000Z'
updated: '2026-04-01T05:00:00.000Z'
last_accessed: '2026-04-01T05:00:00.000Z'
last_reinforced: '2026-04-01T05:00:00.000Z'
access_count: 10
links: []
history:
  - "2026-03-09: created"
---

운영 시크릿은 HashiCorp Vault KV 경로에만 둔다. 저장소의 .env 파일은 예시 값만 담고, 실제 값을 커밋하면 pre-commit 훅이 막는다.
