---
description: "Custom pages with the sx SDK, named read-only queries, template variables and declarative panel pages."
---

# Pages, queries & custom widgets

The mental model in one line: **a page is a folder with a `screen.hcl`**, and
that file's contents pick one of three flavors — a **table** (no `module`, no
`panel`: the folder name is a database table and cartapel renders full CRUD), a
**scripted module** (`module = "…"`: a full-screen Preact page you write with
the `sx` SDK), or **declarative panels** (`panel { }` blocks: a query-driven
grid with zero JS). Tables are covered in [Tables & lists](/configuration/tables);
this page covers the other two flavors plus the plumbing they share — **named
queries** (read-only SQL), **template variables**, and **custom field widgets**.
Everything lives inside the config bundle as plain files; there is no separate
build step, no npm, and no core changes.

```
admin/
  screens/
    overview/                  # a group folder (_group.hcl → "Overview")
      _group.hcl
      orders/                  # flavor 1: a table (screen.hcl configures CRUD)
        screen.hcl
      ops/                     # flavor 2: a scripted module
        screen.hcl             #   module = "ops.tsx"
        ops.tsx                #   the page module (co-located)
        queries.hcl            #   queries this page reads
      fleet/                   # flavor 3: declarative panels
        screen.hcl             #   panel { } blocks, no JS
```

A page's **slug is its folder name** and its **group is the enclosing group
folder** — both folder-derived, so `screen.hcl` carries neither (a stray `slug`
or `group` is rejected). A page folder placed directly under the config root is
ungrouped. A screen that sets both `module` and `panel { }` is a load error —
scripted or declarative, never both.

The page is served at **`{base}/p/<group>/<slug>`** — the example above is
`/admin/p/overview/ops`. An ungrouped page is at `{base}/p/<slug>`. The sidebar
links there for you; you only need this when writing a link by hand.

::: tip Which flavour?
**Start declarative.** A grid of `panel { }` blocks needs no JavaScript, keeps
the SQL server-side, and gets money/percent formatting, in-cell bars, deep links
and comparison sparklines for free. Reach for a `module` when you need layout or
interaction that panels cannot express.
:::

## Scripted pages

A scripted page is a full-screen module in the sidebar:

```hcl
# admin/screens/overview/ops/screen.hcl
label  = "Operations"
icon   = "satellite"
module = "ops.tsx"         # the co-located page module (.tsx / .ts / .js)
roles  = ["support"]       # omit → visible to everyone signed in
```

| Key | Description |
| --- | --- |
| `label` | Sidebar label. **Required.** |
| `icon` | lucide icon name or an emoji. |
| `module` | The JS module file, resolved **relative to the page's own folder**. Defaults to `<slug>.js`. |
| `roles` | Roles that may see the page. Omit → visible to every signed-in user; list roles to restrict it. |

### Editor autocompletion — `sx.d.ts`

Before writing a module, grab the SDK's type declarations. Every instance
serves them at **`{base}/sx.d.ts`** (e.g. `https://your-host/admin/sx.d.ts`) —
download the file next to your modules and reference it for full
autocompletion while authoring:

```bash
curl -o admin/screens/sx.d.ts https://your-host/admin/sx.d.ts
```

```ts
/// <reference path="../sx.d.ts" />
```

### Writing a page module

A `.tsx`/`.ts` module is transpiled **in the browser** — no build step, no
imports; every `sx` export is already in scope. `export default` your component
(or call `sx.definePage('<slug>', C)`):

```tsx
// admin/screens/overview/ops/ops.tsx
export default ({ api }) => {
  const fleet = useQuery(api, 'ops_fleet')
  return html`<${Page} title="Operations" loading=${fleet.loading} error=${fleet.error}>
    <${Chart} rows=${fleet.rows} x="status" y="n" kind="bar" />
  </>`
}
```

A plain `.js` module is the raw escape hatch: it is loaded as-is and must
define the `sx-page-<slug>` custom element itself (with `this.api` injected).
If a module loads but registers nothing, the page shows a failure card with
the module path and the actual error.

Conventions for a page module:

- Use light DOM (no shadow root) so the panel's CSS variables apply.
- Fetch data from named queries via `useQuery(api, "<name>")` — each hook
  returns `{ rows, data, loading, refreshing, error, refetch }`. Load datasets
  in parallel (`useQueries(api, ["a", "b"])` adds `$loading`/`$error`/`$refetch`
  across all of them) and degrade per-query — show an inline error for the one
  that failed, not the whole page.
- Style only with the panel's CSS variables (`--accent`, `--ink`, `--muted`,
  `--border`, `--surface`, `--surface-3`, `--sec`, …). Dark-first — never
  hard-code a light background.

## Declarative pages

A page doesn't need a module at all: give its `screen.hcl` `panel { }` blocks —
the same panel schema as the [dashboard](/configuration/dashboard), plus an
optional `columns` grid count — and cartapel renders it as a query-driven grid,
no JS:

```hcl
# admin/screens/overview/fleet/screen.hcl
label   = "Fleet"
icon    = "bot"
columns = 3

panel {
  type  = "stat"
  label = "Running bots"
  sql   = "SELECT count(*) AS v FROM bots WHERE status = 'running'"
}

panel {
  type  = "chart"
  label = "Signals per day"
  chart = "bar"
  sql   = "SELECT date_trunc('day', ts) AS t, count(*) AS v FROM bot_signals GROUP BY 1 ORDER BY 1"
}
```

Panel-level `roles` filter individual panels; the page-level `roles` gates the
whole page. Template variables work in panel SQL exactly as they do on the
dashboard.

## How assets are served

cartapel serves any file under the config directory at
`/static/<path-relative-to-config>`, so your JS/CSS/image assets sit right next
to the HCL that references them. Serving is path-confined (directory traversal
and out-of-tree symlinks are rejected) and extension-allowlisted:
`js`, `mjs`, `ts`, `tsx`, `css`, `svg`, `png`, `webp`, `jpg`, `jpeg`, `gif`,
`ico`. Config and secret material (`.hcl`, `.toml`, `.env`, `.ini`, dotfiles)
is never served.

## Named queries

A `queries.hcl` file declares read-only SQL that pages and widgets can call. It
can live in **any** folder under the config root — put it next to the page that
uses it. Every `queries.hcl` in the bundle merges into one flat `/query/<name>`
namespace; a name defined twice is a loud load error.

```hcl
# admin/screens/overview/ops/queries.hcl
query "ops_fleet" {
  sql   = "SELECT status, count(*) AS n FROM orders GROUP BY status ORDER BY n DESC"
  roles = ["support"]       # omit → admin only
}

query "ops_revenue" {
  sql   = "SELECT date_trunc('day', placed_at) AS t, coalesce(sum(total),0) AS usd FROM orders WHERE placed_at > now() - interval '14 days' GROUP BY 1 ORDER BY 1"
  roles = ["support"]
}
```

| Key | Description |
| --- | --- |
| `sql` | The read-only query. **Required.** |
| `roles` | Roles allowed to call it. Omit → admin only. |
| `source` | Run against a non-primary Postgres `source` alias. |

Every named query runs in a **`READ ONLY` transaction with an 8-second
statement timeout** and a 1 000-row cap. A page calls one with
`useQuery(api, "ops_fleet")` (or `this.api.get("query/ops_fleet")` from a raw
custom element) and gets back `{ rows: [...] }`.

## Template variables

A `variables.hcl` declares URL-backed parameters that queries interpolate with
`{{name}}`. Like queries, they merge globally from any folder. A value **never**
string-concatenates into SQL — it is a **bound parameter** (an `ident`-typed
value, which names a column/table, is regex-validated `^[A-Za-z0-9_]+$` and
inlined).

```hcl
# admin/screens/overview/pulse/variables.hcl
variable "window" {
  label   = "Window"
  type    = "int"                 # text (default) | int | float | ident
  options = ["7", "30", "90"]
  default = "30"
  roles   = ["support"]           # omit → in scope for everyone
}
```

```hcl
query "pulse_orders" {
  sql = "SELECT date_trunc('day', placed_at) AS t, count(*) AS n FROM orders WHERE placed_at > now() - {{window}} * interval '1 day' GROUP BY 1 ORDER BY 1"
}
```

The rules, all enforced at load time:

- Set **exactly one** of `options` (a static list) or `query` (read-only SQL:
  first column = value, optional second column = label; `source` picks a
  non-primary database for it).
- `default` must be one of the `options`. When a request supplies no value, the
  default applies, then the first option.
- `kind` is `single` (the default and, today, the only supported value —
  `multi` is a load error).
- `type = "window"` is sugar for the common time-window selector: an `int`
  variable with `7`/`30`/`90` options, default `30`, label "Window" — each part
  overridable by declaring it yourself.

At request time, a supplied value outside a static `options` list — or, for an
`ident` variable, outside its query's value set — is a **hard 400**, never a
silent fallback. State lives in the URL (`?v_window=90`), so a parameterized
page is shareable by link. In a page module:

```tsx
// admin/screens/overview/pulse/pulse.tsx
export default ({ api }) => {
  const q = useQuery(api, 'pulse_orders')   // v_* params are folded in automatically
  return html`<${Page} title="Pulse">
    <${VarBar} api=${api} />
    <${Chart} rows=${q.rows} x="t" y="n" kind="bar" />
  </>`
}
```

`VarBar` renders one selector per in-scope variable; changing it re-runs every
`useQuery`/`useSource`/`useTable` on the page.

## Embedding a configured table — `AdminTable`

A page module can render a table's **configured** list (its columns, labels,
formats and row drill-down from `screen.hcl`) without re-declaring anything —
the bridge for mixing zero-config tables with bespoke UI on one screen:

```js
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

### Bundled widgets

The demo bundle ships three drop-in widgets under `config/widgets/` — copy the
files into your own bundle and reference them as `custom:<name>`:

- **`statuspill`** — a colored pill from a value → tone mapping.
  `params`: `field` (column to read, defaults to the cell value), `map`
  (`{ "<value>": "<tone>" | { label, tone } }` with tone ∈
  `green|red|blue|gray|orange|violet|yellow`), `fallback` (tone when no key
  matches, default `gray`), `labels` (optional value → label overrides).
  Booleans and numbers match by their string form (`"true"`, `"3"`).
- **`minibar`** — a tiny horizontal magnitude bar + number.
  `params`: `field`, `max` (full scale, default 100), `width` (px), `color`,
  `suffix`, plus `warn_at` / `warn_color` to recolor once `value ≥ warn_at`.
- **`sparkline`** — inline SVG trend line. `params = { field, color, width,
  height }`; `field` names a column holding a JSON array of numbers.

All three read the panel's CSS variables, so they track the active theme.

### Authoring one

Define a custom element named `sx-widget-<name>`. cartapel sets three properties
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
