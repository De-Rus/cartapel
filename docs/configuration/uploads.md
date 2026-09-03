---
description: "Uploading files from the panel: the file { } field, widget = image vs. generic files, joins and write-through across tables, the exact upload request, and local-disk or S3-compatible storage."
---

# Uploads & file storage

The [`files` and `s3` sources](/configuration/sources#files-s3-—-a-storage-backend-as-rows)
are **read-only** — they list a storage backend that already has content in
it. Writing a *new* file into storage from the panel is a different, narrower
thing: a column-level `file { }` field, uploaded straight from the list or
the record view, no edit-mode round-trip.

One block covers every upload. The **widget** decides what happens to the
bytes, not the block:

```hcl
field "logo" {
  widget = "image"                              # decode, resize, re-encode to PNG
  params = { max_px = 256, normalize = true }    # both optional; these are the defaults
  file {
    dir      = "products"    # directory the files live in
    name_col = "sku"         # column supplying the stored filename
  }
}
```

`widget = "image"` is what makes this a photo — `max_px`/`normalize` are its
`params`, the same way `params` tunes any other widget. Drop the widget (or
set anything other than `"image"`) and the field stores whatever bytes were
uploaded, untouched — see [A generic file](#a-generic-file) below.

## `file { }` options

| Key | Type | Description |
| --- | --- | --- |
| `dir` | string | **Required.** Directory the files live in, or an S3 key prefix when `storage` is set. |
| `storage` | string | Name of a `storage "…" { }` block. Absent ⇒ local disk. See [Where uploads are stored](#where-uploads-are-stored). |
| `name_col` | string | Real column holding the filename. Exactly one of `name_col` / `name_sql` is required. |
| `name_sql` | string | SQL expression (correlated via `t`) yielding the filename, for a field joined from another table. See [From a related table](#from-a-related-table). |
| `write_to` | string | Table an upload upserts into — makes a `name_sql` field writable. See [Editable across the join](#editable-across-the-join-write-through). |
| `write_key` | map | `target_col = this_row_col` — locates/creates the `write_to` row. Required with `write_to`. |
| `write_defaults` | map | Extra columns set only when `write_to` INSERTs a fresh row. |
| `max_bytes` | number | Upload size cap. Default 25MB, or 8MB when `widget = "image"`. |

A field using every key at once:

```hcl
field "manual" {
  file {
    dir            = "manuals"
    storage        = "uploads"
    name_sql       = "SELECT a.filename FROM assets a WHERE a.sku = t.sku LIMIT 1"
    write_to       = "assets"
    name_col       = "filename"
    write_key      = { sku = "sku" }
    write_defaults = { status = "ok" }
    max_bytes      = 10485760
  }
}
```

The filename lives in a real column (`name_col`); the file itself lives on
disk under `dir`. Uploads are served back through the field's own route
(`GET /t/<table>/file/<col>/<pk>`), under the same read permissions as any
other column — not a public static file server.

::: warning `name_col` must already hold a value — cartapel doesn't invent one
This plain form never writes to `name_col`; it only *reads* it, to know what
filename to save under. So `sku` here is not a filename column by name — it's
whatever **already-populated, never-null** column you reuse as the file's
stem, chosen precisely because it's guaranteed to exist before a first
upload. A fresh, upload-only column (e.g. `logo_filename`, empty until
someone uploads) does **not** work in this form: `name_col` is `NULL`, so
there's nothing to derive a destination from, and the upload fails with
"no file for this row."

If you want a dedicated column that cartapel populates *for* you — no
pre-existing value required — use [write-through](#editable-across-the-join-write-through),
even back onto the same table. See [The hook](#the-hook-how-the-database-finds-out).
:::

## The upload request

Uploading is a plain multipart `POST` to the field's own route, and it is
exactly what the panel's file picker does under the hood — useful to know if
you are scripting an import or wiring a form outside the UI:

```bash
curl -X POST "$CARTAPEL_URL/t/products/file/logo/42" \
  -H "Cookie: $SESSION_COOKIE" \
  -F "file=@./logo.png"
```

- Capped at **8MB** for `widget = "image"`, **25MB** for anything else —
  override per field with `max_bytes` on the `file { }` block.
- `widget = "image"` re-encodes to PNG and resizes to `max_px` on the longest
  edge by default; set `params = { normalize = false }` to store the upload
  byte-for-byte instead.
- **Written atomically** either way — a temp file then a rename on local
  disk, a single `PUT` on S3 — so a failed or interrupted upload never leaves
  a half-written file behind.
- Requires table `update` permission on the field's table; a masked or
  otherwise unreadable column refuses the upload the same as a read.

## From a related table

A file often belongs to a *different* table than the one you're looking at —
a product's logo living in a shared `assets` table, keyed by SKU rather than
by the product row's id. Point `name_sql` at a correlated expression (the
current row is `t`) that yields the filename, and it shows without
denormalising anything:

```hcl
field "logo" {
  widget = "image"
  file {
    name_sql = "SELECT a.filename FROM assets a WHERE a.sku = t.sku LIMIT 1"
    dir      = "logos"
  }
}
```

The field needs no real column of its own — it renders as a virtual column,
served by primary key. With only `name_sql` it is **read-only** (you edit the
file on the table that owns it).

## Editable across the join (write-through)

Add `write_to` to make the joined field uploadable *here* — an upload writes
the file and upserts the target row, like Django's `ImageField`/`FileField`
on a related model:

```hcl
field "logo" {
  widget = "image"
  file {
    name_sql       = "SELECT a.filename FROM assets a WHERE a.sku = t.sku AND a.status = 'ok' LIMIT 1"
    dir            = "logos"
    write_to       = "assets"                    # the table the upload writes to
    name_col       = "filename"                  # its filename column
    write_key      = { sku = "sku" }             # target_col = this row's column
    write_defaults = { status = "ok" }           # extra columns set on a fresh row
  }
}
```

On upload cartapel writes the file (under a deterministic name built from the
`write_key` values, `.png` for `widget = "image"` or the upload's own
extension otherwise) and upserts `write_to`: it UPDATEs the row matched by
`write_key` — setting `name_col` and the `write_defaults` — or INSERTs one if
none exists. The owning table stays the single source of truth; the parent
never keeps a copy. Exactly one of `name_col` / `name_sql` is required, and
`write_to` needs all of `name_sql`, `name_col` and a non-empty `write_key`.

## Where uploads are stored

Two backends, chosen per field. The default needs nothing extra; the other is
a named `storage "…" { }` block a field opts into.

### Local disk (default)

With no `storage` key, a `file { }` field behaves exactly as above: `dir` is
a path cartapel writes to directly, byte-for-byte, on the machine running the
server. Two details that matter once you deploy this behind more than a
laptop:

- **`dir` resolves relative to the server's working directory** — not to
  `--config`, and not to `CARTAPEL_DATA`. A relative `dir` in a container
  means "wherever the process started," which is rarely where you want files
  to persist.
- **Mounting `/data` does not cover uploads.** `CARTAPEL_DATA` (default
  `/data` in the Docker image) holds the SQLite state — users, sessions, the
  audit log — and durability advice for it lives in
  [Deployment](/deployment#docker). Uploaded files are a *separate* path;
  point `dir` inside a mounted volume yourself, or they vanish on the next
  redeploy.

### An S3-compatible bucket

Declare a named storage in `config/cartapel.hcl` — the same file, the same
labeled-block shape `source "…" { }` uses — and point a field at it:

```hcl
# config/cartapel.hcl
storage "uploads" {
  type           = "s3"
  endpoint       = "env:S3_ENDPOINT"            # https://<account>.r2.cloudflarestorage.com
  bucket         = "product-images"
  region         = "auto"                       # what Cloudflare R2 wants; omit for AWS
  access_key_env = "S3_ACCESS_KEY_ID"           # the env var, never the key itself
  secret_key_env = "S3_SECRET_ACCESS_KEY"
}
```

```hcl
field "logo" {
  widget = "image"
  file {
    storage  = "uploads"      # the block above — omit this key for local disk
    dir      = "products"     # an S3 key prefix now, not a filesystem path
    name_col = "sku"
  }
}
```

Nothing else changes: the same route, the same multipart request, the same
size cap and PNG normalization, the same `name_col`/`write_to` behavior.
Reads and writes go through cartapel's own signed request to the bucket — the
browser never talks to S3 directly and never sees a credential. Works against
any S3-compatible endpoint (AWS, R2, MinIO, Backblaze); Cloudflare R2 wants
`region = "auto"`.

`cartapel check` validates a `storage` block the same way it validates
everything else: an unknown `type`, a missing required key, or a
`file { storage = "…" }` naming a block that doesn't exist are load errors,
caught before anything tries to upload.

## A generic file

Drop `widget = "image"` (or set any other widget, including none) and a
`file { }` field stores the upload exactly as sent — no decode, no resize,
no re-encode:

```hcl
field "invoice" {
  file {
    dir       = "invoices"
    name_col  = "invoice_ref"
    max_bytes = 10485760       # 10MB; default 25MB if omitted
  }
}
```

```bash
curl -X POST "$CARTAPEL_URL/t/orders/file/invoice/42" \
  -H "Cookie: $SESSION_COOKIE" \
  -F "file=@./invoice.pdf"
```

- Default cap is **25MB** (higher than the image default of 8MB, since a
  document isn't decoded into memory the way a resize requires).
- The `GET` route sends `Content-Disposition: attachment` with the stored
  filename, so a browser downloads it rather than trying to render it inline.
- On a write-through upload, the generated filename keeps the extension from
  the file you uploaded (sanitised to bare alphanumerics) instead of always
  writing `.png`.
- Everything else — `storage`, `name_sql`/`write_to`, permissions, masking,
  the request shape — is identical to the image case above.

::: info No dedicated panel widget yet
The route works today — script against it, or configure `dir`/`name_col`
from the visual builder's Fields tab. There is no download-link/icon
rendering in the panel itself yet; a plain `file` field falls back to the
default text rendering until that widget is built.
:::

## The hook: how the database finds out

There isn't a separate "on save" callback to configure — `name_col` (or
`write_to`'s upsert, for the joined case above) already **is** the hook, and
it works identically regardless of widget or storage backend. Every
successful upload writes the resolved filename into that real column in the
same request that stores the bytes, so a row and its file are never out of
sync: nothing polls, nothing runs after the fact, there is no window where the
column names a file that failed to write. Switching a field between local
disk and S3, or between `widget = "image"` and a generic file, changes
nothing about this — `name_col` still receives a bare filename, not a path or
a URL, because retrieval always goes back through cartapel's own route
rather than the storage backend directly.

### Want a dedicated, auto-populated column instead of reusing an identifier?

Point `write_to` at the field's **own table** — nothing requires the target
to be a different one. This is the pattern to reach for when you don't have a
stable pre-existing value to key off (the warning above), and want cartapel
to generate the filename and write it into a real column for you, with no
manual bookkeeping:

```hcl
field "logo" {
  widget = "image"
  file {
    name_sql  = "t.logo_filename"   # a plain column reference, read-only side
    dir       = "products"
    write_to  = "products"          # same table — an upload upserts itself
    name_col  = "logo_filename"     # the column that gets written
    write_key = { id = "id" }       # match this row by its own primary key
  }
}
```

The first upload has nowhere to read from (`logo_filename` is `NULL`), which
is fine — write-through never needs to read the old value, only the
`write_key` columns (here, the row's own `id`). After the upload, the row's
`logo_filename` holds the generated name (`42.png`), and every read after
that resolves it the normal way.
