---
id: mem-fx100
title: "VPN 접속 끊김 원인 발견"
description: "공유기 MTU 1500 이 원인이었고 1380 으로 해결"
type: episodic
tags:
  - "vpn"
  - "mtu"
  - "네트워크"
confidence: 0.6
storage_strength: 4
status: active
created: '2026-05-11T04:00:00.000Z'
updated: '2026-05-31T04:00:00.000Z'
last_accessed: '2026-05-31T04:00:00.000Z'
last_reinforced: '2026-05-31T04:00:00.000Z'
access_count: 4
links:
  - "vpn-connect-trouble"
history:
  - "2026-05-11: created"
---

재택 근무자 여럿이 큰 파일을 받을 때 VPN 이 끊겼다. 터널 MTU 를 1380 으로 낮추자 멈췄다.

## 연관 기억
- [[vpn-connect-trouble]]
