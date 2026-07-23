# Detail views

Opening a record shows a **record view**, not a form: a hero header (title,
badge, key stats, actions), the fields laid out read-first in titled sections,
and a meta sidebar. Hit **Edit** to turn the fields into inputs; changes batch
into one save (`⌘S`). Inline child tables are declared separately in
`relations { }`.

The `detail { }` block is entirely optional — it only refines this view.

## Zero-config

With **no `detail` block at all**, steward already produces a good record view:

- the hero shows the title, the first `badge` field, and a copyable id;
- fields group by their `field { group = … }` tags (or into one "Details" card);
- identifiers, foreign keys and timestamps (`id`, `*_id`, `*_at`) are detected
  and pulled into the meta sidebar automatically;
- everything is read-first with an Edit toggle.

You reach for `detail { }` only to name sections, add hero stats, or change how
the record opens.

## `detail { }`

```hcl
detail {
  mode    = "page"        # "page" | "drawer" | "modal"
  columns = 1             # section grid column count
  tabs    = true          # render sections as tabs
  stats   = ["mrr", "plan", "country"]

  section {
    title       = "Identity"
    fields      = ["name", "email", "country"]
    span        = 2         # span both columns
    collapsible = true
  }

  section {
    title  = "Account"
    fields = ["plan", "mrr", "active"]
  }
}
```

| Key | Type | Description |
| --- | --- | --- |
| `mode` | enum | How the record opens: `page` (default), `drawer` (side panel), or `modal`. |
| `columns` | number | How many columns the section cards flow into (`1` stacks them full-width). |
| `tabs` | bool | Render each `section` as a tab instead of stacking them. |
| `stats` | list | Fields shown as at-a-glance chips in the hero. See [Hero stats](#hero-stats). |
| `sidebar { }` | block | Override the auto-detected meta rail. Usually unnecessary. |
| `section { }` | block (repeatable) | A titled group of fields. **Order is preserved.** |

### Hero stats

`stats` lists the fields to surface as chips across the top of the record — the
numbers you'd otherwise hunt for in the body. Each renders with its own widget,
so a `number` shows a big figure and a `custom:minibar` rating shows its bar.

```hcl
detail {
  stats = ["mrr", "plan", "active", "country"]
}
```

A stat can repeat a field that also lives in a section — the chip is a shortcut,
not a move.

### Sections

A `section` groups related fields under a heading. Sections render in the order
written; any field not placed in a section falls into a trailing "Other" group.

```hcl
detail {
  section {
    title  = "Identity"
    fields = ["id", "name", "email", "country"]
  }
  section {
    title  = "Plan"
    fields = ["plan", "mrr"]
  }
  section {
    title  = "Status"
    fields = ["active", "created_at"]
  }
}
```

Per-section options:

| Key | Description |
| --- | --- |
| `title` | Section heading. **Required.** |
| `fields` | Columns in this section, in order. |
| `span` | How many form columns the section spans. |
| `collapsible` | Whether the section can be collapsed. |

::: tip Two ways to assign a field to a section
You can either list fields inside `section { fields = [...] }`, or tag a field
from its own block with `field "email" { group = "Contact" }`. Use whichever
reads better; they compose.
:::

### Sidebar

The meta rail is **automatic**: any identifier, foreign key or timestamp you
don't place in a section is detected and shown there — so you rarely write a
`sidebar` block at all. A meta field you *do* list in a section stays in that
section.

Override the auto rail only when you want a specific, curated set:

```hcl
detail {
  sidebar {
    fields = ["id", "customer_id", "product_id", "started_at", "renews_at"]
  }
}
```

### Modes

`mode` chooses how a record is presented when opened from a list:

- **`page`** (default) — a full detail page with its own URL.
- **`drawer`** — a side panel that slides over the list.
- **`modal`** — a centered dialog.

## Inlines

Inlines embed rows of a related child table directly in a parent's detail view —
the classic "orders on a customer" layout. Declare them in `relations { }`.

### Simple form

List child table names and steward infers the foreign key:

```hcl
relations {
  inlines = ["orders", "subscriptions"]
}
```

Each inline renders the child table's own list columns (capped per page) and
respects that child table's permissions and role rules.

### Full form

For control over the FK, label, columns, and whether rows can be added/removed
inline, use object syntax:

```hcl
relations {
  inlines = [
    {
      table      = "order_items"
      fk_col     = "order_id"        # explicit FK column (inferred if omitted)
      label      = "Line items"      # section heading (defaults to the table label)
      columns    = ["product_id", "qty", "unit_price"]
      can_create = false             # allow creating child rows inline
      can_delete = true              # allow deleting child rows inline
    },
  ]
}
```

| Key | Description |
| --- | --- |
| `table` | The child table name. **Required.** |
| `fk_col` | The child column pointing back at this record. Inferred from FKs when omitted. |
| `label` | Heading for the inline section. |
| `columns` | Child columns to show. Omit → the child's list columns. |
| `can_create` | Whether new child rows can be created inline. |
| `can_delete` | Whether child rows can be deleted inline. |

Inline edits still pass through the child table's permission checks — an inline
can never grant access the child config withholds. See
[Roles & permissions](/roles-and-permissions).
