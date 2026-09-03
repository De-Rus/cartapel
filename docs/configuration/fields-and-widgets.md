---
description: "Per-column control: labels, widgets, formats, colors, masking, computed columns and custom web-component widgets."
---

# Fields & widgets

A `field "column" { }` block controls how one column is rendered and edited. Only
the columns you want to customize need a block; the rest use introspected
defaults.

```hcl
field "price" {
  label  = "Unit price"
  widget = "money"
  params = { currency = "USD" }
  format = "currency"
  prefix = "$"
  color  = "sign"
}
```

## Field options

| Key | Type | Description |
| --- | --- | --- |
| `label` | string | Override the column header / detail label. |
| `labels` | map | Per-locale label overrides (`labels = { es = "Precio" }`); the instance `locale` picks one, `label` is the fallback. |
| `widget` | string | The renderer — a built-in name or `custom:<name>`. See the [widget library](#widget-library). |
| `readonly` | bool | Field is shown but not editable (per-field variant of `edit.readonly`). |
| `masked` | bool | Value is masked in lists, detail, search and export — for **everyone, admins included**. Secret-shaped columns (names containing `token`, `secret`, `password`, `api_key`, `private_key`, …) mask automatically even without a field block; declaring **any** `field` block for such a column takes back control (add `masked = true` to keep it hidden). See [Security](/security#column-masking). |
| `sql` | string | A trusted SQL expression that makes this a **computed, read-only column** (see below). |
| `sortable` | bool | Computed columns only: list sort orders by the `sql` expression (see [Computed columns](#computed-columns-sql)). |
| `sort_by` | string | Computed columns only: sort by another **real** column instead of the expression. |
| `group` | string | Detail-form section this field belongs to (an alternative to `detail { section { } }`). |
| `params` | map | Widget-specific parameters (see each widget). |
| `file` | block | Marks the field as uploadable (see [Uploads](#uploads)). `widget = "image"` decodes/resizes/re-encodes on upload; any other widget stores the bytes as uploaded. |
| `format` | string | A number/date formatter applied to the value. |
| `prefix` / `suffix` | string | Text prepended / appended to the displayed value. |
| `truncate` | number | Truncate the displayed string to N characters. |
| `display` | string | A `{column}` template that replaces the displayed text. |
| `href` | string | A `{column}` template turning the value into a link target. |
| `color` | string / block | Conditional coloring — a named strategy or a rule set (see [Conditional color](#conditional-color)). |

```hcl
field "customer_notes" {
  labels   = { es = "Notas del cliente" }
  readonly = true
  masked   = true
  group    = "Internal"
}
```

## Computed columns (`sql`)

A field with a `sql` expression is a **virtual, read-only column** that doesn't
exist in the table. cartapel selects it as `(<sql>) AS "<name>"`. The current row
is aliased `t`, so you can aggregate related tables:

```hcl
field "orders_30d" {
  label  = "Orders 30d"
  widget = "number"
  sql    = "(SELECT count(*) FROM orders o WHERE o.customer_id = t.id AND o.placed_at > now() - interval '30 days')::int"
}

field "age_days" {
  label  = "Age (days)"
  widget = "number"
  sql    = "extract(day from now() - t.created_at)::int"
}
```

The expression is trusted config, not user input, and is read-only.

By default a computed column is display-only. Make it **sortable** — like Django's
`@admin.display(ordering=…)`:

```hcl
field "line_total" {
  label    = "Line total"
  sql      = "t.qty * t.unit_price"
  sortable = true                 # list sort orders BY the expression
}

field "order_count" {
  label   = "Orders"
  sql     = "(SELECT count(*) FROM orders o WHERE o.customer_id = t.id)::int"
  sort_by = "created_at"          # …or sort by another real column instead
}
```

| Key | Description |
| --- | --- |
| `sortable` | Order the list by the `sql` expression when this column's header is used. |
| `sort_by` | Order by another **real** column instead of the expression. |

A `sort_by` that names a column a role has **masked** is refused for that role (so
ordering can't leak a hidden value). An `sql` expression that references a masked
column can still order by it — keep masked columns out of `sortable` expressions.

## Formatting

`format` runs the value through a formatter. The vocabulary is fixed:

| `format` | Renders |
| --- | --- |
| `currency` | Localized currency. |
| `percent` | Percentage. |
| `number` | Grouped number with separators. |
| `date` | Date only. |
| `datetime` | Date and time. |
| `bytes` | Human byte size (`1.4 MB`). |
| `duration` | Human duration from seconds. |

`prefix`, `suffix` and `truncate` are independent string tweaks you can combine
with any widget:

```hcl
field "win_rate" {
  format   = "percent"
  suffix   = "%"
  truncate = 40
}
```

## Interpolation: `display` and `href`

Both take a template with `{column}` placeholders filled from the row:

```hcl
field "name" {
  display = "{name} ({country})"
  href    = "https://crm.example/u/{id}"
}
```

`display` replaces the shown text; `href` makes the cell a link. (For an
explicit link widget with a new-tab option, see [`link` / `url`](#links-email-phone-url).)

## Conditional color

`color` tints a value based on its content. Two forms.

### Named strategies

```hcl
field "pnl" {
  format = "currency"
  color  = "sign"
}
```

| Strategy | Effect |
| --- | --- |
| `sign` | Positive green, negative red. |
| `positive` | Highlight positive values. |
| `negative` | Highlight negative values. |
| `stale` | Highlight stale / old values. |

### Rule sets

For explicit thresholds, use `color { rule "…" { class = "…" } }`. Rules are
evaluated in order; the first match wins.

```hcl
field "score" {
  color {
    rule ">0"          { class = "good" }
    rule "<0"          { class = "critical" }
    rule "between:1,2" { class = "warning" }
    rule "=n/a"        { class = "muted" }
  }
}
```

**Rule conditions** (`when`):

| Form | Matches |
| --- | --- |
| `>N`, `>=N`, `<N`, `<=N` | Numeric comparison. |
| `between:LO,HI` | Numeric range. |
| `=text` | Exact string equality. |

**Rule classes** (`class`) must be one of: `good`, `warning`, `critical`,
`neutral`, `accent`, `muted`. Any other class or an unparseable condition is a
load error.

## Uploads

One block, `file { }`, turns a column into something uploadable, straight
from the list or the record view, no edit-mode round-trip. The **widget**
decides what happens to the bytes — `widget = "image"` decodes, resizes and
re-encodes to PNG; anything else stores them exactly as uploaded, for a PDF,
a CSV export or any other document:

```hcl
field "logo" {
  widget = "image"
  params = { max_px = 256, normalize = true }   # both optional; these are the defaults
  file {
    dir      = "products"     # directory the files live in (or an S3 key prefix)
    name_col = "sku"          # an already non-null column — see the note below
  }
}

field "invoice" {
  widget = "file"          # or omit — "file" is the default for a file { } block
  file {
    dir       = "invoices"
    name_col  = "invoice_ref"
    max_bytes = 10485760    # 10MB; default 25MB (8MB for widget = "image")
  }
}
```

`name_col` is only ever *read*, never written, in this plain form — it names
a column that must already hold a value before the first upload (`sku` here,
not a dedicated upload column). A file can also live on a *related* table —
read-only via `name_sql`, or writable across the join with `write_to` (even
back onto the field's own table, the way to get a column cartapel populates
for you with no pre-existing value needed), the same way Django's
`ImageField`/`FileField` work on a related model. All of this — the exact
upload request, the join/write-through forms, size limits, local disk vs. a
named S3-compatible `storage`, and what to mount so files survive a
redeploy — is on its own page: [Uploads & file storage](/configuration/uploads).

::: warning `widget = "file"` has no panel rendering yet
The upload/download endpoints work — script against them, or use the visual
builder's Fields tab to configure `dir`/`name_col`. But today only
`widget = "image"` has an in-panel widget (a thumbnail with click-to-upload).
A plain `file` field falls back to whatever the default text rendering does;
there's no download-link/icon widget in the panel yet.
:::

---

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
