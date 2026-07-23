# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Report privately via [GitHub's private vulnerability reporting](https://github.com/De-Rus/steward/security/advisories/new)
(Security → Advisories → *Report a vulnerability*). If that is unavailable, open
a minimal issue asking for a private contact channel — without details — and a
maintainer will follow up.

Please include, where possible:

- affected version / commit,
- a description and impact assessment,
- steps to reproduce or a proof of concept.

We aim to acknowledge reports within a few days and to ship a fix or mitigation
as soon as practical, crediting reporters who wish to be named.

## Scope notes

- steward keeps its **own** state (users, sessions, audit log) in a local SQLite
  file and only writes to your Postgres when a panel user edits a row, runs a
  bulk action, or imports data.
- Raw-SQL fragments in the config bundle (`filter_def`, dashboard `panel` SQL,
  named queries) are **trusted, code-reviewed input from your repo** — they are
  not user input. Treat your config directory like source code.
- The signing secret (`STEWARD_SECRET_KEY`) and database URL are required and
  must be supplied via environment/secret, never committed.

For the threat model and hardening guidance, see
[docs/security.md](docs/security.md).
