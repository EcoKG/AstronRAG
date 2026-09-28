---
id: mem-fx056
title: "인증서 갱신 방법"
description: "certbot renew 후 nginx reload, 만료 30일 전 알림"
type: procedural
tags:
  - "인증서"
  - "tls"
  - "nginx"
confidence: 0.7
storage_strength: 1
status: active
created: '2026-02-02T08:00:00.000Z'
updated: '2026-02-10T08:00:00.000Z'
last_accessed: '2026-02-10T08:00:00.000Z'
last_reinforced: '2026-02-10T08:00:00.000Z'
access_count: 1
links:
  - "cert-expired-api"
history:
  - "2026-02-02: created"
---

certbot renew 를 실행하고 nginx -s reload 로 반영한다. 만료 30일 전에 알림이 오도록 모니터링을 걸어 둔다.

## 연관 기억
- [[cert-expired-api]]
