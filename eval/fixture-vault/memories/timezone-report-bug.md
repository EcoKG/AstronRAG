---
id: mem-fx098
title: "리포트 날짜 하루 어긋남"
description: "UTC 날짜를 그대로 잘라 써서 KST 자정 전후 오차"
type: episodic
tags:
  - "시간대"
  - "리포트"
  - "버그"
confidence: 0.9
storage_strength: 1
status: active
created: '2026-02-26T14:00:00.000Z'
updated: '2026-04-01T14:00:00.000Z'
last_accessed: '2026-04-01T14:00:00.000Z'
last_reinforced: '2026-04-01T14:00:00.000Z'
access_count: 3
links: []
history:
  - "2026-02-26: created"
---

일별 리포트가 UTC 날짜 문자열을 잘라 써서 KST 오전 9시 이전 주문이 전날로 집계됐다.
