---
id: mem-fx058
title: "로그 검색하는 법"
description: "Grafana Explore 에서 LogQL 로 request_id 필터"
type: procedural
tags:
  - "로그"
  - "loki"
  - "grafana"
confidence: 0.9
storage_strength: 4
status: active
created: '2026-04-17T22:00:00.000Z'
updated: '2026-05-21T22:00:00.000Z'
last_accessed: '2026-05-21T22:00:00.000Z'
last_reinforced: '2026-05-21T22:00:00.000Z'
access_count: 6
links: []
history:
  - "2026-04-17: created"
---

Grafana Explore 에서 Loki 데이터소스를 고르고 {app="api"} |= "request_id" 처럼 LogQL 로 거른다.
