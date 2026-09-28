---
id: mem-fx076
title: "개인정보 마스킹 스크립트 실행"
description: "복원 직후 scripts/mask.sql 을 실행한다"
type: procedural
tags:
  - "마스킹"
  - "개인정보"
  - "스크립트"
confidence: 0.7
storage_strength: 3
status: active
created: '2026-04-03T04:00:00.000Z'
updated: '2026-05-01T04:00:00.000Z'
last_accessed: '2026-05-01T04:00:00.000Z'
last_reinforced: '2026-05-01T04:00:00.000Z'
access_count: 3
links: []
history:
  - "2026-04-03: created"
---

운영 스냅샷을 복원한 직후 psql -f scripts/mask.sql 을 실행해 이름, 전화번호, 주소 컬럼을 가린다.
