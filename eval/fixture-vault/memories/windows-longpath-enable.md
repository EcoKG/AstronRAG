---
id: mem-fx065
title: "Enable long paths on Windows"
description: "Set LongPathsEnabled=1 and git config core.longpaths true"
type: procedural
tags:
  - "windows"
  - "git"
  - "path"
confidence: 0.6
storage_strength: 4
status: active
created: '2026-01-26T23:00:00.000Z'
updated: '2026-01-31T23:00:00.000Z'
last_accessed: '2026-01-31T23:00:00.000Z'
last_reinforced: '2026-01-31T23:00:00.000Z'
access_count: 5
links: []
history:
  - "2026-01-26: created"
---

Set the LongPathsEnabled registry value to 1, reboot, and run git config --system core.longpaths true.
