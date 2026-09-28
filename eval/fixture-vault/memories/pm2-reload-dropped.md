---
id: mem-fx118
title: "reload 중 요청 유실"
description: "graceful shutdown 이 없어 진행 중 요청이 끊겼다"
type: episodic
tags:
  - "pm2"
  - "무중단"
  - "요청유실"
confidence: 0.9
storage_strength: 3
status: active
created: '2026-04-27T10:00:00.000Z'
updated: '2026-05-11T10:00:00.000Z'
last_accessed: '2026-05-11T10:00:00.000Z'
last_reinforced: '2026-05-11T10:00:00.000Z'
access_count: 5
links:
  - "pm2-reload-zero"
history:
  - "2026-04-27: created"
---

pm2 reload 를 했는데 앱이 종료 신호를 처리하지 않아 진행 중이던 요청이 끊겼다.

## 연관 기억
- [[pm2-reload-zero]]
