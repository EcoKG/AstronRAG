---
id: mem-fx094
title: "윈도우 CI 경로 길이 실패"
description: "깊은 node_modules 때문에 체크아웃이 실패"
type: episodic
tags:
  - "windows"
  - "ci"
  - "경로"
confidence: 0.95
storage_strength: 2
status: active
created: '2026-03-20T10:00:00.000Z'
updated: '2026-04-11T10:00:00.000Z'
last_accessed: '2026-04-11T10:00:00.000Z'
last_reinforced: '2026-04-11T10:00:00.000Z'
access_count: 4
links:
  - "windows-path-length"
history:
  - "2026-03-20: created"
---

윈도우 러너에서 체크아웃이 파일 이름이 너무 길다는 오류로 실패했다. core.longpaths 를 켜서 해결했다.

## 연관 기억
- [[windows-path-length]]
