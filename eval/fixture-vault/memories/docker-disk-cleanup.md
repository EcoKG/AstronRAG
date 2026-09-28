---
id: mem-fx068
title: "도커 디스크 정리"
description: "docker system prune -af --volumes 는 로컬에서만"
type: procedural
tags:
  - "docker"
  - "디스크"
  - "정리"
confidence: 0.9
storage_strength: 5
status: active
created: '2026-05-17T20:00:00.000Z'
updated: '2026-05-21T20:00:00.000Z'
last_accessed: '2026-05-21T20:00:00.000Z'
last_reinforced: '2026-05-21T20:00:00.000Z'
access_count: 5
links: []
history:
  - "2026-05-17: created"
---

로컬 디스크가 부족하면 docker system prune -af --volumes 로 정리한다. 공유 빌드 서버에서는 볼륨을 지우지 않는다.
