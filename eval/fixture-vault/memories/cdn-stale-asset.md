---
id: mem-fx105
title: "CDN served a stale robots.txt"
description: "The non-hashed path was cached for 7 days"
type: episodic
tags:
  - "cdn"
  - "cache"
  - "stale"
confidence: 0.6
storage_strength: 1
status: active
created: '2026-05-26T15:00:00.000Z'
updated: '2026-05-31T15:00:00.000Z'
last_accessed: '2026-05-31T15:00:00.000Z'
last_reinforced: '2026-05-31T15:00:00.000Z'
access_count: 2
links: []
history:
  - "2026-05-26: created"
---

robots.txt was updated but the CDN kept the old copy for a week because the path had the default long TTL.
