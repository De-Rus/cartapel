# Contributing to steward

Thanks for your interest! steward is a single Rust binary (axum + sqlx) that
embeds a React/Vite SPA and serves a Postgres admin panel.

## Project layout

- `src/` — the Rust server (routing, auth, introspection, CRUD, config loader).
- `ui/` — the React + TypeScript SPA, built by Vite and embedded into the binary
  via `rust-embed` (`ui/dist/`).
- `demo/` — a self-contained example dataset (`seed.sql`) and config bundle
  (`admin/`), used by `docker compose up` and the tests.
- `docs/` — the VitePress documentation site.

## Build & run

The SPA is compiled once and embedded, so you build the UI first:

```bash
cd ui && pnpm install && pnpm build && cd ..   # produces ui/dist/, required to compile
cargo build --release                           # → target/release/steward
```

Fastest way to see it running with data:

```bash
docker compose up      # → http://localhost:8686/admin  (admin / admin)
```

## Before opening a PR

CI runs these and fails on any of them, so run them locally first:

```bash
# Rust
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked          # needs ui/dist/ to exist (build the UI first)

# Frontend
cd ui && pnpm test           # vitest
```

## Guidelines

- Keep changes focused; one logical change per PR.
- Match the surrounding code style. The codebase favors **self-explanatory code
  with minimal comments** — add a comment only for a genuinely non-obvious *why*
  (an invariant, a race, a workaround), not to restate what the code does.
- When you touch behavior, add or update a test.
- If a change affects how steward is configured or run, update `docs/` in the
  same PR.

## Reporting bugs / requesting features

Open an issue with enough detail to reproduce (version/commit, config shape,
steps). For security issues, follow [SECURITY.md](SECURITY.md) instead.
