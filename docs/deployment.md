# Deployment

steward is a single self-contained binary — the SPA is embedded, there is no Node
runtime, and its only external dependency is your Postgres. Deploy it as a bare
binary, a container, or behind a reverse proxy at a sub-path.

## The pieces

A running steward needs:

1. **The binary** (or Docker image).
2. **A Postgres URL** — via `--db`, `STEWARD_DB`, or the primary `source`'s
   `url` in `config/steward.hcl`.
3. **A secret key** — via `STEWARD_SECRET_KEY` or `[steward].secret_key`.
   Required.
4. **A config directory** — optional, but without it no tables are exposed.
5. **A data directory** — steward's own SQLite state (users, sessions, audit,
   config history). Defaults to `./steward-data`; put it on durable storage.

## Docker

```bash
docker run -d --name steward -p 8686:8686 \
  -e STEWARD_DB="postgres://user:pass@db:5432/app" \
  -e STEWARD_SECRET_KEY="a-long-random-secret" \
  -e STEWARD_ADMIN_EMAIL="you@example.com" \
  -e STEWARD_ADMIN_PASSWORD="change-me" \
  -v "$PWD/admin:/config:ro" \
  -v "steward-data:/data" \
  ghcr.io/de-rus/steward:latest \
  serve --config /config --data /data --schema public --listen 0.0.0.0:8686
```

- Mount your config bundle at `/config`. Read-only (`:ro`) bakes it in; a
  writable mount enables live editing (see below).
- Mount a named volume at `/data` so users, sessions and audit survive restarts.
- Bind to `0.0.0.0` inside the container so the published port is reachable.

## Deploy to Fly.io + Supabase

The repo ships a [`fly.toml`](https://github.com/De-Rus/steward/blob/main/fly.toml)
that builds the image from the `Dockerfile` and runs the bundled Acme demo. To
run it — swap in your own config and database as you go.

1. **Database — Supabase.** Create a free project and copy its **Transaction
   pooler** connection string (host ends in `…pooler.supabase.com`, port
   `6543`). steward auto-detects that pooler and disables the prepared-statement
   cache for it (see [below](#connection-pooling-note)).

2. **App — Fly.** Pick an app name in `fly.toml` (`app = "…"`), then:

   ```bash
   fly apps create your-steward
   fly secrets set \
     STEWARD_DB="postgresql://postgres.__ref__:PASSWORD@aws-0-…pooler.supabase.com:6543/postgres" \
     STEWARD_SECRET_KEY="$(openssl rand -hex 32)" \
     STEWARD_ADMIN_EMAIL="you@example.com" \
     STEWARD_ADMIN_PASSWORD="a-strong-password"
   fly deploy
   ```

Secrets are set with `fly secrets set` and **never** committed to `fly.toml`.
The `[env]` block there carries only non-secrets (`STEWARD_CONFIG`,
`STEWARD_BASE_PATH`, `STEWARD_LISTEN`, `STEWARD_SECURE_COOKIES`). To serve your
**own** admin instead of the demo, point `STEWARD_CONFIG` at your bundle (bake it
into the image or mount a volume) rather than `/demo/admin`.

steward's SQLite state lives on the machine's ephemeral disk here; the admin user
re-bootstraps from `STEWARD_ADMIN_*` on each fresh machine. Mount a Fly volume at
`/data` (and set `STEWARD_DATA=/data`) if you want sessions and the audit log to
survive redeploys.

## Environment-first configuration

Every `serve` flag has an environment variable, so a container needs no CLI args
beyond the subcommand. See the [CLI reference](/cli) for the full table. The
essentials:

| Variable | Purpose |
| --- | --- |
| `STEWARD_DB` | Postgres URL. |
| `STEWARD_SECRET_KEY` | Cookie-signing secret. **Required.** |
| `STEWARD_CONFIG` | Config directory. |
| `STEWARD_DATA` | State directory. |
| `STEWARD_BASE_PATH` | URL prefix the panel is served under. Defaults to `/admin`; set `''` (or `/`) for the domain root, or any prefix like `/panel`. |
| `STEWARD_LISTEN` | Bind address. |
| `STEWARD_SECURE_COOKIES` | `true` behind HTTPS (default); `false` for local HTTP. |
| `STEWARD_WEBHOOK_SECRET` | Signs outbound webhook actions. |

Config values themselves can read the environment with `env:NAME` / `${NAME}`, so
you can keep the DB URL and secret in `config/steward.hcl` while still sourcing
them from the environment.

## Writable config volume

steward can edit its own config through the in-app visual builder, but only when
the config directory is **writable**. It probes this at startup:

- **Read-only bundle** (baked into the image, `:ro` mount): the builder is
  read-only. Config PUTs don't write; the UI tells the user to commit the file to
  the repo instead. This is the GitOps-style deployment.
- **Writable volume**: the builder writes changes back to disk (atomically) and
  every change is versioned in the SQLite state (history + rollback). Edits
  persist across restarts because the files live on the mounted volume.

A common pattern is a writable config volume with a **seed-if-empty** entrypoint:
copy a baked-in default bundle into the volume on first boot, then let admins
evolve it live.

## Base path and mounting

The panel is served under **`/admin`** by default. The mount prefix is **injected
into the SPA at runtime** (the server rewrites `index.html` at serve time), so a
single build/image serves under any path — you never rebuild to change it:

```bash
# same published image, three different mount points
docker run … ghcr.io/de-rus/steward serve                     # → /admin (default)
docker run … -e STEWARD_BASE_PATH="" ghcr.io/de-rus/steward serve       # → /  (root)
docker run … -e STEWARD_BASE_PATH=/panel ghcr.io/de-rus/steward serve   # → /panel
```

That's what lets you pull `ghcr.io/de-rus/steward` and mount it wherever your
setup wants — no fork, no custom build. `GET /` redirects to the mount path.

### Behind a reverse proxy

To serve steward under a sub-path (e.g. `https://app.example.com/panel`), set
`STEWARD_BASE_PATH=/panel` and proxy that prefix. steward serves everything — the
SPA, the API under `{base}/api`, and static assets under `{base}/static` —
beneath it (plus the hashed bundle at `/assets/…` from the root). An nginx
location proxying to steward on `:8686`:

```nginx
location /panel/ {
    proxy_pass         http://127.0.0.1:8686;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Forwarded-For   $remote_addr;
    proxy_set_header   X-Forwarded-Proto $scheme;
}
location /assets/ {   # the hashed SPA bundle is served from the root
    proxy_pass         http://127.0.0.1:8686;
}
```

Keep `--secure-cookies` on (the default) when the proxy terminates HTTPS.

## Health checks

`{base}/api/health` returns `{"ok": true}` unauthenticated — point your load
balancer or orchestrator's liveness probe at it.

## Connection pooling note

steward keeps a small Postgres pool and sets a per-connection statement timeout.
If you sit it behind a **transaction-mode** pooler (like Supabase's pgbouncer on
port `6543`), steward auto-detects it and disables the prepared-statement cache
(which such poolers drop between transactions). Force this with
`STEWARD_DB_TX_POOL=1` if you use a non-standard port. The session-mode pooler
(port `5432`) needs no special handling.
