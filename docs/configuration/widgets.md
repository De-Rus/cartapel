---
description: "Every built-in widget, grouped by kind, with its params and a minimal example each — plus custom:<name> web-component widgets."
---

# Widgets

## Widget library

Set `widget = "<name>"`. Widgets that take parameters read them from the field's
`params` map. Unlisted `params` keys are ignored.

### Text & structured

| Widget | Renders | Notable `params` |
| --- | --- | --- |
| `text` | Plain text (the default). | — |
| `textarea` | Multi-line text; wraps in detail, truncates in lists. | — |
| `code` | Monospace code block; syntax-aware in detail. | `lang` (e.g. `python`, `sql`) |
| `json` | Pretty JSON tree in detail, compact preview in lists. | — |
| `masked` | Renders the (already-masked) value in monospace. | — |
| `truncate` | Truncates to N chars with a full-value tooltip. | `chars` (default 40) |
| `copyable` | Value with a click-to-copy affordance. | — |
| `uuid` | Shortened UUID with click-to-copy. | — |

```hcl
field "bio"      { widget = "textarea" }
field "payload"  { widget = "code"; params = { lang = "sql" } }
field "settings" { widget = "json" }
field "notes"    { widget = "truncate"; params = { chars = 60 } }
field "ref"      { widget = "copyable" }
field "id"       { widget = "uuid" }
```

### Numbers

| Widget | Renders | Notable `params` |
| --- | --- | --- |
| `number` | Right-aligned, grouped number. | — |
| `money` | Currency-formatted amount. | `currency` (e.g. `USD`) |
| `percent` | Percentage (negatives tinted in lists). | — |
| `duration` | Human duration from a seconds value. | — |
| `bytes` | Human byte size. | — |
| `progress` | A horizontal bar with the number beside it. | `max` (default 100), `warn_at`, `color`, `show` (`percent` default, `value`, `ratio`, `none`) |
| `rating` | A row of icons (e.g. stars). | `max` (default 5), `icon` (default `★`) |
| `trend` | Signed value with ▲/▼ arrow, colored by sign. | — |
| `heatcell` | A cell tinted by magnitude within a range. | `min` (default 0), `max` (default 100) |

```hcl
field "price"  { widget = "money"; params = { currency = "USD" } }
field "margin" { widget = "percent" }
field "uptime" { widget = "duration" }
field "size"   { widget = "bytes" }
field "quota"  { widget = "progress"; params = { max = 100, warn_at = 90 } }
field "stars"  { widget = "rating"; params = { max = 5 } }
field "delta"  { widget = "trend" }
field "score"  { widget = "heatcell"; params = { min = 0, max = 100 } }
```

### Booleans & enums

| Widget | Renders | Notable `params` |
| --- | --- | --- |
| `toggle` | A check / dash for truthy / falsy. | — |
| `badge` | A colored badge from a value → color map. | `colors`, `labels` (value → printed text), `fallback` (color when no key matches) |
| `pill` | Same as `badge` (pill styling). | `colors`, `labels`, `fallback` |
| `tags` | Splits a list/CSV value into multiple badges. | `colors` |

```hcl
field "active" { widget = "toggle" }
field "tags"   { widget = "tags"; params = { colors = { urgent = "red" } } }
```

The `colors` param maps values to one of `blue`, `green`, `orange`, `red`,
`violet`, `gray`:

```hcl
field "status" {
  widget = "badge"
  params = { colors = { active = "green", past_due = "orange", cancelled = "gray" } }
}
```

### Time

| Widget | Renders | Notable `params` |
| --- | --- | --- |
| `datetime` | Localized date + time. | — |
| `relative_time` | "3 minutes ago", tinted when stale. | `warn_after` (seconds; older values warn) |

```hcl
field "renews_at" {
  widget = "relative_time"
  params = { warn_after = 900 }
}
```

### Links, email, phone, URL

| Widget | Renders | Notable `params` |
| --- | --- | --- |
| `link` / `url` | A hyperlink; target from `href` or `params.href`. | `href` (template), `new_tab` (bool) |
| `email` | A `mailto:` link. | — |
| `phone` | A `tel:` link. | — |

```hcl
field "homepage" {
  widget = "url"
  params = { href = "{homepage}", new_tab = true }
}
```

### Media & identity

| Widget | Renders | Notable `params` |
| --- | --- | --- |
| `image` | An inline image from a URL/data-URL value. | — |
| `avatar` | A small (optionally round) avatar image. | `size` (12–96, default 24), `rounded` (default true) |
| `color` | A swatch + the color string. | — |
| `country` / `flag` | A flag emoji + the country code. | — |

```hcl
field "logo_url"    { widget = "image" }   # a URL/data-URL column — not an upload; see Uploads
field "avatar_url"  { widget = "avatar"; params = { size = 32, rounded = true } }
field "brand_color" { widget = "color" }
field "region"       { widget = "country" }
```

### Relations & arrays

| Widget | Renders | Notable `params` |
| --- | --- | --- |
| `fk` | A link to the referenced record, using its label. | `target` (table), `target_column` |
| `array` | Each array element as a small chip. | — |

```hcl
field "owner_id" { widget = "fk"; params = { target = "users" } }
field "labels"   { widget = "array" }
```

Foreign-key columns are detected during introspection and render automatically
as links showing the **target row's label** — its name-ish column (`name`,
`title`, `symbol`, `email`, `label`, else the first text column) — instead of
the raw id, in lists, detail views and inlines alike. Masked FK columns and
targets you cannot view fall back to the raw value. The `fk` widget is the
explicit form: set `params = { target = "..." }` to declare (or override) the
drill-through target when no database FK exists — for example on a computed
column — and `target_column` when the reference isn't the target's primary key.

## Custom widgets

Any widget name of the form `custom:<name>` loads a web component you ship in the
config bundle at `config/widgets/<name>.js`. It receives the full row and the
field's `params`. Unknown custom widgets fall back to the raw value — never a
crash.

```hcl
field "equity" {
  widget = "custom:sparkline"       # → /static/config/widgets/sparkline.js
  params = { field = "equity_curve", color = "blue" }
}
```

The three bundled custom widgets — `sparkline`, `statuspill`, `minibar` — and how
to author your own are covered in
[Pages & queries](/configuration/pages-and-queries#custom-widgets).
