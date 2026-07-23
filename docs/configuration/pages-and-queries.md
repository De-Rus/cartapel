# Pages, queries & custom widgets

Some flows aren't a single-table CRUD — reconciliation queues, moderation
boards, ops dashboards. steward's plugin layer lets you add **custom pages**
(full-screen modules), **named queries** (read-only SQL those modules call), and
**custom field widgets**. All three live inside the config bundle as plain files;
there is no separate build step, no npm, and no core changes.

## How assets are served

steward serves any file under the config directory at
`/static/<path-relative-to-config>`, so your JS/CSS/image assets sit right next
to the HCL that references them. Serving is path-confined (directory traversal
and out-of-tree symlinks are rejected) and extension-allowlisted:
`js`, `mjs`, `css`, `svg`, `png`, `webp`, `jpg`, `jpeg`, `gif`, `ico`. Config and
secret material (`.hcl`, `.toml`, `.env`, dotfiles) is never served.

## Custom pages

A custom page is a full-screen module in the sidebar. Each page is its own
folder holding a `screen.hcl` that sets `module`, placed inside a group folder
under `screens/` — exactly like a table:

```
admin/
  screens/
    overview/                  # a group folder (_group.hcl → "Overview")
      _group.hcl
      ops/                     # → slug "ops", group "Overview"
        screen.hcl
        ops.tsx                # the page module (co-located)
        queries.hcl            # queries this page reads
```

```hcl
# admin/screens/overview/ops/screen.hcl
label  = "Operations"
icon   = "satellite"
module = "ops.tsx"         # the co-located page module (.tsx / .ts / .js)
roles  = ["support"]       # omit → admin only
```

| Key | Description |
| --- | --- |
| `label` | Sidebar label. **Required.** |
| `icon` | lucide icon name or an emoji. |
| `module` | The JS module file, resolved **relative to the page's own folder**. Defaults to `<slug>.js`. |
| `roles` | Roles that may see the page. Omit → admin only. |

The **slug is the page folder's name** and the **group is the enclosing group
folder** — both are folder-derived, so `screen.hcl` carries neither (a stray `slug`
or `group` is rejected). A page folder placed directly under the config root is
ungrouped.

### Writing a page module

A page is a web component named `sx-page-<slug>`, rendered in the panel's own
DOM so its CSS variables cascade in:

```js
// admin/screens/overview/ops/ops.js
class OpsPage extends HTMLElement {
  connectedCallback() {
    this.render()
    this.load()
  }
  async load() {
    // this.api is injected: { get(path), post(path, body) }
    const { rows } = await this.api.get('query/ops_attention')
    // …render rows…
  }
  render() {
    this.innerHTML = `<div class="p-4">…</div>`
  }
}
customElements.define('sx-page-ops', OpsPage)
```

Conventions for a page module:

- Use light DOM (no shadow root) so the panel's CSS variables apply.
- Fetch data from named queries via `this.api.get("query/<name>")`, which
  resolves to `{ rows: [...] }`. Load datasets in parallel and degrade per-query
  — show an inline error for the one that failed, not the whole page.
- Style only with the panel's CSS variables (`--accent`, `--ink`, `--muted`,
  `--border`, `--surface`, `--surface-3`, `--sec`, …). Dark-first — never
  hard-code a light background.

## Named queries

A `queries.hcl` file declares read-only SQL that pages and widgets can call. It
can live in **any** folder under the config root — put it next to the page that
uses it. Every `queries.hcl` in the bundle merges into one flat `/query/<name>`
namespace; a name defined twice is a loud load error.

```hcl
# admin/screens/overview/ops/queries.hcl
query "ops_fleet" {
  sql = "SELECT status, count(*) AS n FROM orders GROUP BY status ORDER BY n DESC"
  roles = ["support"]       # omit → admin only
}

query "ops_revenue" {
  sql = "SELECT date_trunc('day', placed_at) AS t, coalesce(sum(total),0) AS usd FROM orders WHERE placed_at > now() - interval '14 days' GROUP BY 1 ORDER BY 1"
  roles = ["support"]
}
```

| Key | Description |
| --- | --- |
| `sql` | The read-only query. **Required.** |
| `roles` | Roles allowed to call it. Omit → admin only. |

Every named query runs in a **`READ ONLY` transaction with an 8-second statement
timeout**. A page calls one with `this.api.get("query/ops_fleet")` and gets back
`{ rows: [...] }`. Add `source = "<alias>"` to run a query against a non-primary
Postgres source.

## Template variables

A `variables.hcl` declares URL-backed parameters that queries interpolate with
`{{name}}`. Like queries, they merge globally from any folder. A value **never**
string-concatenates into SQL — it is a **bound parameter** (an `ident`-typed value,
which names a column/table, is regex-validated `^[A-Za-z0-9_]+$` and inlined).

```hcl
# admin/screens/overview/pulse/variables.hcl
variable "window" {
  label   = "Window"
  type    = "int"                 # text (default) | int | float | ident
  options = ["7", "30", "90"]     # …or `query = "SELECT DISTINCT …"` (value, [label])
  default = "30"
  roles   = ["support"]           # omit → admin only
}
```

```hcl
query "pulse_orders" {
  sql = "SELECT date_trunc('day', placed_at) AS t, count(*) AS n FROM orders WHERE placed_at > now() - {{window}} * interval '1 day' GROUP BY 1 ORDER BY 1"
}
```

A supplied value outside a variable's option set is a **hard 400**, never a silent
fallback. State lives in the URL (`?v_window=90`), so a parameterized page is
shareable by link. In a page module:

```js
const { VarBar, useQuery, Chart } = sx;
export default ({ api }) => {
  const q = useQuery(api, "pulse_orders");   // v_* params are folded in automatically
  return html`<${Page} title="Pulse"><${VarBar} api=${api} />
    <${Chart} rows=${q.rows} x="t" y="n" kind="bar" /></>`;
};
```

`VarBar` renders one selector per in-scope variable; changing it re-runs every
`useQuery`/`useSource`/`useTable` on the page.

## Embedding a configured table — `AdminTable`

A page module can render a table's **configured** list (its columns, labels,
formats and row drill-down from `screen.hcl`) without re-declaring anything —
the bridge for mixing zero-config tables with bespoke UI on one screen:

```js
const { AdminTable } = sx;
// inside a page: same columns/formatting as the standalone Orders table
html`<${AdminTable} api=${api} slug="orders" pp=${25} sort="-id" />`
```

## Custom widgets

A custom **field** widget is a web component you reference from a table config as
`widget = "custom:<name>"`. The component's source lives at
`config/widgets/<name>.js` and is served from `/static/config/widgets/<name>.js`.

```hcl
field "equity" {
  widget = "custom:sparkline"
  params = { field = "equity_curve", color = "blue" }
}
```

### Authoring one

Define a custom element named `sx-widget-<name>`. steward sets three properties
on it; re-render whenever a property is assigned:

| Property | Value |
| --- | --- |
| `row` | The full record object. |
| `params` | The field's `params` map from config. |
| `api` | `{ get(path), post(path, body) }` — bound to the panel base path, sends the session cookie and CSRF header for you. |

```js
// admin/config/widgets/sparkline.js
class Sparkline extends HTMLElement {
  set row(v) { this._row = v; this.render() }
  set params(v) { this._params = v; this.render() }
  render() {
    const series = this._row?.[this._params?.field] ?? []
    this.innerHTML = `<svg>…</svg>`   // draw the trend line
  }
}
customElements.define('sx-widget-sparkline', Sparkline)
```

A `custom:<name>` widget renders in **both** the list cell and the detail field.
An unknown custom widget falls back to the raw value — never a crash.

### Bundled widgets

steward's reference bundle ships three drop-in custom widgets under
`config/widgets/`:

- **`sparkline`** — inline SVG trend line.
  `params = { field, color, width, height }`; `field` names a column holding a
  JSON array of numbers.
- **`statuspill`** — a colored pill from a value → tone mapping.
  `params`: `field` (column to read, defaults to the cell value), `map`
  (`{ "<value>": "<tone>" | { label, tone } }` with tone ∈
  `green|red|blue|gray|orange|violet|yellow`), `fallback` (tone when no key
  matches, default `gray`), `labels` (optional value → label overrides). Booleans
  and numbers match by their string form (`"true"`, `"3"`).
- **`minibar`** — a tiny horizontal magnitude bar + number.
  `params`: `field`, `max` (full scale, default 100), `width` (px), `color`,
  `suffix`, plus `warn_at` / `warn_color` to recolor once `value ≥ warn_at`.

All three use the panel's CSS variables so they track the active theme
automatically.

```hcl
field "has_subscription" {
  label  = "Subscribed"
  widget = "custom:statuspill"
  sql    = "EXISTS (SELECT 1 FROM subscriptions s WHERE s.customer_id = t.id AND s.status = 'active')"
  params = {
    field = "has_subscription"
    map = {
      "true"  = { label = "active", tone = "green" }
      "false" = { label = "none",   tone = "gray"  }
    }
  }
}
```
