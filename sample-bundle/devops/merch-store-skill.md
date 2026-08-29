---
type: Playbook
title: Merch Store Skill
description: >-
  Procedural skill for creating print-ready merch designs using the merch-store
  pipeline.
tags:
  - merch
  - skill
  - hermes-agent
  - design
'resource}: ~/.hermes/profiles/personal-assistant/skills/merch-store/SKILL.md': -1
timestamp: '2026-08-22T19:09:59.786Z'
---
## Overview

The merch-store skill is a procedural skill for creating print-ready merch designs using the [merch-store pipeline](/devops/merch-store.md) at `~/designs/merch/`. It is the workflow layer on top of the pipeline's toolchain (resvg, validators, fonts).

## Activation

The skill activates when the user wants to:

- Create a merch design
- Render or export a print file
- Change text, fonts, or layout
- Ask about merch design constraints

## Workflow

1. **Activate venv:** `cd ~/designs/merch && source .venv/bin/activate`
2. **Plan:** text content, font choice (JetBrains Mono or IBM Plex Mono), product, aesthetic
3. **Create:** `designs/<name>/source.svg` with proper dimensions and font-family references
4. **Render:** `./templates/render.sh <name> <product>` — runs font lint → resvg → print validation
5. **Verify:** all checks must pass (no ✗ failures)
6. **Commit:** `git add designs/<name>/ && git commit`

## Design Constraints (documented by skill)

- Hard edges only — no blur, no gradient-to-transparent
- Transparent background required
- sRGB color
- Font licensing compliance (font families must match licensed files in `fonts/`)

## Product Dimension Presets

The skill documents the same product presets as the pipeline:

| Product | Dimensions | Print width | DPI floor |
|---------|-----------|-------------|-----------|
| tee-front | 4500×5400 | 15" | 150 |
| tee-front-12x16 | 3600×4800 | 12" | 150 |
| tee-back | 4500×5400 | 15" | 150 |
| sticker-4in | 1200×1200 | 4" | 300 |
| sticker-bumper | 3000×900 | 10" | 300 |

## Troubleshooting

The skill covers common issues: font lint failures, resvg rendering errors, and print validation failures — with guidance on how to iterate on designs.

# Troubleshooting

The skill covers common issues: font lint failures, resvg rendering errors, and print validation failures — with guidance on how to iterate on designs.

## Related Skills

- [Merch Design Skill](/devops/merch-design-skill.md) — procedural skill for terminal/typed-text style designs targeting Printful.
