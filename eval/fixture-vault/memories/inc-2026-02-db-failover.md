---
id: mem-fx080
title: "2월 주 DB 장애조치 사건"
description: "디스크가 가득 차 복제본을 승격했고 쓰기가 40분 멈췄다"
type: episodic
tags:
  - "장애"
  - "데이터베이스"
  - "장애조치"
confidence: 0.6
storage_strength: 2
status: active
created: '2026-03-12T08:00:00.000Z'
updated: '2026-03-12T08:00:00.000Z'
last_accessed: '2026-03-12T08:00:00.000Z'
last_reinforced: '2026-03-12T08:00:00.000Z'
access_count: 2
links: []
history:
  - "2026-03-12: created"
---

WAL 이 쌓여 주 DB 디스크가 가득 찼다. 복제본을 승격하는 동안 쓰기가 40분 멈췄다. 디스크 사용률 알림 임계를 80% 로 낮췄다.
