---
id: mem-fx075
title: "Fix VPN connection drops"
description: "Lower the MTU to 1380 and reconnect"
type: procedural
tags:
  - "vpn"
  - "mtu"
  - "network"
confidence: 0.6
storage_strength: 5
status: active
created: '2026-02-25T21:00:00.000Z'
updated: '2026-03-12T21:00:00.000Z'
last_accessed: '2026-03-12T21:00:00.000Z'
last_reinforced: '2026-03-12T21:00:00.000Z'
access_count: 8
links: []
history:
  - "2026-02-25: created"
---

If the VPN drops large transfers, set the tunnel MTU to 1380 in the client profile and reconnect.
