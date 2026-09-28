---
id: mem-fx064
title: "DLQ 메시지 재처리"
description: "원인을 고친 뒤 shovel 로 원래 큐에 되돌린다"
type: procedural
tags:
  - "rabbitmq"
  - "dlq"
  - "재처리"
confidence: 0.95
storage_strength: 6
status: active
created: '2026-06-08T16:00:00.000Z'
updated: '2026-06-30T23:00:00.000Z'
last_accessed: '2026-06-30T23:00:00.000Z'
last_reinforced: '2026-06-30T23:00:00.000Z'
access_count: 6
links:
  - "queue-rabbitmq-dlq"
history:
  - "2026-06-08: created"
---

원인을 고친 배포가 끝난 뒤 RabbitMQ shovel 로 orders.dlq 의 메시지를 원래 큐로 옮긴다. 옮기기 전에 개수를 기록한다.

## 연관 기억
- [[queue-rabbitmq-dlq]]
