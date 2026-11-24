import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const enabled = process.env.RUN_BACKUP_TESTS === "1";

test("MariaDB and PostgreSQL logical backups restore into fresh volumes", { skip: enabled ? false : "set RUN_BACKUP_TESTS=1 to run the backup and restore test", timeout: 600000 }, () => {
  const id = randomBytes(8).toString("hex");
  const temp = mkdtempSync(join(tmpdir(), "wcp-backup-test-"));
  const envFile = join(temp, "test.env");
  const password = `test${randomBytes(12).toString("hex")}`;
  writeFileSync(envFile, `MARIADB_ROOT_PASSWORD=${password}\nMARIADB_PASSWORD=${password}\nMARIADB_USER=testuser\nMARIADB_DATABASE=testdb\nMARIADB_INNODB_BUFFER_POOL_SIZE=128M\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_USER=testuser\nPOSTGRES_DB=testdb\nVALKEY_ADMIN_PASSWORD=${password}\nMEILISEARCH_MASTER_KEY=${password}\nWCP_INGRESS_D=${temp}\nWCP_RUNTIME_D=${temp}\nWCP_WWW_ROOT=${temp}\nWCP_CADDY_LOG=${temp}\n`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(WCP_|MARIADB_|POSTGRES_|VALKEY_|MEILISEARCH_|COMPOSE_)/i.test(key)) delete env[key];
  const compose = (project, args, input) => spawnSync("docker", ["compose", "--project-name", project, "--profile", "postgres", "--env-file", envFile, "-f", join(root, "stack/docker-compose.v2.yml"), "-f", join(root, "stack/docker-compose.v2.local.yml"), ...args], { encoding: "utf8", env, input, timeout: 300000, maxBuffer: 10 * 1024 * 1024 });
  const source = `wcpbackupsrc${id}`;
  const target = `wcpbackupdst${id}`;
  const run = (project, args, step, input) => {
    const result = compose(project, args, input);
    assert.equal(result.status, 0, `${step}: ${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const mysql = ["exec", "-T", "-e", `MYSQL_PWD=${password}`, "mariadb-11", "mariadb", "-u", "testuser", "testdb"];
  const pg = ["exec", "-T", "postgres-18", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "testuser", "-d", "testdb"];
  const sql = "CREATE TABLE backup_probe (id INTEGER PRIMARY KEY, value VARCHAR(100) NOT NULL); INSERT INTO backup_probe VALUES (1, 'first'), (2, 'second');";
  try {
    for (const project of [source, target]) run(project, ["up", "-d", "--wait", "--wait-timeout", "180", "mariadb-11", "postgres-18"], "start isolated databases");
    run(source, mysql, "seed MariaDB", sql);
    run(source, pg, "seed PostgreSQL", sql);
    const mariaDump = run(source, ["exec", "-T", "-e", `MYSQL_PWD=${password}`, "mariadb-11", "mariadb-dump", "--single-transaction", "-u", "testuser", "testdb"], "dump MariaDB");
    const pgDump = run(source, ["exec", "-T", "postgres-18", "pg_dump", "-U", "testuser", "-d", "testdb", "--no-owner", "--no-privileges"], "dump PostgreSQL");
    assert.ok(mariaDump.length > 0 && pgDump.length > 0, "backups must not be empty");
    run(target, mysql, "restore MariaDB", mariaDump);
    run(target, pg, "restore PostgreSQL", pgDump);
    const query = "SELECT id, value FROM backup_probe ORDER BY id;";
    const mariaRows = run(target, [...mysql, "--batch", "--skip-column-names"], "verify MariaDB", query).trim();
    const pgRows = run(target, [...pg, "-A", "-t", "-F", "\t"], "verify PostgreSQL", query).trim();
    assert.equal(mariaRows.replaceAll("\r", ""), "1\tfirst\n2\tsecond");
    assert.equal(pgRows.replaceAll("\r", ""), "1\tfirst\n2\tsecond");
  } finally {
    const cleanups = [source, target].map(project => compose(project, ["down", "--volumes", "--remove-orphans"]));
    rmSync(temp, { recursive: true, force: true });
    for (const cleanup of cleanups) assert.equal(cleanup.status, 0, `temporary Compose project cleanup: ${cleanup.error?.message ?? ""}\n${cleanup.stderr}`);
  }
});
