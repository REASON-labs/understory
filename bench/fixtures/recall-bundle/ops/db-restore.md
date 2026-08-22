---
type: runbook
title: Database Restore Runbook
description: Steps to restore Postgres.
tags: [runbook, database]
---

To restore: pick a base backup, replay WAL to a point in time, promote the clone, repoint the app. Validate row counts before cutover.
