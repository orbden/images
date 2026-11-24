# Site recovery runbook

This is an operator checklist for restoring a site to a separate environment.
It is not an automated restore feature. The precise archive format, site
provisioning, routing switch and rollback depend on the backup system and the
OrbDen deployment; confirm those procedures for the affected installation.
The commands below illustrate restoring **plain SQL dumps** into an already
provisioned, empty database. Do not run them against a live database.

## 1. Identify and preserve

- Identify the site, incident time, desired recovery point and acceptable data
  loss. Stop scheduled jobs and writes before taking the final recovery point;
  retain a separate copy of the current data and configuration for rollback.
- Select a matching set of database dump, site files (including uploads and
  private files), application configuration and secrets. Record archive time,
  source, database name and engine/major version, PHP runtime, image digests,
  site root, ownership and required extensions. Confirm the backup includes
  everything the application needs and verify checksums against trusted backup
  metadata. Do not put secrets in tickets or logs.
- Retain the original archives read-only. Ensure there is enough disk space for
  extraction and database restore. A database dump and site files from different
  times can be inconsistent; choose a consistent set or account for the gap.

## 2. Restore in isolation

1. Provision a separate recovery environment with its own Compose project,
   network, database volumes and site directory. Do not mount production site
   directories or production database volumes. Keep it inaccessible to public
   users, and disable outgoing email, scheduled jobs, webhooks and other side
   effects. Use the original database major line and compatible application,
   PHP and image versions; migration to another major is a separate operation.
2. Verify and extract the site archive into the recovery site directory using
   the backup tool's documented restore procedure. Check that paths are confined
   to that directory and restore the required ownership, permissions and
   symlinks according to the site's deployment contract. Restore configuration
   and secrets through the normal secret-management process.
3. Provision an empty database and a least-privilege user in the recovery
   environment. Database dumps do not necessarily contain users, grants,
   extensions or server settings; provision the ones the application needs.
   Point the recovered application at the recovery database and site directory.
4. For a plain SQL dump, use the appropriate example below from the repository
   root on a Linux host. Replace the variables with the **recovery** project,
   service, database, user and dump path. The recovery Compose files and env
   file must already exist and use isolated volumes and paths. Provision
   credentials beforehand; for MariaDB provide authentication securely inside
   the recovery container (for example with a protected client option file).
   Do not place a password in the command line. PostgreSQL authentication must
   likewise be configured for the recovery container. Stop on any error.

```bash
# These are placeholders, not production defaults.
project=recovery-project
service=recovery-database-service
user=recovery-user
database=recovery-database
dump=/secure/path/site.sql

# Choose one command, matching the dump's database engine.
docker compose -p "$project" --env-file /secure/path/recovery.env \
  -f /secure/path/recovery-compose.yml exec -T "$service" \
  mariadb --user="$user" "$database" < "$dump"

docker compose -p "$project" --env-file /secure/path/recovery.env \
  -f /secure/path/recovery-compose.yml exec -T "$service" \
  psql -X -v ON_ERROR_STOP=1 --username="$user" --dbname="$database" < "$dump"
```

For compressed, custom-format or physical backups, use the matching backup
system's restore tool and instructions instead. Review the archive's origin:
restoring a SQL dump executes its contents.

## 3. Verify before switching

- Check the restore command completed without errors, expected tables and data
  exist, file ownership and permissions are correct, and the recovered site
  connects to the recovery database. Compare representative content and uploads
  with the recovery point; inspect application and service logs.
- Exercise the site's relevant paths on a private test hostname: login, pages,
  media, a controlled write and any essential integrations. Prevent test
  messages or real external transactions. A container healthcheck alone only
  proves liveness, not that the site or its data is ready.
- Decide how to reconcile writes since the backup. Keep production writes paused
  during the final restore and cutover, or use a separately verified catch-up
  procedure. Record the agreed recovery point and any accepted data loss.

## 4. Cut over and keep a rollback path

Use the installation's documented OrbDen routing and deployment procedure to
switch the site to the validated files, database and compatible runtime. Record
the old and new paths, database endpoints, configuration and image digests;
retain the previous environment unchanged until the recovery is accepted.
Re-enable jobs and external integrations deliberately, then check the real
site and logs. If validation fails, pause writes and follow the deployment's
rollback procedure to the retained environment; reconcile any writes made after
cutover before changing back. Do not assume an old database image can safely
open data modified by a newer major version.

## Local rehearsal and limits

`RUN_BACKUP_TESTS=1 node --test tests/backup-restore.test.mjs` starts isolated
MariaDB 11 and PostgreSQL 18 services, creates sample tables, dumps them and
restores them into separate fresh volumes. In PowerShell use
`$env:RUN_BACKUP_TESTS="1"; node --test tests/backup-restore.test.mjs`.
The test cleans up its own projects and volumes. It does not validate an actual
site backup, file restore, credentials, routing, major-version migration or
production rollback. Rehearse the real procedure separately before relying on it.
