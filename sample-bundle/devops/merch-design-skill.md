---
type: Playbook
title: Merch Design Skill
description: >-
  Procedural skill for creating print-ready t-shirt and sticker designs
  targeting Printful, in the terminal/typed-text house style.
tags:
  - merch
  - skill
  - hermes-agent
  - design
  - printful
'resource}: ~/.hermes/profiles/personal-assistant/skills/merch-design/SKILL.md': null
timestamp: '2026-08-22T19:09:40.725Z'
---
## Overview

The merch-design skill is a procedural skill for creating print-ready t-shirt and sticker designs targeting **Printful**, in the terminal/typed-text house style. The skill's job ends at a validated print file on disk — it never touches Printful, never publishes, never orders, and never uses credentials.

## Structure

- **`SKILL.md`** — 7 hard rules (never modify scripts, never bypass gates, content prohibitions, flat fills only, two-attempt cap, verbatim evidence, no steering text), 5-step procedure (verify → plan → author SVG → render → handoff), failure guide, font family list
- **`reference/print-specs.md`** — product table (tee-front 4500×5400, tee-front-12x16 3600×4800, tee-back 4500×5400, sticker-4in 1200×1200, sticker-bumper 3000×900), general requirements (PNG, sRGB, RGBA, 0.5" safe zone)

## 7 Hard Rules

1. Never modify scripts
2. Never bypass gates
3. Content prohibitions enforced
4. Flat fills only — no gradients
5. Two-attempt cap per iteration
6. Verbatim evidence required
7. No steering text

## 5-Step Procedure

1. **Verify** — confirm product specs and constraints
2. **Plan** — text content, font choice, product, aesthetic
3. **Author SVG** — create `source.svg` with proper dimensions and font-family references
4. **Render** — run `render.sh` to produce print-ready PNG
5. **Handoff** — deliver validated print file on disk

## Design Constraints

- Hard edges only — no blur, no gradient-to-transparent
- Transparent background required
- sRGB color
- Font families must match licensed files in `fonts/`

## Related

- [Merch Store Skill](/devops/merch-store-skill.md) — the companion skill for the merch-store pipeline
- [Merch Store Print Design Pipeline](/devops/merch-store.md) — the underlying pipeline at `~/designs/merch/`
