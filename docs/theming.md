---
description: "Make cartapel look like your product — presets, accent colors, per-mode design tokens and logos, all from one HCL block."
---

# Theming

cartapel ships dark-first with a clean default look, and everything visual is
overridable from one `theme { }` block in `config/cartapel.hcl`. No CSS files,
no rebuild — it hot-reloads like the rest of the config.

## Basics

Pick a preset and an accent, and you're done:

```hcl
brand      = "Acme Admin"
brand_logo = "logo.svg"        # a bundle asset (served from /static), URL or data URL

theme {
  preset = "cartapel"           # "cartapel" (default) | "django"
  accent = "hsl(33 100% 50%)"  # any CSS color
  mode   = "auto"              # "light" | "dark" | "auto" (default)
}
```

| Key | What it does |
| --- | --- |
| `preset` | Named base theme. `cartapel` is the default dark look; `django` mimics the classic Django-admin palette. |
| `accent` | The highlight color — links, active states, focus rings. |
| `accent_btn` | Primary-button color when you want it different from `accent`. |
| `mode` | Force `light` or `dark`, or follow the visitor's OS with `auto`. |
| `logo_light` / `logo_dark` | Per-mode brand logo, overriding `brand_logo` for that mode. |

## Advanced: design tokens

Every color in the UI is a CSS token you can override per mode with the
`light { }` / `dark { }` maps. Keys are token names without the `--` prefix:

```hcl
theme {
  dark = {
    page      = "#0b0e14"      # app background
    surface   = "#11151d"      # cards, panels
    accent    = "#7c9cf5"
    good      = "#2fbf71"
    critical  = "#e5484d"
  }
  light = {
    page = "#fafafa"
  }
}
```

The token vocabulary:

| Token | Role |
| --- | --- |
| `page` | App background. |
| `surface`, `surface-1`…`surface-3` | Card / panel layers, lightest to most elevated. |
| `ink`, `sec`, `muted` | Text: primary, secondary, de-emphasized. |
| `accent`, `accent-btn`, `accent-btn-ink` | Highlight color, primary buttons, their text. |
| `border`, `gridline`, `hover`, `press`, `selected` | Lines and interaction states. |
| `good`, `warning`, `serious`, `critical` | Semantic status colors (badges, alerts, deltas). |
| `band`, `band-ink`, `band-border` | The table header band. |
| `s1`…`s5` | Chart series palette. |

Custom pages and widgets built with the [sx SDK](/configuration/pages-and-queries)
consume the same tokens (`var(--accent)`, `var(--surface-2)`, …), so they
restyle together with the rest of the panel.

## Recipes

**Match your product's brand** — set `accent` (and `accent_btn` if your brand
color is too light for white button text).

**A light-only internal tool** — `mode = "light"` plus a `light { }` map.

**The Django look** — `preset = "django"` gives the familiar dark-header,
light-body admin; layer accent/tokens on top as usual.
