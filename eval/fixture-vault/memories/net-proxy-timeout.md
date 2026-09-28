---
id: mem-fx008
title: "Reverse proxy timeouts"
description: "nginx proxy_read_timeout is 60s for the API upstream"
type: semantic
tags:
  - "nginx"
  - "proxy"
  - "timeout"
confidence: 0.9
storage_strength: 6
status: active
created: '2026-05-07T08:00:00.000Z'
updated: '2026-05-31T08:00:00.000Z'
last_accessed: '2026-05-31T08:00:00.000Z'
last_reinforced: '2026-05-31T08:00:00.000Z'
access_count: 6
links: []
history:
  - "2026-05-07: created"
---

The API upstream uses proxy_read_timeout 60s and proxy_connect_timeout 5s. Report exports that run longer must go through the async job endpoint.
