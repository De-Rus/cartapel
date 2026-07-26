---
description: "Deploy cartapel with Docker, Fly.io, Render one-click, or a bare binary — plus secrets, volumes and pooler notes."
---

# Deployment

cartapel is a single self-contained binary — the SPA is embedded, there is no Node
runtime, and its only external dependency is your Postgres. Pick your path:

- **Trying it out?** → [Render one-click](#one-click-deploy) (free tier, zero setup).
- **Production with durable state?** → [Fly.io](#deploy-to-flyio--supabase) or [Docker](#docker) with volumes.
- **Bare metal?** → [Build from source](#bare-binary-from-source) — releases ship the Docker image only, no prebuilt binaries.

## The pieces

A running cartapel needs:

1. **The binary** (or Docker image).
2. **A Postgres URL** — via `--db`, `CARTAPEL_DB`, or the primary `source`'s
   `url` in `config/cartapel.hcl`.
3. **A secret key** — via `CARTAPEL_SECRET_KEY` or `[cartapel].secret_key`.
   Required.
4. **A config directory** — optional, but without it no tables are exposed.
5. **A data directory** — cartapel's own SQLite state (users, sessions, audit,
   config history). Defaults to `./cartapel-data`; put it on durable storage.


## One-click deploy

**Render** (free tier): [deploy from this repo](https://render.com/deploy?repo=https://github.com/De-Rus/cartapel)
— the blueprint (`render.yaml`) runs the published image, prompts for your
`postgres://` URL and admin credentials, generates the secret key and seeds a
minimal config so you land in the `/_setup` wizard over your own database.
The free filesystem is ephemeral (config edits survive restarts, not
redeploys) — attach a disk at `/data` for durability.

**Fly.io** in two commands, with a durable volume:

```bash
fly launch --image ghcr.io/de-rus/cartapel:latest --no-deploy
fly volumes create cartapel_data --size 1
# add [mounts] source="cartapel_data" destination="/data" to fly.toml, then:
fly secrets set CARTAPEL_DB=postgres://… CARTAPEL_SECRET_KEY=$(openssl rand -hex 32) \
  CARTAPEL_ADMIN_EMAIL=you@example.com CARTAPEL_ADMIN_PASSWORD=change-me
fly deploy
```

## Docker

```bash
docker run -d --name cartapel -p 8686:8686 \
  -e CARTAPEL_DB="postgres://user:pass@db:5432/app" \
  -e CARTAPEL_SECRET_KEY="a-long-random-secret" \
  -e CARTAPEL_ADMIN_EMAIL="you@example.com" \
  -e CARTAPEL_ADMIN_PASSWORD="change-me" \
  -v "$PWD/admin:/config:ro" \
  -v "cartapel-data:/data" \
  ghcr.io/de-rus/cartapel:latest \
  serve --config /config --schema public
```

- Mount your config bundle at `/config`. Read-only (`:ro`) bakes it in; a
  writable mount enables live editing (see below).
- Mount a named volume at `/data` so users, sessions and audit survive restarts.
- The image already binds `0.0.0.0:8686` and stores state at `/data`
  (`CARTAPEL_LISTEN` / `CARTAPEL_DATA` in the `Dockerfile`), so the published
  port is reachable without extra flags.

## Deploy to Fly.io + Supabase

The repo ships a [`fly.toml`](https://github.com/De-Rus/cartapel/blob/main/fly.toml)
that runs the **published image** (pinned to a release tag — bump it to adopt a
new version) with the bundled Acme demo config. To run it — swap in your own
config and database as you go.

1. **Database — Supabase.** Create a free project and copy its **Transaction
   pooler** connection string (host ends in `…pooler.supabase.com`, port
   `6543`). cartapel auto-detects that pooler and disables the prepared-statement
   cache for it (see [below](#connection-pooling-note)).

2. **App — Fly.** Pick an app name in `fly.toml` (`app = "…"`), then:

   ```bash
   fly apps create your-cartapel
   fly secrets set \
     CARTAPEL_DB="postgresql://postgres.__ref__:PASSWORD@aws-0-…pooler.supabase.com:6543/postgres" \
     CARTAPEL_SECRET_KEY="$(openssl rand -hex 32)" \
     CARTAPEL_ADMIN_EMAIL="you@example.com" \
     CARTAPEL_ADMIN_PASSWORD="a-strong-password"
   fly deploy
   ```

Secrets are set with `fly secrets set` and **never** committed to `fly.toml`.
The `[env]` block there carries only non-secrets (`CARTAPEL_CONFIG`,
`CARTAPEL_BASE_PATH`, `CARTAPEL_LISTEN`, `CARTAPEL_SECURE_COOKIES`). To serve your
**own** admin instead of the demo, point `CARTAPEL_CONFIG` at your bundle (bake it
into the image or mount a volume) rather than `/demo/admin`.

cartapel's SQLite state lives on the machine's ephemeral disk here; the admin user
re-bootstraps from `CARTAPEL_ADMIN_*` on each fresh machine. Mount a Fly volume at
`/data` (the image's default `CARTAPEL_DATA`) if you want sessions and the audit
log to survive redeploys.

## Bare binary (from source)

Releases publish the Docker image only — for bare metal, build the binary
yourself. The SPA must be built first because it is embedded at compile time:

```bash
git clone https://github.com/De-Rus/cartapel && cd cartapel
cd ui && pnpm install && pnpm build && cd ..   # SPA, embedded into the binary
cargo build --release                          # → target/release/cartapel
```

Then run it (systemd, supervisor, whatever you use):

```bash
CARTAPEL_DB="postgres://user:pass@localhost:5432/app" \
CARTAPEL_SECRET_KEY="$(openssl rand -hex 32)" \
./target/release/cartapel serve --config ./admin --data /var/lib/cartapel
```

The default bind is `127.0.0.1:8686` — pass `--listen 0.0.0.0:8686` (or put a
reverse proxy in front) to expose it.

## Environment-first configuration

Every `serve` flag has an environment variable, so a container needs no CLI args
beyond the subcommand. The full set, matching `cartapel serve`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CARTAPEL_DB` | — | Postgres URL. Falls back to the primary `source`'s `url` in `config/cartapel.hcl`. |
| `CARTAPEL_SCHEMA` | primary source's `schemas`, else `public` | Postgres schema to introspect. |
| `CARTAPEL_CONFIG` | — | Config directory. Optional — without it, no tables are exposed. |
| `CARTAPEL_DATA` | `./cartapel-data` | State directory (SQLite: users, sessions, audit, config history). |
| `CARTAPEL_BASE_PATH` | `/admin` | URL prefix the panel is served under. Set `''` (or `/`) for the domain root, or any prefix like `/panel`. |
| `CARTAPEL_LISTEN` | `127.0.0.1:8686` | Bind address (`0.0.0.0:8686` in the Docker image). |
| `CARTAPEL_SECURE_COOKIES` | `true` | `Secure` attribute on session cookies. Keep on behind HTTPS; set `false` for local plain HTTP. |
| `CARTAPEL_SECRET_KEY` | — | Cookie-signing secret. **Required** (here or as `[cartapel].secret_key` in config). |
| `CARTAPEL_WEBHOOK_SECRET` | — | Signs outbound webhook actions. |
| `CARTAPEL_DB_TX_POOL` | auto-detect | Set `1` to force transaction-pooler mode (see [below](#connection-pooling-note)). |

First-run bootstrap reads `CARTAPEL_ADMIN_EMAIL` (default `admin@localhost`) /
`CARTAPEL_ADMIN_PASSWORD` (generated and logged when unset) /
`CARTAPEL_ADMIN_ROLE` — the role defaults to `admin`, and a public demo can
bootstrap a restricted role instead. See the [CLI reference](/cli) for the
per-subcommand tables.

Config values themselves can read the environment with `env:NAME` / `${NAME}`, so
you can keep the DB URL and secret in `config/cartapel.hcl` while still sourcing
them from the environment.

## Writable config volume

cartapel can edit its own config through the in-app visual builder, but only when
the config directory is **writable**. It probes this at startup:

- **Read-only bundle** (baked into the image, `:ro` mount): the builder is
  read-only. Config PUTs don't write; the UI tells the user to commit the file to
  the repo instead. This is the GitOps-style deployment.
- **Writable volume**: the builder writes changes back to disk (atomically) and
  every change is versioned in the SQLite state (history + rollback). Edits
  persist across restarts because the files live on the mounted volume.

A common pattern is a writable config volume with a **seed-if-empty** entrypoint:
copy a baked-in default bundle into the volume on first boot, then let admins
evolve it live. That is exactly what the Render blueprint's `dockerCommand`
does — it seeds a one-source `cartapel.hcl` into `/data/admin` if none exists.

## Base path and mounting

The panel is served under **`/admin`** by default. The mount prefix is **injected
into the SPA at runtime** (the server rewrites `index.html` at serve time), so a
single build/image serves under any path — you never rebuild to change it:

```bash
# same published image, three different mount points
docker run … ghcr.io/de-rus/cartapel serve                     # → /admin (default)
docker run … -e CARTAPEL_BASE_PATH="" ghcr.io/de-rus/cartapel serve       # → /  (root)
docker run … -e CARTAPEL_BASE_PATH=/panel ghcr.io/de-rus/cartapel serve   # → /panel
```

That's what lets you pull `ghcr.io/de-rus/cartapel` and mount it wherever your
setup wants — no fork, no custom build. `GET /` redirects to the mount path.

### Behind a reverse proxy

To serve cartapel under a sub-path (e.g. `https://app.example.com/panel`), set
`CARTAPEL_BASE_PATH=/panel` and proxy that prefix. cartapel serves **everything**
beneath it — the SPA, the API under `{base}/api`, static assets under
`{base}/static`, and the hashed SPA bundle under `{base}/assets` — so one
location block covers it all. An nginx location proxying to cartapel on `:8686`:

```nginx
location /panel/ {
    proxy_pass         http://127.0.0.1:8686;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Forwarded-For   $remote_addr;
    proxy_set_header   X-Forwarded-Proto $scheme;
}
```

Keep `--secure-cookies` on (the default) when the proxy terminates HTTPS.

## Health checks

`{base}/api/health` returns `{"ok": true}` unauthenticated — point your load
balancer or orchestrator's liveness probe at it (the Render blueprint uses
`/admin/api/health`).

## Connection pooling note

cartapel keeps a small Postgres pool (5 connections). If you sit it behind a
**transaction-mode** pooler (like Supabase's pgbouncer on port `6543`), cartapel
auto-detects it and disables the prepared-statement cache (which such poolers
drop between transactions). Force this with `CARTAPEL_DB_TX_POOL=1` if you use a
non-standard port. The session-mode pooler (port `5432`) needs no special
handling — on direct/session connections cartapel also sets a per-connection
statement timeout.

::: tip Validate before you ship
`cartapel check --config ./admin --db …` exits non-zero on any parse error or
schema drift — run it in CI next to your migrations. See the [CLI reference](/cli#cartapel-check).
:::
