---
description: "Run cartapel in your team's languages — every viewer picks their own, built-in UI locales, per-string overrides, and per-locale labels for your own tables and fields."
---

# Localization

Two independent layers localize a panel: the **chrome** (cartapel's own UI —
buttons, menus, empty states) and your **data labels** (table, field, group
and action names, which come from your config). Both follow the language the
*viewer* is reading in — one instance serves a Spanish-speaking support team
and an English-speaking ops team at the same time.

## Which language a viewer gets

In order, the first that applies:

1. **Their own pick** — *Language* in the user menu, remembered in the browser.
2. **The browser's language** (`Accept-Language` order), when it is one the panel ships.
3. **The instance default**, `locale` in `config/cartapel.hcl`.
4. English.

```hcl
# config/cartapel.hcl
locale = "en"     # the default when neither the viewer nor the browser says otherwise
```

The chrome ships fully translated in English and Spanish; a missing string —
or an unknown `locale` value — falls back to English. Dates, numbers and money
follow the same language automatically (`Intl.NumberFormat` /
`Intl.DateTimeFormat`), and so does `<html lang>`.

The selector shows each language by its own name, so a reader who cannot read
the current one can still find theirs. It only appears when more than one
language is shipped.

### Overriding individual strings

Any built-in string can be replaced with `strings`. A flat entry applies in
every language; an entry keyed by a language code applies to that language
only and wins over the flat one. Keep placeholders like `{label}` intact:

```hcl
strings = {
  "new_record" = "Add {label}"                 # every language
  es = { "new_record" = "Añadir {label}" }     # Spanish only
}
```

## Your data labels

`label` / `label_plural` name things in one language. Add per-locale overrides
with `labels` maps — the viewer's language picks the entry, `label` is the
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
| Groups (`_group.hcl`) | `labels` — the sidebar section name, and the group a page or table reports |
| Actions (`action "…" { }`) | `labels` — bulk-action buttons |
| Pages (a folder's `screen.hcl` with panels) | `labels` — the sidebar entry and the page title |

Resolution happens **server-side at one point** (the meta the frontend renders
from): the browser sends the viewer's language in an `X-Cartapel-Locale`
header and the server resolves every label in it, falling back to the instance
`locale` when the header is absent. Config stays reviewable — the translation
lives next to the thing it names — and a deployment pays nothing for languages
nobody reads.

## Adding a language

The dictionaries live in `ui/src/locales/`, one file per language, registered
in `ui/src/locales/index.ts` with the language's own name. A test pins every
language to the English key set and to the same `{placeholders}` per key, so
a hole or a mistranslated placeholder fails the build rather than rendering a
raw key. Pull requests for new languages are welcome.

## Notes

- **Dashboard/panel labels** are author content (plain strings in
  `dashboard.hcl`) — write them in your team's language directly, or use
  `labels` on the tables and fields they point at.
- **Error messages from the server** are English today.
