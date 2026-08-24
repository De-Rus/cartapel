---
description: "Where cartapel fits next to Django admin, Retool, Metabase, Directus, NocoDB, Baserow and pgAdmin — a short summary, with the full comparison on cartapel.com."
canonical: https://cartapel.com/compare/
---

# cartapel vs the alternatives

There are many good ways to put an admin UI in front of a database. The full,
tool-by-tool comparison — what each alternative does *better*, and when you
should pick it instead — lives on the marketing site, one page per tool:

- [cartapel vs Django admin](https://cartapel.com/compare/django-admin/) — side-by-side syntax, and why the live schema beats keeping ORM models in sync
- [cartapel vs Retool](https://cartapel.com/compare/retool/) — app builder versus database panel, and what per-seat pricing buys
- [cartapel vs Metabase](https://cartapel.com/compare/metabase/) — analytics versus operations, and why most teams run both
- [cartapel vs Directus](https://cartapel.com/compare/directus/) — the closest neighbour: platform versus panel, MIT versus BSL
- [cartapel vs NocoDB](https://cartapel.com/compare/nocodb/) and [Baserow](https://cartapel.com/compare/baserow/) — spreadsheet UI versus a schema your application owns
- [cartapel vs pgAdmin](https://cartapel.com/compare/pgadmin/) — the DBA workbench you keep, and the panel you can hand to support

## The short version

cartapel's shape, in one line: a single self-hosted Rust binary that introspects
an existing Postgres, MySQL or MariaDB database and serves a CRUD panel — roles
with inheritance, an audit log with revert, SQL dashboards, pages of your own —
all configured as HCL files you review in pull requests, written by hand or
published from the panel's own visual editor. MIT licensed, free.

Where it is **not** the right choice:

- **Already on Django with real models** — use Django admin.
- **Apps over many data sources, not a panel over your databases** — use Retool,
  or Appsmith and Budibase in open source.
- **Analytics and self-serve exploration** — use Metabase. If Grafana already
  owns your metrics, keep it: a Grafana panel embeds into a cartapel dashboard
  as an `iframe` widget.
- **Non-technical users owning data in a spreadsheet-like UI** — use NocoDB or
  Baserow.
- **A generated API, automations and a CMS alongside the admin** — use Directus.
- **Administering the database server itself** — use pgAdmin.

What cartapel is for: a team with an existing production database that wants a
safe, audited, role-scoped operations panel — one binary, with the whole
configuration reviewable in a pull request. If that is the shape of your
problem, [get started](/getting-started) or click around the
[live demo](https://demo.cartapel.com).
