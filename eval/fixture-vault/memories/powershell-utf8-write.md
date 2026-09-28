---
id: mem-fx066
title: "PowerShell 에서 UTF-8 로 파일 쓰기"
description: "Out-File -Encoding utf8 또는 .NET WriteAllText 를 쓴다"
type: procedural
tags:
  - "powershell"
  - "utf8"
  - "인코딩"
confidence: 0.7
storage_strength: 2
status: active
created: '2026-03-04T06:00:00.000Z'
updated: '2026-03-22T06:00:00.000Z'
last_accessed: '2026-03-22T06:00:00.000Z'
last_reinforced: '2026-03-22T06:00:00.000Z'
access_count: 4
links:
  - "powershell-encoding"
history:
  - "2026-03-04: created"
---

Out-File 과 Set-Content 에 -Encoding utf8 을 준다. BOM 이 없어야 하면 [IO.File]::WriteAllText 에 UTF8Encoding($false) 를 넘긴다.

## 연관 기억
- [[powershell-encoding]]
