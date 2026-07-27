---
description: "An honest comparison of database admin panels: cartapel vs Django admin, Retool, Metabase, NocoDB, Baserow, Directus and pgAdmin — who each tool is actually for, and where cartapel is not the right choice."
---

# cartapel vs the alternatives

There are many good ways to put an admin UI in front of a database. This page
tries to be the comparison a fair-minded engineer would trust: what cartapel
does well, what each alternative does *better*, and when you should pick them
instead.

cartapel's shape, in one line: a single self-hosted Rust binary that
introspects an existing Postgres, MySQL or MariaDB database and serves a CRUD
panel — roles with inheritance, an audit log with revert, SQL dashboards,
custom pages — all configured as HCL files you review in pull requests. MIT
licensed, free.

## At a glance

| | cartapel | Django admin | Retool | Metabase | NocoDB / Baserow | Directus | pgAdmin |
|---|---|---|---|---|---|---|---|
| Databases | ✅ Postgres, MySQL, MariaDB (+ ClickHouse read-only) | ⚠️ whatever Django supports, via models | ✅ many sources | ✅ many sources | ⚠️ Postgres/MySQL + its own tables | ✅ several SQL databases | ❌ Postgres only |
| Self-hosted single binary | ✅ one Rust binary | ❌ part of a Python app | ❌ multi-container self-host, or SaaS | ❌ JVM app | ❌ Node/Python services | ❌ Node app | ❌ Python app |
| Works on an *existing* db without owning the schema | ✅ introspects live schema | ⚠️ via ORM models you must generate and keep in sync | ✅ queries any source | ✅ (read-oriented) | ⚠️ NocoDB yes; Baserow prefers its own tables | ✅ introspects | ✅ raw access |
| Config as code, reviewable in PRs | ✅ HCL in git | ✅ Python in git | ⚠️ GUI-first; git sync on paid tiers | ⚠️ GUI-first; serialization is a paid feature | ❌ GUI-configured | ⚠️ config lives in the db; snapshot export | ❌ n/a |
| Roles + audit log built in | ✅ inheritance, multi-role, audit with revert | ⚠️ solid roles; audit needs third-party packages | ⚠️ full audit on higher tiers | ⚠️ row-level sandboxing is paid | ⚠️ roles yes; audit varies by tier | ✅ granular roles; accountability tracking | ❌ Postgres roles only |
| Dashboards | ✅ SQL tiles, charts, variables | ❌ not built in | ✅ build anything | ✅✅ best-in-class BI | ⚠️ basic views/charts | ⚠️ insights panels | ❌ DBA charts only |
| License + price | MIT, free | BSD, free | Proprietary, per-user pricing | AGPL core; paid Pro/Enterprise | AGPL / open-core | BSL 1.1 (free under revenue cap) | PostgreSQL license, free |

Cells marked ⚠️ are genuinely nuanced — read the sections below before deciding.

## Django admin

If your application is already a Django app, Django admin is very hard to beat:
it lives inside your codebase, shares your models, your auth, and your deploy
pipeline, and its ecosystem of packages (import/export, history, filters,
themes) is enormous and mature. Where it costs you is when the database is
*not* born from Django: you have to run `inspectdb`, hand-correct the generated
models, and keep them in sync with every schema change forever — the ORM model
layer, not the database, is the source of truth. cartapel inverts that: the live
schema *is* the model, so there is nothing to regenerate when a column is
added, and the panel runs as one binary beside any stack — Rails, Go, Node,
or a database no application owns. Django admin has no built-in audit trail or
dashboards (both are third-party packages); cartapel ships both, with
before/after diffs and one-click revert. If you are on Django and your models
already exist, stay on Django admin. If you would be adopting Python and an
ORM *just to get the admin*, that is the case cartapel was built for.

## Retool

Retool is a far broader product than cartapel: a general app builder where you
can compose UIs from dozens of data sources — Postgres next to REST APIs,
GraphQL, Snowflake, S3 — with custom JavaScript everywhere. If you need
arbitrary internal *apps* (approval flows, multi-step wizards spanning three
services), Retool's breadth is the honest answer and cartapel does not attempt
it. The trade-offs are the model: it is proprietary and priced per user, the
self-hosted deployment is a multi-container stack, and apps are built in a
GUI — version control via git sync exists but on paid tiers, and the artifact
you review is generated JSON, not config someone wrote. cartapel covers one
narrower job — a CRUD panel over one Postgres — but does it with an MIT
binary, no per-seat bill, and HCL diffs a reviewer can actually read. Choose
by scope: many sources and custom app logic → Retool; a database admin panel
you want to own outright → cartapel.

## Metabase

Metabase is a business-intelligence tool, and at BI it is simply better than
cartapel: self-serve question building for non-technical users, drill-through,
scheduled reports, alerts, embedding — a depth of analytics cartapel's SQL
dashboards (stat tiles, charts, template variables) do not approach and do not
try to. What Metabase is not is an admin panel: it is read-oriented, and
editing rows, bulk actions, imports, or per-field write permissions are not
its job. Its open-source core is AGPL, with row-level sandboxing, SSO
and config serialization in the paid tiers; it runs as a JVM application.
Many teams reasonably run both shapes of tool side by side: something
Metabase-like for analytics, something cartapel-like for operations — viewing a
customer, fixing a record, refunding an order, with the change audited and
revertible. If your need is charts and self-serve exploration, pick Metabase.

## NocoDB / Baserow

NocoDB and Baserow give you an Airtable-style experience — spreadsheet grids,
kanban and gallery views, forms, real-time collaboration — which is a friendlier
surface for non-technical teams than a classic admin panel, and something
cartapel does not offer. The fit question is who owns the schema: Baserow is
happiest creating and managing its own tables, and NocoDB, while it can connect
to an existing Postgres, layers its own metadata and works best when treated as
the primary interface. Both are configured by clicking in the UI, so the state
of your admin panel lives in their database rather than in files you can diff
and review. cartapel is the opposite bet: your existing schema stays exactly as
your application defined it, cartapel only reads it, and every customization is
HCL in your repo. If you are starting from a spreadsheet and want a database
underneath it, NocoDB or Baserow is the right call; if you are starting from a
production database and want a panel over it, cartapel is.

## Directus

Directus is the closest philosophical neighbor in this list: it also
introspects an existing SQL database (Postgres among several) and mirrors
schema changes both ways. On top of that it does much more than cartapel — it
generates a full REST and GraphQL API over your data, has a flow/automation
engine, digital asset management, and works as a headless CMS; if you need
your admin layer to *also* be your API layer, Directus is the stronger
platform. The differences are footprint and model: Directus is a Node
application whose configuration (collections, permissions, flows) lives in its
system tables — exportable as schema snapshots, but not primarily authored as
files — and since version 10 it is licensed under BSL 1.1, free below a
company revenue threshold rather than open source in the OSI sense. cartapel
is deliberately smaller: one MIT binary, no API generation, no app platform —
just the panel, with the entire configuration as plain HCL in git. Pick by
appetite: platform → Directus; panel → cartapel.

## pgAdmin

pgAdmin is a DBA workbench, not an application admin panel, so this is less a
competition than a boundary line. For database administration — query plans,
vacuum, replication, user grants, ad-hoc SQL against anything — pgAdmin (or
psql, or DBeaver) is the right tool and cartapel does not replace it. What you
should not do is hand pgAdmin to support staff: it exposes raw SQL over every
table with no application-level roles, no column masking, no row filters, and
no audit trail of who changed what. cartapel is the layer you *can* hand out:
an allowlist of tables, per-role and per-column permissions, secret-shaped
columns masked by default, and every write audited with a diff and a revert
button. Most teams running cartapel keep pgAdmin too — engineers use one,
everyone else uses the other.

## Where cartapel is not the right choice

To keep this page honest, the reverse list:

- **You are already on Django with real models** — use Django admin.
- **You need apps over many data sources, not a panel over your databases** —
  use Retool (or Appsmith/Budibase in open source). cartapel mixes several SQL
  databases in one panel, but it is not an app builder over APIs and SaaS.
- **The job is analytics and self-serve exploration** — use Metabase.
- **Non-technical users should own the data in a spreadsheet-like UI** — use
  NocoDB or Baserow.
- **You want a generated API, automations and a CMS along with the admin** —
  use Directus.
- **You are administering the database server itself** — use pgAdmin.

What cartapel is for: a team with an existing production database — Postgres,
MySQL or MariaDB — that wants a safe, audited, role-scoped operations panel — deployed as one binary, with the
whole configuration reviewable in a pull request. If that is the shape of your
problem, [get started](/getting-started) or click around the
[live demo](https://demo.cartapel.com).
