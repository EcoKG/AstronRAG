---
id: mem-fx001
title: "읽기 복제본 지연 특성"
description: "리포트 쿼리는 복제본으로 보내고 지연은 평균 2초"
type: semantic
tags:
  - "데이터베이스"
  - "복제본"
  - "지연"
confidence: 0.7
storage_strength: 6
status: active
created: '2026-02-07T07:00:00.000Z'
updated: '2026-02-20T07:00:00.000Z'
last_accessed: '2026-02-20T07:00:00.000Z'
last_reinforced: '2026-02-20T07:00:00.000Z'
access_count: 7
links: []
history:
  - "2026-02-07: created"
---

분석 리포트 쿼리는 읽기 복제본으로 보낸다. 복제 지연은 평소 2초 안팎이고 대량 적재 때는 30초까지 늘어난다. 결제 직후 조회는 주 DB 에서 읽어야 한다.
