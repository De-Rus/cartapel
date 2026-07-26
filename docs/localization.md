---
description: "Run cartapel in your team's language — built-in UI locales, per-string overrides, and per-locale labels for your own tables and fields."
---

# Localization

Two independent layers localize a panel: the **chrome** (cartapel's own UI —
buttons, menus, empty states) and your **data labels** (table, field, group and
action names, which come from your config).

## Basics: the UI language

```hcl
# config/cartapel.hcl
locale = "en"     # "es" (default) | "en"
```

The chrome ships fully translated in Spanish and English. `locale` picks the
dictionary for every built-in string; a missing string — or an unknown
`locale` value — falls back to the Spanish default.

### Overriding individual strings

Any built-in string can be replaced with `strings` — the override wins over
the dictionary for that key, in any locale. Useful for house terminology
without forking a dictionary (keep placeholders like `{label}` intact):

```hcl
locale  = "en"
strings = {
  "new_record" = "Add {label}"
  "clear_all"  = "reset"
}
```

## Basics: your data labels

`label` / `label_plural` name things in one language. Add per-locale overrides
with `labels` maps — the instance `locale` picks the entry, `label` is the
fallback:

```hcl
# screens/customers/customers/screen.hcl
label         = "customer"
label_plural  = "Customers"
labels        = { es = "cliente" }
labels_plural = { es = "Clientes" }

field "plan" {
  label  = "Plan"
  labels = { es = "Tarifa" }
}
```

`labels` works on:

| Where | Keys |
| --- | --- |
| Tables (`screen.hcl`) | `labels` (singular) + `labels_plural` |
| Fields (`field "…" { }`) | `labels` — column headers, detail labels **and filter chips** |
| Groups (`_group.hcl`) | `labels` — the sidebar section name |
| Actions (`action "…" { }`) | `labels` — bulk-action buttons |

Resolution happens **server-side at one point** (the meta the frontend renders
from), so a deployment pays nothing for locales it doesn't use — and config
stays reviewable: the translation lives next to the thing it names.

## Advanced

- **One locale per deployment.** `locale` is an instance setting, not a
  per-user preference — an admin panel typically serves one team. Run two
  instances off the same config bundle with different `locale` env-interpolated
  values if you truly need both.
- **Dates, numbers and money** follow the instance `locale` automatically —
  the frontend feeds it to `Intl.NumberFormat` / `Intl.DateTimeFormat` before
  anything renders. No configuration needed.
- **Dashboard/panel labels** are author content (plain strings in
  `dashboard.hcl`) — write them in your team's language directly.
