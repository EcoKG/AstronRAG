---
id: mem-fx132
title: "오류 처리 방식"
description: "예외를 삼키지 말고 경계에서 한 번만 로깅한다"
type: preference
tags:
  - "오류처리"
  - "로깅"
confidence: 0.8
storage_strength: 3
status: active
created: '2026-05-05T12:00:00.000Z'
updated: '2026-06-10T12:00:00.000Z'
last_accessed: '2026-06-10T12:00:00.000Z'
last_reinforced: '2026-06-10T12:00:00.000Z'
access_count: 3
links: []
history:
  - "2026-05-05: created"
---

예외를 빈 catch 로 삼키지 않는다. 로깅은 요청 경계에서 한 번만 하고 안쪽에서는 다시 던진다.
