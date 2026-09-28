---
id: mem-fx007
title: "사내 VPN 대역"
description: "VPN 은 10.8.0.0/16 대역을 쓴다"
type: semantic
tags:
  - "네트워크"
  - "vpn"
  - "대역"
confidence: 0.8
storage_strength: 1
status: active
created: '2026-03-31T01:00:00.000Z'
updated: '2026-04-11T01:00:00.000Z'
last_accessed: '2026-04-11T01:00:00.000Z'
last_reinforced: '2026-04-11T01:00:00.000Z'
access_count: 4
links: []
history:
  - "2026-03-31: created"
---

사내 VPN 클라이언트는 10.8.0.0/16 대역을 받는다. 개발 서버 대역과 겹치지 않도록 도커 기본 브리지는 172.30.0.0/16 으로 옮겼다.
