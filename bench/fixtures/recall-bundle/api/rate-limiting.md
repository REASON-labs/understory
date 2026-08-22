---
type: concept
title: Rate Limiting
description: How request throttling works.
tags: [api, limits]
---

A token-bucket throttle caps requests per key. Exceeding it returns HTTP 429 with a Retry-After header.
