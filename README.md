# images

Custom Docker images for the OrbDen hosting stack — each one is a thin wrapper around an official base image with performance-tuned configuration baked in.

## Images

| Image         | Base                   | Description                                                     |
| ------------- | ---------------------- | --------------------------------------------------------------- |
| `frankenphp`  | `dunglas/frankenphp`   | PHP runtime + Caddy web server, WordPress-tuned                 |
| `mariadb`     | `mariadb`              | MariaDB with performance-tuned `conf.d`                         |
| `valkey`      | `valkey/valkey`        | Redis-compatible object cache                                   |
| `postgres`    | `postgres`             | PostgreSQL (official image, no custom build)                    |
| `meilisearch` | `getmeili/meilisearch` | Lightweight full-text search engine (Elasticsearch alternative) |
| `node`        | `node`                 | Node.js LTS (Debian bookworm), for temporary npm builds and per-application Node servers |

All images are built for `linux/amd64` and `linux/arm64` (Apple Silicon, AWS Graviton, Raspberry Pi).

## Quick start

```bash
cp .env.example .env
# Edit .env — set passwords; stack image versions come from versions.json

node scripts/build.mjs                   # all supported PHP runtimes + data services
node scripts/build.mjs frankenphp:8.3     # build one PHP runtime
node scripts/build.mjs mariadb valkey     # pull pinned official data-service images
node scripts/build.mjs --list             # inspect without building
```

## Running services

Each subdirectory has a `docker-compose.yml` for running a service standalone:

```bash
docker compose -f frankenphp/docker-compose.yml up -d
docker compose -f mariadb/docker-compose.yml up -d
docker compose -f valkey/docker-compose.yml up -d
docker compose -f postgres/docker-compose.yml up -d
```

These join an _external_ `backend` network so several of them can be started
independently and still reach each other. It defaults to `wcp_backend` — the
name `stack/docker-compose.v2.yml` creates under project `wcp` — so starting
one of these alongside an already-running v2 stack lets it join that stack.

Full stack (ingress + PHP-version runtime pools; see
docs/devdocs/runtime-platform/README.md in the OrbDen repo):

```bash
docker compose -p wcp -f stack/docker-compose.v2.yml up -d
```

For CMS-specific deployment checks and current automation boundaries, see
[stack/README.md](stack/README.md).

## PHP and MariaDB lines

FrankenPHP runtimes cover PHP 8.2 to 8.5 (pools `fp1-php82` to `fp1-php85`,
tags `1-php8.2` to `1-php8.5`); the PHP 8.3 pool is the default and the ingress
carrier. PHP 8.2 is on-demand behind the `php-8.2` Compose profile like 8.4 and
8.5. PHP versions that are past their support window are not offered.

MariaDB ships as parallel lines, each with its own service and volume:
`mariadb-11` (11.4 LTS, volume `mariadb_data`) and `mariadb-13` (13.0, volume
`mariadb_13_data`, profile `db-13`). The stack starts one primary line; the
other stays off until its profile is requested. Lines never share a data
directory and nothing migrates data between them.

## PostgreSQL

PostgreSQL ships as parallel major lines, each with its own service and data
volume, with the upstream multi-platform image pinned in `versions.json`:
`postgres-18` (default, volume `postgres_18_data`) and `postgres-19`
(`postgres_19_data`, profile `postgres-19`). Each line mounts its volume at
`/var/lib/postgresql` and sets `PGDATA=/var/lib/postgresql/<major>/docker`.
Lines never share a data directory and nothing migrates data between them. The
standalone `postgres/docker-compose.yml` runs the default line (18).

`node scripts/build.mjs postgres` pulls the exact official upstream image; it does not
try to build a missing Dockerfile. The local stack overlay uses that same pin.
Production Compose uses its GHCR mirror, which the image workflow publishes
from the catalog digest rather than from a mutable upstream tag.

For the per-application FrankenPHP model, Caddy templates, worker policy and
Cloudflare/direct-origin setup, see [frankenphp/README.md](frankenphp/README.md).

## Valkey connections

In the full stack, PHP runtime containers can connect to Valkey through
`/run/valkey/valkey.sock`. The socket is shared through a dedicated volume,
mounted read-only in each runtime. Its mode is `777` because each site process
runs under a dedicated UID/GID without supplementary groups; only containers
with the socket volume mounted can reach it.
Access is controlled by ACL (Valkey 9): the `default` user is off and the only
built-in user is `wcp_admin`, whose password is `VALKEY_ADMIN_PASSWORD` (set in
`.env`; the stack deploy generates it). Each site gets its own user
`site_<domain>` from the operations engine (`valkey.provisionSite`) and its own
numbered database (the panel's DB slot, 1-255): the user can read and write only
that database, may `FLUSHDB` and `SCAN` it, and cannot `SELECT` another one, run
`FLUSHALL`, `KEYS`, `CONFIG` or other administrative commands. Users are kept in
`/data/users.acl` (hashed passwords). Point the application's client at the
socket path with the site's user, password and database number.
OrbDen talks to Valkey with
`docker exec <valkey> sh /etc/valkey/wcp-valkey-cli.sh <command>`, which reads
the administrator password from the container's own environment.

Valkey also listens on port `6379` on the private `backend` network. This keeps
network clients and OrbDen commands working. The standalone Valkey
Compose file uses that network connection; its socket is not shared with
separately started application containers.

Local mode uses locally built FrankenPHP and pinned official data-service
images; prepare them with `node scripts/build.mjs`. Each supported PHP runtime is built
with its own catalog tag. Ingress keeps the PHP 8.3 carrier image; its PHP
version does not select a site runtime. Existing images are reused on the same
platform; `--force` rebuilds them. No additional global builder is created.
WCP_INGRESS_D/WCP_RUNTIME_D/WCP_WWW_ROOT/WCP_CADDY_LOG must point at local
sandbox directories (these
replace the real /etc/wcp/*, /var/www, /var/log/caddy host paths a real
managed server would use). Optional PHP pools use `WCP_RUNTIME_82_D`,
`WCP_RUNTIME_84_D` and `WCP_RUNTIME_85_D` (defaults: `php82`/`php84`/`php85`
below `WCP_RUNTIME_D`).
`WCP_SITE_SERVICES_D` and `WCP_TOOLS_D` default to `site-services` and `tools`
below that same sandbox directory:

```bash
docker compose -p wcp -f stack/docker-compose.v2.yml -f stack/docker-compose.v2.local.yml up -d
```

## Pre-built images (GHCR)

Images are automatically built and pushed to GitHub Container Registry on every push to `main`:

```bash
docker pull ghcr.io/orbden/frankenphp:1-php8.3
docker pull ghcr.io/orbden/mariadb:11.4
docker pull ghcr.io/orbden/mariadb:13.0
docker pull ghcr.io/orbden/postgres:18
docker pull ghcr.io/orbden/postgres:19
docker pull ghcr.io/orbden/valkey:9
docker pull ghcr.io/orbden/meilisearch:1.53.3
docker pull ghcr.io/orbden/node:24
```

## Version management

All image versions live in `versions.json`. A GitHub Actions workflow runs every Monday, checks Docker Hub for new releases, and opens a PR automatically when updates are found.

To check manually:

```bash
node .github/scripts/check-docker-versions.mjs
```

---

## Contributing

We welcome pull requests. Before opening one, please read the guidelines below — they exist to protect the stability of a production system.

### What we accept

- Bug fixes (misconfiguration, broken healthchecks, incorrect defaults)
- Security improvements (hardening, reducing attack surface)
- Performance tuning backed by benchmarks or clear reasoning
- Support for new PHP versions or updated base image tags

### What we do not accept

- Changes that alter the external API of an image (ports, environment variable names, volume paths) — these are consumed by production services and breaking changes cascade
- Restructuring the repo layout or renaming files — this repo is a submodule and path changes break upstream consumers
- Experimental or "nice to have" features without a clear production use case

### Tests

Run `node --test` from the repository root. The suite discovers tests in `tests/`.
The workflow change-detection tests require a POSIX environment with Bash, Git,
and jq; the Docker command mock also requires POSIX. These tests are skipped
when their requirements are unavailable. Run the suite on Linux with those
prerequisites to exercise them. The Compose configuration test additionally
requires the Docker Compose CLI. These checks do not build or start containers.

For an opt-in integration check, run `RUN_CONTAINER_TESTS=1 node --test tests/container-integration.test.mjs` (PowerShell: `$env:RUN_CONTAINER_TESTS="1"; node --test tests/container-integration.test.mjs`). It builds each supported FrankenPHP runtime and validates its Caddy configuration, PHP extensions, and WP-CLI wrapper inside temporary containers. Docker and network access for the build are required; this can take considerable time. Temporary test image tags are removed afterwards. The broader existing `frankenphp/structure-test.yaml` can also be run with container-structure-test.

To test the real stack services, run `RUN_SERVICE_TESTS=1 node --test tests/services-integration.test.mjs` (PowerShell: `$env:RUN_SERVICE_TESTS="1"; node --test tests/services-integration.test.mjs`). It starts MariaDB, PostgreSQL and Valkey in an isolated Compose project, waits for their configured healthchecks, checks Valkey authentication, and connects to all three from the pinned FrankenPHP image. Docker and access to the image registries are required. The test removes its own containers, network and temporary volumes afterwards; no host ports are published.

### How to open a PR

1. Fork the repo and create a branch from `main`
2. Make the smallest change that solves the problem — one concern per PR
3. Run `node --test` and test image changes locally with `node scripts/build.mjs` before pushing
4. Describe in the PR body: what the problem is, what you changed, and how you tested it

PRs that touch production-critical configs (Caddyfile, php.ini, MariaDB tuning) will be reviewed carefully and may take longer. We may ask for evidence (benchmarks, logs) before merging.

If you are unsure whether a change is in scope, open an issue first.
