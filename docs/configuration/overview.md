# Configuration overview

steward is configured by a directory of [HCL](https://github.com/hashicorp/hcl)
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
│   ├── steward.hcl            #   brand, theme, the `main` source, defaults
│   ├── auth.hcl               #   roles & permissions
│   ├── dashboard.hcl          #   dashboard widgets
│   └── widgets/               #   shared custom-widget JS (served at /static)
│       └── sparkline.js
└── screens/                    # every table and page lives here
    ├── customers/              # a folder under screens/ IS a sidebar group
    │   ├── _group.hcl         #   its label, icon, order, table order
    │   ├── customers/         #   one folder per table — the folder name is the table
    │   │   └── screen.hcl     #     list/fields/actions (empty = introspected defaults)
    │   └── subscriptions/
    │       └── screen.hcl
    └── overview/
        └── summary/            # a scripted page instead of a table
            ├── screen.hcl     #   module = "summary.tsx"
            ├── summary.tsx     #   the page module (co-located)
            └── queries.hcl     #   named read-only queries the page calls
```

The folder a table lives in (under `screens/`) is its sidebar group — the single
source of truth for grouping. Config files are discovered recursively; load order
is deterministic (files sorted by path).

- A **table** is a folder holding a `screen.hcl`; the **folder name is the table
  name**. An empty `screen.hcl` renders the table from introspected defaults.
- A folder's **`_group.hcl`** names and orders that sidebar group.
- A **scripted page** is the same shape — a folder whose `screen.hcl` sets
  `module = "<name>.tsx"` next to the module. See [Pages & queries](/configuration/pages-and-queries).
- A **`queries.hcl`** in any folder contributes named read-only queries.

## The reserved `config/` folder

`config/` is special: it is never a sidebar group and is never scanned for
tables. It holds exactly three global files plus a `widgets/` asset folder:

| File | Contents |
| --- | --- |
| `config/steward.hcl` | Brand, logo, locale, `per_page`, the secret key, `theme { }`, and the `source "…" { }` blocks. |
| `config/auth.hcl` | `role "…" { }` blocks — the permission model. See [Roles & permissions](/roles-and-permissions). |
| `config/dashboard.hcl` | The home dashboard's `panel { }` blocks. See [Dashboard](/configuration/dashboard). |
| `config/widgets/*.js` | Shared custom-widget web components, served at `/static/config/widgets/`. See [Pages & queries](/configuration/pages-and-queries). |

Putting anything else in `config/` is a loud load error. Folders whose name
starts with an underscore are never treated as sidebar groups.

## `config/steward.hcl` — globals

```hcl
brand      = "Acme Admin"
brand_logo = "https://acme.example/logo.png"
per_page   = 100
locale     = "en"

# The signing secret. Prefer env interpolation over a literal.
secret_key = "env:STEWARD_SECRET_KEY"

theme {
  preset = "steward"          # "steward" (default) | "django"
  accent = "hsl(33 100% 50%)"
  mode   = "auto"             # "light" | "dark" | "auto"
}

# The database steward reads. Exactly one postgres source must be `primary`.
source "main" {
  type    = "postgres"
  url     = "env:STEWARD_DB"   # or a literal postgres:// url
  schemas = ["public"]
  primary = true
}
```

Top-level `[steward]` keys:

| Key | Type | Description |
| --- | --- | --- |
| `brand` | string | Panel name, shown in the header. Defaults to `steward`. |
| `brand_logo` | string | Logo URL, data URL, or a bundle asset filename served under `/static/`. |
| `locale` | string | UI locale hint. |
| `strings` | map | Override individual UI strings (`{ "key" = "value" }`). |
| `per_page` | number | Default list page size (a table's `list.per_page` overrides it). |
| `secret_key` | string | Session-signing root. Supports `env:`/`${}`. Overridden by `STEWARD_SECRET_KEY`. **Required** somewhere. |
| `theme { }` | block | Theme preset, accent, per-mode CSS token overrides, logos. |
| `source "…" { }` | block | A named data source. The `primary` postgres one is the database steward introspects. |

### `theme { }`

| Key | Description |
| --- | --- |
| `preset` | Named base theme: `steward` (default) or `django`. |
| `accent` / `accent_btn` | Shorthand accent overrides (win over the preset). |
| `light` / `dark` | Per-mode maps of CSS token → value. Keys are steward token names without the `--` prefix (`page`, `surface`, `ink`, `accent`, `good`, `critical`, …). |
| `mode` | Force `light`, `dark`, or `auto` (default). |
| `logo_light` / `logo_dark` | Per-mode brand logo, overriding `brand_logo` for that mode. |

### `source "…" { }`

The database is declared as a named source. Define at least one `postgres`
source and mark it `primary` — that is what steward introspects and serves.

| Key | Description |
| --- | --- |
| `type` | `"postgres"` for the database, or `"http"` for a read-only JSON source a custom page can call. |
| `url` | Connection URL (postgres) or endpoint (http). Supports `env:NAME` / `${NAME}`. |
| `schemas` | List of schemas to introspect (postgres). Defaults to `["public"]`. |
| `primary` | Marks the one postgres source steward introspects. Exactly one is required. |
| `token_env` / `header` | For `http` sources: attach a secret from this env var under `header` (default `x-admin-token`). The secret never reaches the browser. |
| `roles` | Restrict a source to these roles (non-admins need an explicit match). |

`--db postgres://…` / `STEWARD_DB` overrides the `primary` source's URL, so the
same bundle can run against dev, staging or prod by swapping one env var.

## Environment interpolation

Any config value of the form `env:NAME` or `${NAME}` is replaced at load time
with the environment variable `NAME`. Use it to keep secrets out of committed
config:

```hcl
source "main" {
  type    = "postgres"
  url     = "env:STEWARD_DB"
  primary = true
}

secret_key = "${STEWARD_SECRET_KEY}"
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

When you edit config through the in-app builder, steward **hot-swaps** the live
config with no restart. A bad edit can never replace the running config: writes
are trial-parsed first, and a failed reload restores the previous state.

::: tip Round-tripping through the visual builder drops comments
The builder regenerates canonical HCL from the parsed model. If you keep
comments or bespoke formatting in a file, edit it as raw HCL (in your repo or the
raw editor), not through the visual form.
:::

## Next

- **[Tables](/configuration/tables)** — every block in a `screen.hcl`.
- **[Groups & navigation](/configuration/groups-and-nav)** — `_group.hcl` in detail.
