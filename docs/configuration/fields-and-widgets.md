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
| `widget` | string | The renderer — a built-in name or `custom:<name>`. See [Widgets](/configuration/widgets). |
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
