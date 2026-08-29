---
type: Playbook
title: Merch Store Print Design Pipeline
description: >-
  Local print design pipeline at ~/designs/merch/ for creating print-ready PNG
  files targeting Printful + Quick Stores.
tags:
  - merch
  - printful
  - resvg
  - design
  - hermes-agent
timestamp: '2026-08-22T19:09:59.791Z'
---
## Overview

The merch store is a local print design pipeline at `~/designs/merch/` for creating print-ready PNG files targeting **Printful** + **Quick Stores**. It is **Phase 1** of a planned merch store feature.

## Architecture

The pipeline has three stages, each enforced as a hard gate:

### 1. Font lint (`templates/font_lint.py`)

Every font-family reference in the SVG must resolve to a licensed font file in `fonts/`. Uses **fontTools** to read the actual font name table, not just filenames. Prevents silent font substitution by resvg.

### 2. Render (`templates/render.sh`)

A bash wrapper around **resvg** with locked font flags: `--skip-system-fonts` and `--use-fonts-dir fonts/`. Never call resvg directly. Accepts a design name and product, looks up dimensions, renders to `designs/<name>/print/<name>-<product>.png`.

### 3. Print validation (`templates/verify_printfile.py`)

Byte-level check of the rendered PNG against Printful's spec. Checks:

- Format (PNG)
- Dimensions (exact match)
- Alpha channel (must have transparent pixels)
- Perimeter alpha (hard edges only — detects feathered/gradient edges that would print as white halos on dark garments via DTG underbase)
- Safe zone (0.5" margin)
- DPI floor
- File size (<200MB)

## Installed Components

- **Python venv** (`~/.venv`): fonttools, pillow, numpy. Must be activated before use.
- **resvg v0.48.1**: prebuilt binary at `/usr/local/bin/resvg`. Renders SVG to PNG.
- **Fonts**: JetBrains Mono (4 faces, Apache-2.0), IBM Plex Mono (16 faces, OFL). All TTF in `fonts/`.
- **Templates**: `render.sh`, `font_lint.py`, `verify_printfile.py`, `canvas-tee.svg` (15"x18" starter template).

## Product Presets

| Product | Dimensions | Print width | DPI floor |
|---------|-----------|-------------|-----------|
| tee-front | 4500×5400 | 15" | 150 |
| tee-front-12x16 | 3600×4800 | 12" | 150 |
| tee-back | 4500×5400 | 15" | 150 |
| sticker-4in | 1200×1200 | 4" | 300 |
| sticker-bumper | 3000×900 | 10" | 300 |

## Usage

```bash
cd ~/designs/merch && source .venv/bin/activate
./templates/render.sh <design-name> <product>
```

## Design Constraints

- **Hard edges only** — no blur, no gradient-to-transparent. Anti-aliased text (1px fringe) is acceptable.
- **Transparent background required** — every design must have α=0 pixels.
- **sRGB color** — resvg outputs untagged RGBA which Printful reads as sRGB.
- **Font families** must match the internal name table of font files in `fonts/`.

## First Design

`hello-world` — terminal prompt aesthetic (`$ whoami → jaybb`) rendered to `tee-front`. All 9 validation checks passed.

## Hermes Agent Role

Phase 1 supports interactive design authoring. The Hermes agent can create SVGs, run `render.sh`, interpret validation output, and iterate on designs. Phase 3 will add limited API access for Printful product read/write (draft-only, no live-send).

See [Understory Service](/services/understory.md) for the underlying AI agent infrastructure.

# Hermes Agent Role

Phase 1 supports interactive design authoring. The Hermes agent can create SVGs, run `render.sh`, interpret validation output, and iterate on designs. Phase 3 will add limited API access for Printful product read/write (draft-only, no live-send).

See [Understory Service](/services/understory.md) for the underlying AI agent infrastructure.

The [merch-store skill](/devops/merch-store-skill.md) is the procedural workflow layer that guides users through planning, creating, rendering, verifying, and committing designs using this pipeline.

The [merch-design skill](/devops/merch-design-skill.md) is the companion skill for terminal/typed-text style designs targeting Printful.
