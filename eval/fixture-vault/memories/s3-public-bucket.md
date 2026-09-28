---
id: mem-fx117
title: "Bucket accidentally public"
description: "The thumb/ prefix policy opened raw/ as well"
type: episodic
tags:
  - "s3"
  - "security"
  - "bucket"
confidence: 0.8
storage_strength: 5
status: active
created: '2026-03-21T03:00:00.000Z'
updated: '2026-03-22T03:00:00.000Z'
last_accessed: '2026-03-22T03:00:00.000Z'
last_reinforced: '2026-03-22T03:00:00.000Z'
access_count: 6
links: []
history:
  - "2026-03-21: created"
---

A policy meant for thumb/ used a wildcard and made raw/ uploads publicly readable for three hours.
