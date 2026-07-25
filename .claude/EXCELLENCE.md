# Excellence backlog — synthesis of the 7-agent audit (2026-07-25)

Seven parallel audits (live QA sweep, UX/UI, DX/config, Rust architecture, frontend/perf,
competitive benchmark, security recheck) of steward at v0.3.0. Security verdict: **clean,
nothing exploitable**. This file is the executable backlog; strike items as they land.

## Already fixed (same day)
- [x] FK create 400: `<col>__label` pseudo-fields stripped at the client boundary (create+patch)
- [x] Filters dead on unconfigured tables: defaults-first server-side (empty `filters` config ⇒
      any real column filters; declared list stays an allowlist) + FilterBuilder falls back to
      introspected columns
- [x] Density toggle wired (was dead code stomped by a hardcoded call)
- [x] RowCreate shows labels, delete failures toast, user-menu i18n keys
- [x] Setup wizard: group move/rename/create; multi-schema keys; group-clobber 409; meta-refetch
      before navigate; skip → /audit

## P1 — broken/UX-critical (next session, in order)
1. **Verify + fix Personalizar Filtros/Búsqueda chips** — QA reported chip toggles don't persist
   (columns checkboxes DO). Chip/ListEditor code looks correct; reproduce in browser, suspect
   ConfigBuilder model propagation for `list.search/filters`, then fix. (QA #1b)
2. **Preserve form state on create error** — RowCreate wipes inputs on 400. (QA #2)
3. **i18n the chrome** — CommandPalette/Shell/KeyboardHelp/DataTable tooltips/UserMenu hardcoded
   English (~30 keys); es-dict leaks (`Dashboard`, `Audit log`, `Tables`, `1 cambios`,
   "Nuevo customers" pluralization). (UX #1, #8; QA #3, #11)
4. **Display-title inference** — detail heading/peek/delete-confirm/cmd-K label = raw pk today;
   infer name/title/email column server-side (fk_label_col already exists — reuse for own-table
   `display.title` default). Also render FK cells as label+link in lists. (QA #5, #6)
5. **Auto-mask secret-shaped columns** in introspected defaults (`*token*`, `*secret*`,
   `*password*`, `*api_key*`) — demo shows sk_live values in cleartext. (QA #4)
6. **Startup failure UX** — replace `.expect()` panics with clean messages (unescaped HCL error,
   fail-fast DB connect with host:port hint, connect BEFORE bootstrapping admin so the one-time
   password print isn't burned). (DX #1, #2)
7. **Reject unknown .hcl stems under screens/** — a typo'd filename silently becomes a phantom
   table today. (DX #3)
8. **Docs: hot-reload claim is false** (no file watcher; only in-app edits hot-swap) + document
   revert / view-as / wizard / dashboard variables / auto-inlines / STEWARD_ADMIN_ROLE. (DX #4, #5)

## P2 — high-value features (ranked by differentiation × feasibility)
1. **`steward check`** — CI-grade config validator (parse + validate + live-schema cross-check,
   file:line + did-you-mean, exit 1). THE config-as-code differentiator. (DX top pick; competitive #2) — S
2. **Palette actions + recents** — cmd-K runs actions ("Export…", "Revert last edit"),
   frecency recents. The Linear-fast feel. (competitive #5) — S
3. **Saved views v2** — shareable deep links + pinned sidebar views (store exists). — M
4. **Chart drill-through** — click a segment → filtered table (variables are the plumbing). — M
5. **Approval flows** — require-second-approver on flagged tables/actions; pending-write +
   diff review. Retool-Enterprise feature, OSS-first. (competitive #1) — M
6. **fs-watch config reload** — makes the hot-reload docs claim true. — S
7. **sx.d.ts** served at /static + error surface in CustomPage failure card. (DX #10) — S
8. **Delete audit stores the row snapshot rendered** (QA #7: shows ∅ today) + restore-deleted-row
   (needs masked-snapshot care). — S/M

## P3 — architecture/perf (mechanical, big payoff)
1. **Lazy lucide dynamic map** — ~550KB of the 883KB entry chunk is the icon import map; wrap in
   React.lazy. −130KB gz. (FE #1) — S
2. **React.lazy the admin/config route cluster** (7 rarely-hit routes). −70KB gz. (FE #2) — S
3. **`commit_config` helper** — the writable→lock→commit→version→audit ceremony is hand-rolled
   11×; make the invariant structural. (Rust #1, top pick) — M
4. **`ro_rows` helper** — the READ ONLY+timeout tx dance is copy-pasted 8× with 4 arbitrary
   timeouts; also gives row endpoints a timeout under the 6543 pooler (currently unbounded). — M
5. Split configedit.rs (fsops.rs + setup.rs); extract Sidebar from Shell, InlineChildTable from
   RowDetail; queryKeys.ts factory + invalidateRowFamily. (Rust #8, FE #3-6) — M
6. Missing tests: revert guard, apply_setup, vars::resolve, view-as extractor, row_filter
   escaping (`o'brien`). (Rust list) — S each
7. spawn_blocking for image normalize; warn! on swallowed panel/search errors; delete dead
   count_admins; icon manualChunks bucketing (1750 files → ~15). — S

## Security notes (both LOW, non-exploitable)
- Auto-inline FK matching is by table NAME only — cross-schema/source data-confusion possible;
  qualify FK targets with (schema, source). (security #1)
- apply_setup allows the same table in two plan groups (duplicate stems, undefined precedence);
  add a HashSet check mirroring plan_slugs. (security #2)
- Numeric >16 significant digits: revert 409s permanently (safe direction, known).

## Verified-good (don't churn)
Bound params everywhere · path confinement + batch atomicity · view-as fidelity (loses
admin-only endpoints, read-only enforced) · pk-search row_filter on both paths · mock fully
tree-shaken · sx `any` is deliberate ergonomics · j/k+peek+optimistic-edit table UX.
