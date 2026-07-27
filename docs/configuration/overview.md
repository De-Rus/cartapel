---
description: "The config bundle: layout, globals, sources, environment interpolation, validation and hot reload."
---

# Configuration overview

cartapel is configured by a directory of [HCL](https://github.com/hashicorp/hcl)
files. The directory is a self-contained bundle — config, roles, dashboards,
and any custom widget/page code all live inside it — so the whole panel is one
portable, versionable folder you point `--config` at.

There is an in-app visual builder that edits this same config, but it writes the
identical HCL. The files are the source of truth.

## Layout: `config/` + `screens/`

The layout of the config directory *is* the layout of the sidebar. Globals live
in the reserved `config/` folder; everything you navigate to — tables and pages —
lives under `screens/`, one folder per navigation group:

```
admin/
├── config/                     # reserved — globals + shared assets, never a group
│   ├── cartapel.hcl            #   brand, theme, the `main` source, defaults
│   ├── auth.hcl               #   roles & permissions
│   ├── dashboard.hcl          #   dashboard widgets
│   └── widgets/               #   shared custom-widget JS (served at /static)
│       └── sparkline.js
└── screens/                    # every table and page lives here
    ├── customers/              # a sidebar group (it has a _group.hcl)
    │   ├── _group.hcl         #   its label, icon, order, table order
    │   ├── customers/         #   one folder per table — the folder name is the table
    │   │   └── screen.hcl     #     list/fields/actions (empty = introspected defaults)
    │   └── subscriptions/
    │       └── screen.hcl
    └── overview/
        ├── _group.hcl
        └── summary/            # a scripted page instead of a table
            ├── screen.hcl     #   module = "summary.tsx"
            ├── summary.tsx     #   the page module (co-located)
            └── queries.hcl     #   named read-only queries the page calls
```

Config files are discovered recursively; load order is deterministic (files
sorted by path). The rules the diagram doesn't show:

- A **table** is a folder holding a `screen.hcl`; the **folder name is the table
  name**. An empty `screen.hcl` renders the table from introspected defaults.
- A **`_group.hcl`** makes its folder a sidebar group and sets its label, icon
  and order. Tables in a folder without one land in a trailing "Ungrouped"
  group. See [Groups & navigation](/configuration/groups-and-nav).
- A **page** is the same shape — a folder whose `screen.hcl` sets
  `module = "<name>.tsx"` (scripted) or holds `panel { }` blocks (declarative),
  never both. `page.hcl` is an accepted synonym for such a file. See
  [Pages & queries](/configuration/pages-and-queries).
- A **`queries.hcl`** in any folder contributes named read-only queries;
  **`variables.hcl`** and **`sources.hcl`** work the same way for template
  variables and extra data sources. Names must be unique across the bundle.
- The file set under `screens/` is closed — `screen.hcl`, `page.hcl`,
  `_group.hcl`, `queries.hcl`, `variables.hcl`, `sources.hcl`. Any other
  `.hcl` name there is a load error.

## The reserved `config/` folder

`config/` is special: it is never a sidebar group and is never scanned for
tables. It holds exactly three global files plus a `widgets/` asset folder:

| File | Contents |
| --- | --- |
| `config/cartapel.hcl` | Brand, logo, locale, `per_page`, the secret key, `theme { }`, and the `source "…" { }` blocks. |
| `config/auth.hcl` | `role "…" { }` blocks — the permission model. See [Roles & permissions](/roles-and-permissions). |
| `config/dashboard.hcl` | The home dashboard's `panel { }` blocks. See [Dashboard](/configuration/dashboard). |
| `config/widgets/*.js` | Shared custom-widget web components, served at `/static/config/widgets/`. See [Pages & queries](/configuration/pages-and-queries). |

Putting anything else in `config/` is a loud load error. Folders whose name
starts with an underscore are never treated as sidebar groups.

## `config/cartapel.hcl` — globals

```hcl
brand      = "Acme Admin"
brand_logo = "https://acme.example/logo.png"
per_page   = 100
locale     = "en"

# The signing secret. Prefer env interpolation over a literal.
secret_key = "env:CARTAPEL_SECRET_KEY"

theme {
  preset = "cartapel"          # "cartapel" (default) | "django"
  accent = "hsl(33 100% 50%)"
  mode   = "auto"             # "light" | "dark" | "auto"
}

# The database cartapel reads. Exactly one postgres source must be `primary`.
source "main" {
  type    = "postgres"
  url     = "env:CARTAPEL_DB"   # or a literal postgres:// url
  schemas = ["public"]
  primary = true
}
```

Top-level `[cartapel]` keys:

| Key | Type | Description |
| --- | --- | --- |
| `brand` | string | Panel name, shown in the header. Defaults to `cartapel`. |
| `brand_logo` | string | Logo URL, data URL, or a bundle asset filename served under `/static/`. |
| `locale` | string | The instance language — picks the UI dictionary, date/number formatting and per-locale `labels` overrides. See [Localization](/localization). |
| `strings` | map | Override individual UI strings (`{ "key" = "value" }`). |
| `per_page` | number | Default list page size — `100` when unset. A table's `list.per_page` overrides it. |
| `group_nav` | string | Default sidebar mode for groups: `expanded` (default — every table is its own entry) or `page` (one entry per group; sibling tables become tabs). A group's own `nav` in `_group.hcl` overrides it. |
| `secret_key` | string | Session-signing root. Supports `env:`/`${}`. Overridden by `CARTAPEL_SECRET_KEY`. **Required** somewhere. |
| `theme { }` | block | Theme preset, accent, per-mode CSS token overrides, logos — see [Theming](/theming). |
| `source "…" { }` | block | A named data source. The `primary` postgres one is the database cartapel introspects. |
| `disable_sql_preview` | bool | Hardening: disable the dashboard builder's ad-hoc SQL preview (admin-supplied `SELECT`s). Blocks arbitrary read-SQL even for admins. Default `false`. |
| `disable_webhooks` | bool | Hardening: disable outbound webhook actions (an SSRF surface). Default `false`. |

### `theme { }`

| Key | Description |
| --- | --- |
| `preset` | Named base theme: `cartapel` (default) or `django`. |
| `accent` / `accent_btn` | Shorthand accent overrides (win over the preset). |
| `light` / `dark` | Per-mode maps of CSS token → value. Keys are cartapel token names without the `--` prefix (`page`, `surface`, `ink`, `accent`, `good`, `critical`, …). |
| `mode` | Force `light`, `dark`, or `auto` (default). |
| `logo_light` / `logo_dark` | Per-mode brand logo, overriding `brand_logo` for that mode. |

### `source "…" { }`

Databases are declared as named sources. The `primary` one is what cartapel
introspects and serves by default — and when no source is declared at all, the
`--db` / `CARTAPEL_DB` URL becomes the primary implicitly, its engine picked
from the scheme (`postgres://…` or `mysql://…`). That is why the one-command
run needs nothing but the URL. Additional sources (more Postgres databases, or MySQL/MariaDB ones)
plug extra tables into the same panel: point a table at one with
`from { source = "…" }`, and lists, detail pages, editing, filters, search,
import/export and audit all work the same way.

| Key | Description |
| --- | --- |
| `type` | `"postgres"`, `"mysql"` (also accepts `"mariadb"`), or `"http"` for a read-only JSON source a custom page can call. |
| `url` | Connection URL (`postgres://…`, `mysql://…`) or endpoint (http). Supports `env:NAME` / `${NAME}`. |
| `schemas` | List of schemas to introspect (postgres). Defaults to `["public"]`. A MySQL source is scoped to the database in its URL. |
| `primary` | Marks the source cartapel introspects and serves by default. With a single database source it is implied; declare it explicitly when you define several. |
| `token_env` / `header` | For `http` sources: attach a secret from this env var under `header` (default `x-admin-token`). The secret never reaches the browser. |
| `roles` | Restrict a source to these roles (non-admins need an explicit match). |

`--db postgres://…` / `CARTAPEL_DB` overrides the `primary` source's URL, so the
same bundle can run against dev, staging or prod by swapping one env var.

::: info MySQL & MariaDB
MySQL 8.0+ and MariaDB 10.6+ are supported everywhere a database goes: as the
primary (`CARTAPEL_DB=mysql://…` just works), as extra table sources, and for
named queries and query-backed variables.
The differences that matter are handled for you — `tinyint(1)` renders as a
boolean, `enum` values become text, MariaDB's `json`-as-`longtext` is detected,
and unsigned ids are read losslessly. Two honest limits: array columns don't
exist on MySQL, and **upsert imports are refused on tables with a row filter**
(MySQL's upsert can't be scoped by a WHERE, and widening a user's write surface
silently is worse than saying no). Create the cartapel user with
`mysql_native_password` — `ed25519` auth is not supported.
:::

## Environment interpolation

`secret_key` and every `source`'s `url` accept `env:NAME` or `${NAME}`,
replaced at load time with the environment variable `NAME`. (An `http` source's
`token_env` names an env var directly, no prefix.) Use it to keep secrets out
of committed config:

```hcl
source "main" {
  type    = "postgres"
  url     = "env:CARTAPEL_DB"
  primary = true
}

secret_key = "${CARTAPEL_SECRET_KEY}"
```

## Validation & hot-reload

Config is validated as it loads, and again on every in-app edit:

- **Unknown keys are rejected.** Every block uses strict parsing, so a typo like
  `filterz = [...]` is a load error, not a silent no-op.
- **Duplicate labeled blocks are rejected** — two `field "x"` blocks, or two
  configs for the same table, fail loudly rather than silently merging.
- **`format` and `color` are validated** against their allowed vocabularies
  (see [Fields & widgets](/configuration/fields-and-widgets)).
- **Named queries must be unique** across the whole bundle.

Config edits **hot-reload** with no restart — both through the in-app builder
and by editing the files on disk (cartapel watches the config directory,
debounced). A bad edit can never replace the running config: builder writes are
trial-parsed first with a failed reload restoring the previous state, and a
broken on-disk edit keeps the last good config and logs the error.

::: tip Round-tripping through the visual builder drops comments
The builder regenerates canonical HCL from the parsed model. If you keep
comments or bespoke formatting in a file, edit it as raw HCL (in your repo or the
raw editor), not through the visual form.
:::

## Next

- **[Tables](/configuration/tables)** — every block in a `screen.hcl`.
- **[Groups & navigation](/configuration/groups-and-nav)** — `_group.hcl` in detail.
