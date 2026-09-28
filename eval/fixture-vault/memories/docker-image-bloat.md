---
id: mem-fx089
title: "Docker image grew to 2GB"
description: "devDependencies were copied into the runtime stage"
type: episodic
tags:
  - "docker"
  - "image"
  - "size"
confidence: 0.95
storage_strength: 5
status: active
created: '2026-03-05T23:00:00.000Z'
updated: '2026-04-11T23:00:00.000Z'
last_accessed: '2026-04-11T23:00:00.000Z'
last_reinforced: '2026-04-11T23:00:00.000Z'
access_count: 6
links: []
history:
  - "2026-03-05: created"
---

The runtime stage copied the whole node_modules including devDependencies and the image reached 2GB, slowing every deploy.
