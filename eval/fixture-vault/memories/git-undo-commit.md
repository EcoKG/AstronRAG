---
id: mem-fx052
title: "마지막 커밋 되돌리기"
description: "공유 브랜치는 revert, 로컬은 reset --soft"
type: procedural
tags:
  - "git"
  - "revert"
  - "커밋"
confidence: 0.8
storage_strength: 2
status: active
created: '2026-02-24T04:00:00.000Z'
updated: '2026-04-01T04:00:00.000Z'
last_accessed: '2026-04-01T04:00:00.000Z'
last_reinforced: '2026-04-01T04:00:00.000Z'
access_count: 2
links: []
history:
  - "2026-02-24: created"
---

이미 푸시한 공유 브랜치는 git revert 로 되돌린다. 푸시 전 로컬 커밋은 git reset --soft HEAD~1 로 풀어 다시 만든다.
