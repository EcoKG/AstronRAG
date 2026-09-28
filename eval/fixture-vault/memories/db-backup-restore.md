---
id: mem-fx044
title: "DB 백업 복원 방법"
description: "pg_restore 로 스냅샷을 임시 인스턴스에 복원해 검증"
type: procedural
tags:
  - "백업"
  - "복원"
  - "postgres"
confidence: 0.95
storage_strength: 4
status: active
created: '2026-04-09T20:00:00.000Z'
updated: '2026-04-21T20:00:00.000Z'
last_accessed: '2026-04-21T20:00:00.000Z'
last_reinforced: '2026-04-21T20:00:00.000Z'
access_count: 4
links: []
history:
  - "2026-04-09: created"
---

최신 스냅샷을 내려받아 임시 인스턴스에 pg_restore 로 복원한다. 행 수와 최근 주문 시각을 확인한 뒤 인스턴스를 지운다.
