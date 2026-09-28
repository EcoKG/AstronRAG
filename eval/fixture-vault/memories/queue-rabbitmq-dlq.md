---
id: mem-fx024
title: "RabbitMQ dead letter queue"
description: "Failed jobs move to orders.dlq after 5 retries"
type: semantic
tags:
  - "rabbitmq"
  - "queue"
  - "dlq"
confidence: 0.95
storage_strength: 2
status: active
created: '2026-02-08T00:00:00.000Z'
updated: '2026-03-12T00:00:00.000Z'
last_accessed: '2026-03-12T00:00:00.000Z'
last_reinforced: '2026-03-12T00:00:00.000Z'
access_count: 2
links: []
history:
  - "2026-02-08: created"
---

Order jobs retry 5 times with exponential backoff, then move to orders.dlq. The DLQ has no TTL and must be drained manually.
