---
id: mem-fx023
title: "PowerShell 5.1 인코딩 기본값"
description: "Set-Content 는 시스템 ANSI 코드페이지로 쓴다"
type: semantic
tags:
  - "powershell"
  - "인코딩"
  - "windows"
confidence: 0.9
storage_strength: 4
status: active
created: '2026-01-02T17:00:00.000Z'
updated: '2026-01-21T17:00:00.000Z'
last_accessed: '2026-01-21T17:00:00.000Z'
last_reinforced: '2026-01-21T17:00:00.000Z'
access_count: 7
links: []
history:
  - "2026-01-02: created"
---

Windows PowerShell 5.1 의 Set-Content 와 Add-Content 는 기본으로 ANSI 코드페이지(CP949)로 쓴다. 다른 도구가 읽을 파일은 인코딩을 명시해야 한다.
