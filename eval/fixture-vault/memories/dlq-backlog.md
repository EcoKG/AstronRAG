---
id: mem-fx096
title: "DLQ 적체 사건"
description: "외부 API 한도 초과로 주문 메시지 3천 건이 DLQ 로"
type: episodic
tags:
  - "dlq"
  - "큐"
  - "한도"
confidence: 0.7
storage_strength: 5
status: active
created: '2026-06-02T00:00:00.000Z'
updated: '2026-06-10T00:00:00.000Z'
last_accessed: '2026-06-10T00:00:00.000Z'
last_reinforced: '2026-06-10T00:00:00.000Z'
access_count: 5
links: []
history:
  - "2026-06-02: created"
---

결제 대행사 한도에 걸려 주문 메시지 3천 건이 재시도 끝에 DLQ 로 넘어갔다. 한도를 늘린 뒤 재처리했다.
