---
description: "Sidebar groups from folders: labels, icons, ordering, nav modes and moving tables between groups."
---

# Groups & navigation

The sidebar is built from your folder layout. Each folder under `screens/` is a
navigation group, and the table (and page) folders inside it are that group's
entries.

## `_group.hcl`

A folder becomes a labeled sidebar group by carrying a `_group.hcl`. The folder
name is the group's stable key (its slug); the file supplies presentation and
ordering.

```hcl
# screens/customers/_group.hcl
label       = "Customers"
icon        = "users"
order       = 1
table_order = ["customers", "subscriptions"]
```

| Key | Type | Description |
| --- | --- | --- |
| `label` | string | The group's display name. **Required.** |
| `icon` | string | A [lucide](https://lucide.dev) icon name (`trending-up`, `bot`, `package`, …). |
| `order` | number | Sort key among groups (lower first). Defaults to `0`. |
| `table_order` | list | Explicit ordering of the tables within the group. Unlisted tables follow. |
| `section` | string | A heading ABOVE this group, shared with every group naming the same one. Groups of tables and groups of pages sit under it together. Unsectioned groups keep their place at the top; sections follow, in the order their first group appears. |
| `nav` | string | Sidebar mode for this group: `expanded` (every table listed) or `page` (one entry that opens the group's primary table with its siblings as tabs). Falls back to the global `group_nav`, then `expanded`. |
| `labels` | map | Per-locale label overrides (`labels = { es = "Clientes" }`); the instance `locale` picks one. |

## Sections — a second level

Once a console has more than a handful of groups, the sidebar wants one more
level. `section` gives it: every group naming the same section is drawn under
that heading, and a section holds groups of tables and groups of pages
together.

```hcl
# screens/ops-feeds/_group.hcl        # screens/ops-data/_group.hcl
label   = "Feeds"                     label   = "Data"
section = "Operations"                section = "Operations"
```

That togetherness is the point. Pages are panels and have no row actions, so
anything with a button — a webhook action, a bulk edit — has to be a table
screen. Without sections a console had to choose between putting such a screen
where it belongs and keeping its button; now the table group simply names the
section its dashboards live in.

Groups without a `section` keep their place at the top of the sidebar.
Sections follow in the order their first group appears, so adding one moves
only the groups that name it.

## Ordering

- **Groups** sort by `order`, then alphabetically by `label` to break ties.
- **Tables within a group** follow `table_order` when present; any table not
  listed there is appended after the ordered ones.

## Grouping rules

- A folder may hold only a `_group.hcl` — an empty, table-less group is valid
  config. It appears in the sidebar once it has members.
- A folder without a `_group.hcl` is not a sidebar group — its tables fall
  into the trailing "Ungrouped" section. Add a `_group.hcl` to name the group.
- The same group slug in two folders is a **load error** — a group lives in
  exactly one folder.
- The top-level `config/` folder is reserved for globals and is never a group.
  The in-app groups editor also refuses the framework names `page`, `queries`,
  `groups`, `dashboard`, `discover`, `versions` and `screens` as group slugs —
  don't use them for folders either.
- Folders whose name begins with an underscore are never sidebar groups. A
  `_group.hcl` in such a folder is ignored with a warning.

## Moving a table between groups

A table's identity and its URL are its **folder name** (the table name), never
its group. Moving a table's folder from one group to another changes which
sidebar group it appears in but does not change its identity or any deep links
to its records.

::: warning Renaming a group changes page URLs
Pages are identified as `<group-slug>/<page-slug>` (both folder-derived).
Renaming a group folder therefore changes the ids of any pages inside it and
breaks existing deep links to those pages. Table record links are unaffected.
:::

## The in-app groups editor

The visual builder can create groups, rename them, reorder groups and tables,
and move tables between groups — all of which just rewrite `_group.hcl` files
and relocate configs on disk, respecting the documented layout: new and moved
group folders stay under `screens/`, a table folder moves **whole** — its
`screen.hcl` together with any co-located module and query files — and a move
that would collide with an existing folder is refused. When the config bundle is mounted read-only,
these edits are disabled (see [Deployment](/deployment#writable-config-volume)).
