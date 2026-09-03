---
description: "remote { } fields: a read-only per-row value fetched live from an http source, plus the table widget for rendering an array response."
---

# Remote fields

A `remote { }` block turns a field into a **read-only, per-row value fetched
live from an `http` source**, `{column}`-templated from the current row —
nothing is stored, nothing is selected in the row query, every read hits the
source when the value is shown:

```hcl
source "carrier_api" {
  type      = "http"
  url       = "https://api.carrier.example.com"
  token_env = "CARRIER_TOKEN"
}

field "shipping_status" {
  label  = "Shipping status"
  widget = "badge"                          # any widget — not just plain text
  remote {
    source = "carrier_api"                  # an already-declared http source
    path   = "/track/{tracking_number}"     # {column} from the current row
    at     = "data.results[0].status"       # a small path DSL, not jq — see below
  }
}
```

| Key | Description |
| --- | --- |
| `source` | Name of a declared `source "…" { type = "http" }` — same role gate, size cap and `env:`/`${}` token resolution as reading that source any other way. |
| `path` | Appended to the source's `url`. `{column}` placeholders are filled from the row; a masked column is refused, not silently redacted. |
| `at` | A path into the JSON response: dotted keys plus `[N]` array indices (`"data.results[0].status"`). Omit to use the whole response body. |
| `lazy` | Wait for a click in a list instead of fetching every visible row on its own. Default `false` — see below. |

`at` is deliberately **not jq** — no filters, pipes or functions, just keys
and indices. It answers "which value", not "compute something from the
document"; if you need real transformation, do it on the source side.

`widget` picks how the fetched value renders — `badge`, `money`, `date`,
anything a normal field can use — the `remote { }` block only marks that the
value has to be fetched first, it isn't a rendering choice of its own. No
`widget` set → plain text, same default as any other field.

## Lists: `lazy`

Every remote field fetches on its own by default, in the **detail view**
(one row) and in a **list** alike — a list with 50 rows on screen fires 50
requests. Set `lazy = true` on a field backed by a slow or expensive
endpoint to opt out of that in lists: it then shows a "Load" affordance and
waits for a click instead (the detail view still fetches on mount either
way, since that's a single row):

```hcl
field "shipping_status" {
  widget = "badge"
  remote {
    source = "carrier_api"
    path   = "/track/{tracking_number}"
    at     = "data.results[0].status"
    lazy   = true
  }
}
```

There's no write path: a remote field is always `readonly`, the same as a
computed (`sql`) column.

## Arrays: the `table` widget

If `at` resolves to an **array** — say `at = "data.results"` with no index —
pair it with `widget = "table"` to render it as a small inline table instead
of a single value:

```hcl
field "recent_shipments" {
  widget = "table"
  params = {
    columns = [
      "carrier",                                                        # bare name → header = the name
      { field = "status", label = "Status", labels = { es = "Estado" } },
      { field = "eta_days", label = "ETA (days)" },
    ]
  }
  remote {
    source = "carrier_api"
    path   = "/history/{customer_id}"
    at     = "data.shipments"
  }
}
```

`params.columns` picks which keys become columns, in order; omit it and the
first row's own keys are used. Each entry is either a bare field name (the
header is the name itself) or `{ field, label, labels }` — the same
`label`/`labels` shape a `field { }` block uses, resolved against the
viewer's locale client-side. `table` isn't remote-specific — it renders any
array-of-objects value, including a plain `json`/`jsonb` column.

::: warning `remote { }` is hand-authored HCL only
The visual builder's Fields tab doesn't have a `remote { }` editor yet — add
it (and the `table` widget's `params.columns`) directly in `screen.hcl`. The
field works exactly the same once written; there's just no click-through UI
for it today.
:::
