---
id: mem-fx084
title: "시간대 때문에 깨진 테스트"
description: "UTC 러너에서 KST 를 가정한 테스트가 실패"
type: episodic
tags:
  - "테스트"
  - "시간대"
  - "flaky"
confidence: 0.95
storage_strength: 1
status: active
created: '2026-02-18T12:00:00.000Z'
updated: '2026-03-02T12:00:00.000Z'
last_accessed: '2026-03-02T12:00:00.000Z'
last_reinforced: '2026-03-02T12:00:00.000Z'
access_count: 1
links: []
history:
  - "2026-02-18: created"
---

로컬에서는 통과하던 날짜 테스트가 UTC 로 도는 러너에서 자정 근처에만 실패했다. 테스트에 시간대를 고정했다.
