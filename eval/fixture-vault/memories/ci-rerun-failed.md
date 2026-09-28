---
id: mem-fx050
title: "CI 실패 잡 재실행"
description: "gh run rerun --failed 로 실패한 잡만 다시 돌린다"
type: procedural
tags:
  - "ci"
  - "gh"
  - "재실행"
confidence: 0.6
storage_strength: 6
status: active
created: '2026-05-31T14:00:00.000Z'
updated: '2026-06-10T14:00:00.000Z'
last_accessed: '2026-06-10T14:00:00.000Z'
last_reinforced: '2026-06-10T14:00:00.000Z'
access_count: 8
links: []
history:
  - "2026-05-31: created"
---

gh run list 로 실행 번호를 찾고 gh run rerun <id> --failed 로 실패 잡만 다시 돌린다. 두 번 연속 실패하면 재실행하지 말고 원인을 본다.
