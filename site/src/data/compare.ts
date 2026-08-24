// One entry per alternative. Each becomes /compare/<slug>/ via
// src/pages/compare/[slug].astro; the hub at /compare/ renders the matrix and
// links out. Keep the prose per page distinct — these pages compete for
// different queries, and near-identical bodies get folded together.

export type Tone = 'yes' | 'mid' | 'no'
export type Cell = { v: string; tone: Tone }

export interface Row {
  label: string
  cartapel: Cell
  other: Cell
}

export interface CodePair {
  what: string
  note?: string
  left: { label: string; code: string }
  right: { label: string; code: string }
}

export interface Alt {
  slug: string
  /** Short name used in the nav, matrix header and prose. */
  name: string
  /** Column header in the hub matrix (may differ from `name`). */
  column: string
  h1: string
  title: string
  description: string
  /** One line, used on the hub card. */
  card: string
  /** Lead paragraphs of the page. */
  intro: string[]
  rows: Row[]
  /** Honest case for the alternative. */
  them: { head: string; items: string[] }
  /** Honest case for cartapel. */
  us: { head: string; items: string[] }
  pairs?: CodePair[]
  /** Closing recommendation, one sentence each way. */
  verdict: { them: string; us: string }
  faq: { q: string; a: string }[]
}

const CARTAPEL_DB: Cell = { v: 'Postgres, MySQL, MariaDB (+ ClickHouse read-only)', tone: 'yes' }
const CARTAPEL_BINARY: Cell = { v: 'One Rust binary', tone: 'yes' }
const CARTAPEL_CONFIG: Cell = {
  v: 'Visual editor or HCL by hand — both produce files in git, reviewed in PRs',
  tone: 'yes',
}
const CARTAPEL_AUDIT: Cell = { v: 'Built in — before/after diff, one-click revert', tone: 'yes' }
const CARTAPEL_LICENSE: Cell = { v: 'MIT, free, no seats', tone: 'yes' }

export const alts: Alt[] = [
  {
    slug: 'django-admin',
    name: 'Django admin',
    column: 'Django admin',
    h1: 'cartapel vs Django admin',
    title: 'cartapel vs Django admin — an admin panel without the ORM',
    description:
      'Django admin needs a Django app and models kept in sync with your schema. cartapel introspects the live database and runs as one binary beside any stack. Side-by-side syntax, and when to stay on Django.',
    card: 'The admin you already know — but the live schema is the model, and there is no Python app to host it.',
    intro: [
      'If your application is already a Django app, Django admin is very hard to beat, and this page will not pretend otherwise. It lives inside your codebase, shares your models, your auth and your deploy pipeline, and its ecosystem — import/export, simple-history, filters, themes — is enormous and mature after two decades.',
      'The comparison only gets interesting when the database was not born from Django. Then Django admin asks you to run <code>inspectdb</code>, hand-correct the generated models, and keep them in sync with every migration anyone else ships — forever. The ORM layer, not the database, becomes the source of truth, and it drifts.',
      'cartapel inverts that: the live schema <em>is</em> the model. It introspects Postgres, MySQL or MariaDB at boot, so a new column shows up without regenerating anything, and the panel runs as a single binary beside any stack — Rails, Go, Node, Elixir, or a database no application owns.',
    ],
    rows: [
      {
        label: 'What it needs to run',
        cartapel: CARTAPEL_BINARY,
        other: { v: 'A Django project, Python runtime and WSGI/ASGI server', tone: 'no' },
      },
      {
        label: 'Existing database you do not own',
        cartapel: { v: 'Introspects the live schema; nothing to sync', tone: 'yes' },
        other: { v: 'inspectdb, then hand-corrected models kept in sync forever', tone: 'mid' },
      },
      {
        label: 'Databases',
        cartapel: CARTAPEL_DB,
        other: { v: 'Whatever Django supports, through models', tone: 'mid' },
      },
      {
        label: 'Customization',
        cartapel: CARTAPEL_CONFIG,
        other: { v: 'Python in git — ModelAdmin classes, full escape hatch', tone: 'yes' },
      },
      {
        label: 'Audit log',
        cartapel: CARTAPEL_AUDIT,
        other: { v: 'LogEntry covers admin actions; full history via packages', tone: 'mid' },
      },
      {
        label: 'Dashboards',
        cartapel: { v: 'SQL tiles, charts and template variables', tone: 'yes' },
        other: { v: 'Not built in', tone: 'no' },
      },
      {
        label: 'Ecosystem',
        cartapel: { v: 'Young — widgets are small JS files you drop in', tone: 'mid' },
        other: { v: 'Two decades of third-party packages', tone: 'yes' },
      },
      { label: 'License', cartapel: CARTAPEL_LICENSE, other: { v: 'BSD, free', tone: 'yes' } },
    ],
    them: {
      head: 'Where Django admin is the better answer',
      items: [
        '<strong>You are already a Django shop.</strong> The models exist, they are correct, and the admin inherits your auth, permissions, signals and tests for free. Adding a second service to do what you already have is a loss.',
        '<strong>You need arbitrary Python at the edges.</strong> A <code>save_model</code> that fires a Celery task, a form with cross-field validation, a custom view mounted in the admin — Django lets you write anything, because it is your application.',
        '<strong>The ecosystem is the feature.</strong> django-import-export, django-simple-history, django-admin-rangefilter and a hundred more, all installable today.',
      ],
    },
    us: {
      head: 'Where cartapel is the better answer',
      items: [
        '<strong>The database is not a Django database.</strong> No models to generate, no drift, no <code>managed = False</code> archaeology. Point it at the URL and the panel exists.',
        '<strong>You would be adopting Python just for the admin.</strong> A Go or Node team should not run a Django app in production to let support fix a row.',
        '<strong>Audit and dashboards out of the box.</strong> Every write is logged with a before/after diff and a revert button, and SQL tiles are a block of HCL rather than a third-party package plus a template override.',
        '<strong>The config is small enough to review.</strong> An empty <code>screen.hcl</code> is already a working table; the diff in a pull request is five lines, not a Python class.',
      ],
    },
    pairs: [
      {
        what: 'Expose a table',
        note: 'Django needs a model · cartapel reads the live schema',
        left: {
          label: 'Django',
          code: `# models.py — or inspectdb forever
class Order(models.Model):
    customer = models.ForeignKey(...)
    status = models.CharField(...)
    total = models.DecimalField(...)
    placed_at = models.DateTimeField(...)

# admin.py
@admin.register(Order)
class OrderAdmin(admin.ModelAdmin):
    pass`,
        },
        right: {
          label: 'cartapel',
          code: `# screens/sales/orders/screen.hcl
# empty file → working list already
# (search, filters, sort, FKs as links)`,
        },
      },
      {
        what: 'Shape the list',
        note: 'list_display / list_filter / ordering',
        left: {
          label: 'Django',
          code: `@admin.register(Order)
class OrderAdmin(admin.ModelAdmin):
    list_display = (
        "id", "customer", "status",
        "total", "placed_at",
    )
    list_filter = ("status",)
    ordering = ("-placed_at",)`,
        },
        right: {
          label: 'cartapel',
          code: `list {
  columns = [
    "id", "customer_id", "status",
    "total", "placed_at",
  ]
  filters = ["status"]
  sort    = "-placed_at"
}`,
        },
      },
      {
        what: 'Bulk action',
        note: '@admin.action → action block',
        left: {
          label: 'Django',
          code: `@admin.action(description="Refund")
def refund(self, request, qs):
    qs.update(status="refunded")

class OrderAdmin(admin.ModelAdmin):
    actions = ["refund"]`,
        },
        right: {
          label: 'cartapel',
          code: `action "refund" {
  label   = "Refund"
  kind    = "update"
  set     = { status = "refunded" }
  confirm = "Refund {count} orders?"
}`,
        },
      },
      {
        what: 'Render a field',
        note: 'readonly display method → widget block',
        left: {
          label: 'Django',
          code: `class OrderAdmin(admin.ModelAdmin):
    @admin.display(description="Status")
    def status_badge(self, obj):
        color = {"paid": "green",
                 "refunded": "red"}[obj.status]
        return format_html(
            '<span style="color:{}">{}</span>',
            color, obj.status)`,
        },
        right: {
          label: 'cartapel',
          code: `field "status" {
  widget = "badge"
  params = {
    colors = {
      paid     = "green"
      refunded = "red"
    }
  }
}`,
        },
      },
    ],
    verdict: {
      them: 'Your app is Django and the models already exist — stay on Django admin.',
      us: 'The database predates you, belongs to another stack, or nobody wants a Python app just to get a panel.',
    },
    faq: [
      {
        q: 'Can I run cartapel next to an existing Django admin?',
        a: 'Yes, and it is a common shape: Django admin for the engineers who live in the codebase, cartapel for support and ops, with its own roles, column masking and audit trail. They read the same database and neither owns the schema.',
      },
      {
        q: 'Do I lose Django signals and model validation?',
        a: 'Yes — cartapel writes to the database, not through your ORM, so Python-level signals and validators do not fire. Constraints, triggers and defaults in the database still apply. If your invariants live only in Python, keep those tables out of cartapel or move the rule into the schema.',
      },
      {
        q: 'Does it handle Django auth tables?',
        a: 'It can browse them like any other table, but password hashing is a Django concern. Treat user credentials as read-only and mask hash columns; cartapel masks secret-shaped columns by default.',
      },
      {
        q: 'Is there an inspectdb equivalent?',
        a: 'There is nothing to run. Introspection happens at boot and on demand, so a migration shipped by another team is visible in the panel without a code change on your side.',
      },
    ],
  },

  {
    slug: 'retool',
    name: 'Retool',
    column: 'Retool',
    h1: 'cartapel vs Retool',
    title: 'cartapel vs Retool — an open-source, self-hosted alternative',
    description:
      'Retool is a broad internal-app builder with per-user pricing and GUI-authored apps. cartapel is one MIT-licensed binary over your own database, configured in HCL you review in pull requests. An honest comparison.',
    card: 'The open-source, self-hosted answer when what you actually needed was a database panel, not an app builder.',
    intro: [
      'Retool is a far broader product than cartapel, and the comparison is only fair if that is said first. It is a general internal-app builder: drag components onto a canvas, wire them to dozens of data sources — Postgres beside REST, GraphQL, Snowflake, Stripe, S3 — and glue it together with JavaScript anywhere a value can go.',
      'cartapel does one narrower job: a CRUD and dashboard panel over SQL databases you already run. If your internal tool spans three services and a payments API, Retool is the honest answer and this page will tell you so.',
      'The reason teams look for an alternative is usually not features. It is the model: proprietary and priced per user, a multi-container stack if you self-host, and apps authored in a GUI whose reviewable artifact is generated JSON. cartapel is the opposite trade — one MIT binary, no seats, and configuration that is a handful of HCL files a reviewer reads in a pull request.',
    ],
    rows: [
      {
        label: 'Scope',
        cartapel: { v: 'Admin panel over SQL databases', tone: 'mid' },
        other: { v: 'General internal-app builder over any source', tone: 'yes' },
      },
      {
        label: 'Data sources',
        cartapel: CARTAPEL_DB,
        other: { v: 'Dozens — SQL, REST, GraphQL, SaaS APIs', tone: 'yes' },
      },
      {
        label: 'Self-hosting',
        cartapel: CARTAPEL_BINARY,
        other: { v: 'Multi-container deployment, or SaaS', tone: 'no' },
      },
      {
        label: 'Authoring',
        cartapel: CARTAPEL_CONFIG,
        other: { v: 'GUI-first; git sync on paid tiers, as generated JSON', tone: 'mid' },
      },
      {
        label: 'Pricing',
        cartapel: CARTAPEL_LICENSE,
        other: { v: 'Proprietary, per user, per month', tone: 'no' },
      },
      {
        label: 'Audit log',
        cartapel: CARTAPEL_AUDIT,
        other: { v: 'Audit logs on higher tiers', tone: 'mid' },
      },
      {
        label: 'Time to a working panel',
        cartapel: { v: 'Introspected — every table works before you configure it', tone: 'yes' },
        other: { v: 'You build each screen', tone: 'mid' },
      },
      {
        label: 'Custom logic',
        cartapel: { v: 'Declarative actions; JS only inside custom widgets', tone: 'mid' },
        other: { v: 'JavaScript everywhere, arbitrary workflows', tone: 'yes' },
      },
    ],
    them: {
      head: 'Where Retool is the better answer',
      items: [
        '<strong>Your tool is not a database panel.</strong> Approval flows that call three services, a support console stitching Stripe to your database to Zendesk — that is what Retool is for and cartapel does not attempt it.',
        '<strong>Non-SQL sources are first-class.</strong> REST, GraphQL, warehouses and SaaS connectors, with the auth handled for you.',
        '<strong>You want to build UI by dragging.</strong> Some teams genuinely prefer a canvas, and Retool has the deepest component library in this category.',
        '<strong>Enterprise checkboxes now.</strong> SSO, SCIM, granular org permissions and support contracts are mature and purchasable.',
      ],
    },
    us: {
      head: 'Where cartapel is the better answer',
      items: [
        '<strong>The panel is over your own database.</strong> Introspection means the boring 90% — list, search, filter, detail, inline edit, foreign keys as links — exists before you write a line of config.',
        '<strong>No per-seat bill.</strong> Adding the whole support team costs nothing, so nobody ends up sharing a login to save money.',
        '<strong>You get the GUI <em>and</em> the file.</strong> Build a screen, a permission set or a dashboard tile in the panel\'s own editor, see the diff, publish — and what lands is HCL in your config directory, hot-reloaded. On a read-only deployment it hands you the HCL to commit instead.',
        '<strong>The configuration is the review.</strong> A diff of HCL is readable; a diff of exported app JSON is not. Changes ship through the same pipeline as your code.',
        '<strong>It does not want to own everything.</strong> Dashboards are SQL tiles you write, and a Grafana panel you already maintain can be embedded as an <code>iframe</code> widget instead of rebuilt.',
        '<strong>Self-hosting is trivial.</strong> One binary or one container with a database URL — no orchestration, no license server, and your production data never leaves your network.',
      ],
    },
    verdict: {
      them: 'You need apps over many sources with custom logic — Retool, or Appsmith and Budibase in open source.',
      us: 'You need a safe, audited panel over databases you already run, owned outright and free per user.',
    },
    faq: [
      {
        q: 'Is cartapel a drop-in Retool replacement?',
        a: 'No. It replaces the most common Retool use case — internal CRUD over your database, with roles and an audit trail — not the app builder. If your Retool apps orchestrate external APIs, cartapel is the wrong shape.',
      },
      {
        q: 'What does cartapel cost at 50 users?',
        a: 'Nothing. It is MIT licensed with no seat counting, no feature gating and no license key; you pay for the machine it runs on.',
      },
      {
        q: 'Can I keep app state and logic in version control?',
        a: 'That is the premise. Screens, fields, actions, roles and dashboards are HCL files in your repository, reviewed in pull requests and deployed like any other change.',
      },
      {
        q: 'Does it connect to REST APIs?',
        a: 'No. Sources are SQL databases: Postgres, MySQL and MariaDB read-write, ClickHouse read-only. Several can be mixed in one panel, but an HTTP endpoint is not a source.',
      },
    ],
  },

  {
    slug: 'metabase',
    name: 'Metabase',
    column: 'Metabase',
    h1: 'cartapel vs Metabase',
    title: 'cartapel vs Metabase — BI tool or admin panel?',
    description:
      'Metabase is a business-intelligence tool: questions, drill-through, scheduled reports. cartapel is an operations panel: editing rows, bulk actions, per-column permissions and an audit log. Where the line falls.',
    card: 'Metabase answers questions about the data. cartapel changes it, safely, and writes down who did.',
    intro: [
      'These two are less rivals than neighbours, and picking between them usually means one of the two teams asking has the wrong tool in mind.',
      'Metabase is a business-intelligence tool, and at BI it is better than cartapel by a wide margin: self-serve question building for people who do not write SQL, drill-through, scheduled reports, alerts, embedded analytics. cartapel has SQL dashboards — stat tiles, charts, template variables — and does not try to approach that depth.',
      'The same goes for Grafana, which many teams already run for metrics: cartapel sits beside it rather than replacing it, and a Grafana panel can be embedded straight into a cartapel dashboard as an <code>iframe</code> widget, next to the SQL tiles and the tables people edit.',
      'What Metabase is not is an admin panel. It is read-oriented by design: editing a row, running a bulk action, importing a CSV into a production table or granting write access to one column and not another are not jobs it takes on. That is the entire subject of cartapel.',
    ],
    rows: [
      {
        label: 'Primary job',
        cartapel: { v: 'Operations — read and write records safely', tone: 'yes' },
        other: { v: 'Analytics — ask questions of the data', tone: 'yes' },
      },
      {
        label: 'Editing data',
        cartapel: { v: 'Inline edit, forms, bulk actions, imports', tone: 'yes' },
        other: { v: 'Read-oriented; limited actions', tone: 'no' },
      },
      {
        label: 'Charts and exploration',
        cartapel: { v: 'SQL tiles and charts you author, plus embedded Grafana panels', tone: 'mid' },
        other: { v: 'Best-in-class self-serve BI', tone: 'yes' },
      },
      {
        label: 'Write permissions',
        cartapel: { v: 'Per table, per column, per row, with inheritance', tone: 'yes' },
        other: { v: 'Read permissions; sandboxing is a paid feature', tone: 'mid' },
      },
      { label: 'Audit of changes', cartapel: CARTAPEL_AUDIT, other: { v: 'Not the model — little is written', tone: 'no' } },
      { label: 'Runtime', cartapel: CARTAPEL_BINARY, other: { v: 'JVM application', tone: 'no' } },
      {
        label: 'Configuration',
        cartapel: CARTAPEL_CONFIG,
        other: { v: 'GUI; serialization to files is a paid feature', tone: 'mid' },
      },
      {
        label: 'License',
        cartapel: CARTAPEL_LICENSE,
        other: { v: 'AGPL core, paid Pro and Enterprise tiers', tone: 'mid' },
      },
    ],
    them: {
      head: 'Where Metabase is the better answer',
      items: [
        '<strong>Non-technical people need to ask their own questions.</strong> The query builder, drill-through and saved questions are the product, and nothing in cartapel substitutes for them.',
        '<strong>Scheduled reports and alerts.</strong> Email and Slack delivery, thresholds, subscriptions — mature and out of the box.',
        '<strong>Many warehouses and sources.</strong> BigQuery, Snowflake, Redshift and the rest, which cartapel does not speak.',
        '<strong>Embedded analytics for customers.</strong> A supported, well-trodden path.',
      ],
    },
    us: {
      head: 'Where cartapel is the better answer',
      items: [
        '<strong>Someone has to change the record.</strong> Fix an address, refund an order, flip a flag — with a confirm dialog, a permission check and a diff, not a SQL console.',
        '<strong>The write side needs permissions.</strong> A support role that may edit two columns of one table, with everything else read-only or hidden, is config rather than a paid tier.',
        '<strong>You want the change reversible.</strong> Every write lands in an audit log with before and after values and a revert button.',
        '<strong>It sits beside what you already run.</strong> If Grafana owns your metrics, keep it — a Grafana panel drops into a cartapel dashboard as an <code>iframe</code> widget, so operations and observability live on one screen.',
        '<strong>Small footprint.</strong> One binary next to your database rather than a JVM service to size and babysit.',
      ],
    },
    verdict: {
      them: 'The job is charts, exploration and reporting — Metabase, and it is not close.',
      us: 'The job is a safe, audited panel where people change records — cartapel, beside Metabase rather than instead of it.',
    },
    faq: [
      {
        q: 'Can cartapel replace our Metabase dashboards?',
        a: 'Some of them. Stat tiles, charts and tables from SQL with template variables cover the operational dashboard an ops team keeps open. Self-serve exploration for analysts is not the same job and Metabase keeps it.',
      },
      {
        q: 'Do the dashboards run against production safely?',
        a: 'Dashboard SQL runs in read-only transactions with a statement timeout, and every value is a bound parameter, so a tile cannot write or run away with your database.',
      },
      {
        q: 'Can we run both?',
        a: 'That is the usual arrangement: Metabase for analytics, cartapel for operations. They read the same database and neither owns the schema.',
      },
    ],
  },

  {
    slug: 'directus',
    name: 'Directus',
    column: 'Directus',
    h1: 'cartapel vs Directus',
    title: 'cartapel vs Directus — panel or platform?',
    description:
      'Directus introspects your SQL database and adds a REST/GraphQL API, flows and a headless CMS, under BSL 1.1. cartapel is one MIT binary that is only the admin panel, configured as HCL in git.',
    card: 'The closest philosophical neighbour — same introspection bet, a much larger surface, and a different licence.',
    intro: [
      'Directus is the closest thing to cartapel in this list, and shares its central bet: point it at an existing SQL database, introspect the schema, and do not demand that you rebuild your data model to suit the tool.',
      'On top of that it does considerably more. It generates a full REST and GraphQL API over your data, has a flow and automation engine, digital asset management, and works as a headless CMS. If your admin layer must also be your API layer, Directus is the stronger platform and cartapel is not a candidate.',
      'The differences are footprint, authoring and licence. Directus is a Node application whose configuration — collections, fields, permissions, flows — lives in its own system tables inside your database; it is exportable as schema snapshots, but it is not primarily authored as files. And since version 10 it is licensed under BSL 1.1: free below a revenue threshold, not open source in the OSI sense. cartapel is deliberately smaller: one MIT binary, no API generation, no app platform, and the whole configuration is plain HCL in your repository.',
    ],
    rows: [
      {
        label: 'Scope',
        cartapel: { v: 'Admin panel only', tone: 'mid' },
        other: { v: 'Panel + REST/GraphQL API + flows + DAM + CMS', tone: 'yes' },
      },
      {
        label: 'Existing database',
        cartapel: { v: 'Introspects the live schema', tone: 'yes' },
        other: { v: 'Introspects, and mirrors schema changes both ways', tone: 'yes' },
      },
      {
        label: 'Databases',
        cartapel: CARTAPEL_DB,
        other: { v: 'Postgres, MySQL, SQLite, MSSQL, Oracle and more', tone: 'yes' },
      },
      { label: 'Runtime', cartapel: CARTAPEL_BINARY, other: { v: 'Node application', tone: 'no' } },
      {
        label: 'Where config lives',
        cartapel: CARTAPEL_CONFIG,
        other: { v: 'System tables in your database; snapshot export', tone: 'mid' },
      },
      {
        label: 'Writes to your schema',
        cartapel: { v: 'Never — reads the schema, writes only rows you allow', tone: 'yes' },
        other: { v: 'Adds directus_* system tables', tone: 'mid' },
      },
      {
        label: 'License',
        cartapel: CARTAPEL_LICENSE,
        other: { v: 'BSL 1.1 — free under a revenue cap', tone: 'mid' },
      },
      {
        label: 'Audit log',
        cartapel: CARTAPEL_AUDIT,
        other: { v: 'Activity and revisions tracked', tone: 'yes' },
      },
    ],
    them: {
      head: 'Where Directus is the better answer',
      items: [
        '<strong>You need an API, not only a panel.</strong> Auto-generated REST and GraphQL over the same schema, with permissions applied, is a large amount of work you get for free.',
        '<strong>Content, not just records.</strong> Media handling, image transformations and editorial workflows are a real CMS, and cartapel has none of it.',
        '<strong>Automations.</strong> The flows engine covers webhooks, scheduled jobs and event-driven logic without another service.',
        '<strong>Schema management from the UI.</strong> Directus can create and alter collections; cartapel deliberately never touches your DDL.',
      ],
    },
    us: {
      head: 'Where cartapel is the better answer',
      items: [
        '<strong>You want a panel and nothing else.</strong> No system tables in your database, no API surface to secure, no platform to learn.',
        '<strong>The licence has to be permissive.</strong> MIT, with no revenue threshold to re-evaluate as the company grows.',
        '<strong>Config belongs in the repo, not in system tables.</strong> The visual editor writes HCL files you commit; reviewing a snapshot export of database rows is not the same as reviewing five lines of HCL in a pull request.',
        '<strong>Deployment budget is one process.</strong> A Rust binary with a database URL, no Node runtime and no build step to add a page.',
      ],
    },
    verdict: {
      them: 'You are choosing a data platform — API, automations and content alongside the admin.',
      us: 'You are choosing an admin panel, permissively licensed, with configuration that lives in git.',
    },
    faq: [
      {
        q: 'Does cartapel create tables in my database?',
        a: 'No. It reads your schema and writes only to the rows and columns you expose. Its own state — sessions, audit log, saved views — lives in a small separate data directory, so the database it administers stays exactly as your application defined it.',
      },
      {
        q: 'Can cartapel serve an API like Directus?',
        a: 'No, and it is not planned. If you need a generated REST or GraphQL layer over the same schema, Directus is the better fit.',
      },
      {
        q: 'What does BSL 1.1 mean in practice?',
        a: 'Directus is free to use below a company revenue threshold and requires a commercial licence above it, with each version converting to a fully open licence after a delay. Whether that matters depends on your company; cartapel is MIT with no such condition.',
      },
    ],
  },

  {
    slug: 'nocodb',
    name: 'NocoDB',
    column: 'NocoDB',
    h1: 'cartapel vs NocoDB',
    title: 'cartapel vs NocoDB — spreadsheet UI or admin panel?',
    description:
      'NocoDB turns a database into an Airtable-style workspace with grids, kanban and forms, configured by clicking. cartapel is a config-as-code admin panel over a schema your application owns.',
    card: 'A spreadsheet over your database, versus a reviewable panel over a schema you did not want touched.',
    intro: [
      'NocoDB gives you an Airtable-style experience over a database: spreadsheet grids, kanban and gallery views, forms to collect data, sharing links and real-time collaboration. For a team that thinks in spreadsheets, that surface is friendlier than any classic admin panel, and cartapel does not offer it.',
      'The fit question is who owns the schema and where the configuration lives. NocoDB can connect to an existing Postgres or MySQL, but it layers its own metadata alongside and is happiest treated as the primary interface to the data. Views, fields and permissions are configured by clicking, so the state of your admin panel lives in its database rather than in files you can diff.',
      'cartapel takes the opposite bet on both counts: your schema stays exactly as your application defined it and is only read, and every customization is HCL in your repository that goes through review like any other change.',
    ],
    rows: [
      {
        label: 'Feel',
        cartapel: { v: 'Admin panel — lists, detail pages, forms, actions', tone: 'yes' },
        other: { v: 'Spreadsheet — grid, kanban, gallery, forms', tone: 'yes' },
      },
      {
        label: 'Who owns the schema',
        cartapel: { v: 'Your application; cartapel only reads it', tone: 'yes' },
        other: { v: 'Connects to yours, but adds its own metadata', tone: 'mid' },
      },
      {
        label: 'Configuration',
        cartapel: CARTAPEL_CONFIG,
        other: { v: 'Clicked in the UI, stored in its database', tone: 'no' },
      },
      { label: 'Runtime', cartapel: CARTAPEL_BINARY, other: { v: 'Node services', tone: 'no' } },
      {
        label: 'Non-technical friendliness',
        cartapel: { v: 'Familiar admin UI, no grid editing across rows', tone: 'mid' },
        other: { v: 'Very high — it looks like a spreadsheet', tone: 'yes' },
      },
      {
        label: 'Roles and column masking',
        cartapel: { v: 'Per table, column and row, with inheritance', tone: 'yes' },
        other: { v: 'Base and table level roles', tone: 'mid' },
      },
      { label: 'Audit', cartapel: CARTAPEL_AUDIT, other: { v: 'Record-level history, varies by version', tone: 'mid' } },
      {
        label: 'License',
        cartapel: CARTAPEL_LICENSE,
        other: { v: 'AGPL core with paid tiers', tone: 'mid' },
      },
    ],
    them: {
      head: 'Where NocoDB is the better answer',
      items: [
        '<strong>Your users want a spreadsheet.</strong> Grid editing, kanban boards and gallery views are the point, and they are genuinely more approachable than a table of rows.',
        '<strong>Forms and shared links.</strong> Collecting data from people outside the team is built in.',
        '<strong>The data has no application behind it.</strong> If nothing else writes to these tables, letting NocoDB own them is reasonable.',
        '<strong>Nobody wants to write config.</strong> Clicking is faster than a pull request when there is no reviewer to satisfy.',
      ],
    },
    us: {
      head: 'Where cartapel is the better answer',
      items: [
        '<strong>The database is production.</strong> An application owns the schema, migrations come from your repository, and the panel must adapt to them rather than the other way round.',
        '<strong>Clicking is fine — losing the trail is not.</strong> The built-in editor covers tables, fields, permissions, actions and dashboards, but it publishes HCL into your repository, so who can see which column is a reviewable line in a file rather than a checkbox someone toggled last quarter.',
        '<strong>Sensitive columns.</strong> Secret-shaped fields are masked by default and per-column permissions are first-class.',
        '<strong>One process to deploy.</strong> A single binary rather than a set of Node services.',
      ],
    },
    verdict: {
      them: 'You are starting from a spreadsheet and want a database underneath it.',
      us: 'You are starting from a production database and want a panel over it.',
    },
    faq: [
      {
        q: 'Will cartapel change my tables?',
        a: 'No. It never issues DDL. Tables are an allowlist — nothing is exposed until you register it — and its own state lives outside the database it administers.',
      },
      {
        q: 'Can non-technical staff use cartapel?',
        a: 'Yes — the panel is an ordinary admin UI with search, filter chips, inline editing and confirmable actions. What they do not get is spreadsheet-style bulk editing across a grid.',
      },
      {
        q: 'Is there an import?',
        a: 'CSV import exists for tables you allow, with the same permission and audit rules as any other write.',
      },
    ],
  },

  {
    slug: 'baserow',
    name: 'Baserow',
    column: 'Baserow',
    h1: 'cartapel vs Baserow',
    title: 'cartapel vs Baserow — no-code database or database admin?',
    description:
      'Baserow is an open-source Airtable: it prefers to own its own tables and is configured by clicking. cartapel puts a config-as-code panel over the production database your application already owns.',
    card: 'An open-source Airtable that wants to own the data, versus a panel over data that is already owned.',
    intro: [
      'Baserow is an open-source Airtable, and it is a good one: grids, views, form building, collaboration and a plugin system, self-hostable under an open licence. If the question is where a small team should keep a new dataset, Baserow is a reasonable answer and cartapel is not.',
      'The distinction that matters here is ownership. Baserow is happiest creating and managing its own tables inside its own database — that is the product. Connecting it to a production schema owned by an application is going against the grain, where cartapel is designed for exactly that: introspect what exists, change nothing, and expose only what you register.',
      'The second distinction is where configuration lives. Baserow is configured by clicking, and that state sits in its database. In cartapel the panel is a directory of HCL files in your repository, reviewed in pull requests and deployed with your code.',
    ],
    rows: [
      {
        label: 'Where the data lives',
        cartapel: { v: 'Your existing database, untouched', tone: 'yes' },
        other: { v: 'Its own tables, in its own database', tone: 'mid' },
      },
      {
        label: 'Existing production schema',
        cartapel: { v: 'The whole point — introspected at boot', tone: 'yes' },
        other: { v: 'Against the grain; import-oriented', tone: 'no' },
      },
      {
        label: 'Feel',
        cartapel: { v: 'Admin panel', tone: 'yes' },
        other: { v: 'Airtable-style no-code database', tone: 'yes' },
      },
      {
        label: 'Configuration',
        cartapel: CARTAPEL_CONFIG,
        other: { v: 'Clicked in the UI', tone: 'no' },
      },
      { label: 'Runtime', cartapel: CARTAPEL_BINARY, other: { v: 'Python and Node services', tone: 'no' } },
      {
        label: 'Audit and revert',
        cartapel: CARTAPEL_AUDIT,
        other: { v: 'Row history and trash, varies by tier', tone: 'mid' },
      },
      {
        label: 'License',
        cartapel: CARTAPEL_LICENSE,
        other: { v: 'MIT core with paid premium/enterprise features', tone: 'mid' },
      },
    ],
    them: {
      head: 'Where Baserow is the better answer',
      items: [
        '<strong>The dataset is new and has no application.</strong> Let Baserow own it and skip the migration entirely.',
        '<strong>Non-technical owners.</strong> Building a table, a view and a form without asking an engineer is the whole value proposition.',
        '<strong>Collaboration features.</strong> Comments, sharing and real-time editing that an admin panel does not try to provide.',
      ],
    },
    us: {
      head: 'Where cartapel is the better answer',
      items: [
        '<strong>The data already exists in Postgres, MySQL or MariaDB.</strong> Introspection rather than import; no second copy of the truth.',
        '<strong>Schema changes come from migrations.</strong> A new column appears in the panel without anyone reconfiguring anything.',
        '<strong>Ops needs guardrails.</strong> Per-column permissions, masked secrets, confirmable actions and a revertible audit trail.',
        '<strong>Everything reviewable.</strong> Configure by hand or in the panel\'s visual editor — either way the result is HCL in your repository, so the panel\'s history is your git history.',
      ],
    },
    verdict: {
      them: 'The data does not exist yet and non-technical people should own it.',
      us: 'The data lives in a production database and an application owns the schema.',
    },
    faq: [
      {
        q: 'Can Baserow and cartapel coexist?',
        a: 'Easily, because they answer different questions: Baserow for datasets a team owns outright, cartapel as the operations panel over the application database.',
      },
      {
        q: 'Does cartapel import data?',
        a: 'CSV import into allowed tables, subject to the same permissions and audit as any write. It is an admin function, not a migration tool.',
      },
    ],
  },

  {
    slug: 'pgadmin',
    name: 'pgAdmin',
    column: 'pgAdmin',
    h1: 'cartapel vs pgAdmin',
    title: 'cartapel vs pgAdmin — DBA workbench or panel you can hand out',
    description:
      'pgAdmin is a DBA workbench: query plans, vacuum, grants, raw SQL. cartapel is the layer you can hand to support — allowlisted tables, per-column permissions, masked secrets and an audit log.',
    card: 'Keep pgAdmin for engineers. cartapel is the one you can safely give to everyone else.',
    intro: [
      'This is less a competition than a boundary line, and most teams running cartapel keep pgAdmin installed.',
      'For database administration — query plans, vacuum and bloat, replication, extensions, role grants, ad-hoc SQL against anything — pgAdmin (or psql, or DBeaver) is the right tool and cartapel does not replace any of it. cartapel never issues DDL and has no server administration surface at all.',
      'What you should not do is hand pgAdmin to support staff. It exposes raw SQL over every table with no application-level roles, no column masking, no row filters and no trace of who changed what. One mistyped <code>UPDATE</code> without a <code>WHERE</code> is a bad afternoon, and nothing records it.',
    ],
    rows: [
      {
        label: 'Audience',
        cartapel: { v: 'Support, ops, anyone in the company', tone: 'yes' },
        other: { v: 'Engineers and DBAs', tone: 'yes' },
      },
      {
        label: 'Server administration',
        cartapel: { v: 'None — never issues DDL', tone: 'no' },
        other: { v: 'Query plans, vacuum, replication, grants', tone: 'yes' },
      },
      {
        label: 'Application-level roles',
        cartapel: { v: 'Per table, column and row, with inheritance', tone: 'yes' },
        other: { v: 'Postgres roles only', tone: 'no' },
      },
      {
        label: 'Secret columns',
        cartapel: { v: 'Secret-shaped columns masked by default', tone: 'yes' },
        other: { v: 'Everything is visible', tone: 'no' },
      },
      { label: 'Audit of writes', cartapel: CARTAPEL_AUDIT, other: { v: 'None', tone: 'no' } },
      {
        label: 'Databases',
        cartapel: CARTAPEL_DB,
        other: { v: 'Postgres only', tone: 'mid' },
      },
      {
        label: 'Dashboards',
        cartapel: { v: 'SQL tiles and charts for the business', tone: 'yes' },
        other: { v: 'Server activity charts', tone: 'mid' },
      },
      { label: 'License', cartapel: CARTAPEL_LICENSE, other: { v: 'PostgreSQL licence, free', tone: 'yes' } },
    ],
    them: {
      head: 'Where pgAdmin is the better answer',
      items: [
        '<strong>Anything DBA-shaped.</strong> Explain plans, index maintenance, replication, extensions, tablespaces, grants.',
        '<strong>Ad-hoc SQL with no guardrails.</strong> Sometimes an engineer needs exactly that, and the guardrails are the problem.',
        '<strong>Schema work.</strong> Creating and altering objects, which cartapel deliberately never does.',
      ],
    },
    us: {
      head: 'Where cartapel is the better answer',
      items: [
        '<strong>People who are not engineers need access.</strong> An allowlist of tables, roles with inheritance, and a UI that does not invite a stray <code>DELETE</code>.',
        '<strong>Someone will ask who changed this.</strong> Every write is logged with before and after values and can be reverted from the log.',
        '<strong>Repeated operations should be one click.</strong> A refund or a status flip is a declared action with a confirmation, not a query pasted from a wiki.',
        '<strong>Not only Postgres.</strong> MySQL and MariaDB are equal citizens, ClickHouse joins read-only, and several sources can share one sidebar.',
      ],
    },
    verdict: {
      them: 'You are administering the database server itself.',
      us: 'You are handing a panel to people who should never see a SQL prompt.',
    },
    faq: [
      {
        q: 'Can cartapel run arbitrary SQL?',
        a: 'Dashboard tiles and pages are SQL you author in config, run in read-only transactions with a statement timeout. There is no free-form query console for panel users — that is a deliberate boundary, and where pgAdmin belongs.',
      },
      {
        q: 'How does cartapel limit what a role can see?',
        a: 'Tables are an allowlist, and roles carry per-table, per-column and row-level rules with inheritance and multi-role union. Secret-shaped columns are masked unless explicitly revealed.',
      },
      {
        q: 'Do I still need pgAdmin?',
        a: 'Almost certainly, and that is fine. Engineers use one, everyone else uses the other.',
      },
    ],
  },
]

export const bySlug = Object.fromEntries(alts.map((a) => [a.slug, a]))
