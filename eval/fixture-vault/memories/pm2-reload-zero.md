---
id: mem-fx074
title: "무중단 재시작"
description: "pm2 reload 로 워커를 순차 재시작한다"
type: procedural
tags:
  - "pm2"
  - "재시작"
  - "무중단"
confidence: 0.95
storage_strength: 7
status: active
created: '2026-01-19T14:00:00.000Z'
updated: '2026-01-21T14:00:00.000Z'
last_accessed: '2026-01-21T14:00:00.000Z'
last_reinforced: '2026-01-21T14:00:00.000Z'
access_count: 9
links: []
history:
  - "2026-01-19: created"
---

pm2 reload ecosystem.config.js 로 인스턴스를 하나씩 다시 띄운다. 앱이 SIGINT 를 받으면 진행 중 요청을 끝내고 종료해야 한다.
