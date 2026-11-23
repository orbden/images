import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const enabled = process.env.RUN_SERVICE_TESTS === "1";

test("stack services become healthy, accept PHP connections and enforce Valkey authentication", { skip: enabled ? false : "set RUN_SERVICE_TESTS=1 to run real service containers", timeout: 600000 }, () => {
  const project = `wcptest${randomBytes(8).toString("hex")}`;
  const temp = mkdtempSync(join(tmpdir(), "wcp-services-test-"));
  const envFile = join(temp, "test.env");
  const password = `test${randomBytes(12).toString("hex")}`;
  writeFileSync(envFile, `MARIADB_ROOT_PASSWORD=${password}\nMARIADB_PASSWORD=${password}\nMARIADB_USER=testuser\nMARIADB_DATABASE=testdb\nMARIADB_INNODB_BUFFER_POOL_SIZE=128M\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_USER=testuser\nPOSTGRES_DB=testdb\nVALKEY_ADMIN_PASSWORD=${password}\nMEILISEARCH_MASTER_KEY=${password}\nWCP_INGRESS_D=${temp}\nWCP_RUNTIME_D=${temp}\nWCP_WWW_ROOT=${temp}\nWCP_CADDY_LOG=${temp}\n`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(WCP_|MARIADB_|POSTGRES_|VALKEY_|MEILISEARCH_|COMPOSE_)/i.test(key)) delete env[key];
  const docker = (...args) => spawnSync("docker", args, { encoding: "utf8", env, timeout: 540000, maxBuffer: 10 * 1024 * 1024 });
  const compose = (...args) => docker("compose", "--project-name", project, "--profile", "postgres", "--env-file", envFile, "-f", join(root, "stack/docker-compose.v2.yml"), "-f", join(root, "stack/docker-compose.v2.local.yml"), ...args);
  const check = (result, step) => assert.equal(result.status, 0, `${step}: ${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`);
  try {
    check(compose("up", "-d", "--wait", "--wait-timeout", "180", "mariadb-11", "postgres-18", "valkey-9"), "service health checks");
    const unauth = compose("exec", "-T", "valkey-9", "valkey-cli", "-h", "valkey-9", "PING");
    assert.match(unauth.stdout + unauth.stderr, /NOAUTH/i, "Valkey must reject unauthenticated requests");
    const bad = compose("exec", "-T", "valkey-9", "valkey-cli", "-h", "valkey-9", "--user", "wcp_admin", "-a", "incorrect", "PING");
    assert.match(bad.stdout + bad.stderr, /WRONGPASS|NOAUTH/i, "Valkey must reject incorrect credentials");
    const php = join(temp, "test.php");
    writeFileSync(php, `<?php\n$pass = getenv('TEST_PASS');\n$mysql = new PDO('mysql:host=mariadb-11;dbname=testdb', 'testuser', $pass, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);\nif ((int)$mysql->query('SELECT 42')->fetchColumn() !== 42) throw new Exception('MariaDB query failed');\n$pg = new PDO('pgsql:host=postgres-18;dbname=testdb', 'testuser', $pass, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);\nif ((int)$pg->query('SELECT 42')->fetchColumn() !== 42) throw new Exception('PostgreSQL query failed');\n$redis = new Redis();\n$redis->connect('valkey-9', 6379, 5);\nif (!$redis->auth(['wcp_admin', $pass])) throw new Exception('Valkey authentication failed');\nif (!$redis->set('integration-check', 'ok') || $redis->get('integration-check') !== 'ok') throw new Exception('Valkey read/write failed');\n$redis->del('integration-check');\necho "connections passed\\n";\n`);
    // Use the actual published runtime pinned in the stack, not a generic PHP image.
    const base = readFileSync(join(root, "stack/docker-compose.v2.yml"), "utf8");
    const match = base.match(/WCP_FRANKENPHP_IMAGE:-([^}]+)}/);
    assert.ok(match, "default FrankenPHP image pin not found");
    const result = docker("run", "--rm", "--network", `${project}_backend`, "--env", `TEST_PASS=${password}`, "--volume", `${php}:/tmp/wcp-test.php:ro`, "--entrypoint", "php", match[1], "/tmp/wcp-test.php");
    check(result, "PHP connectivity");
    assert.match(result.stdout, /connections passed/);
  } finally {
    const cleanup = compose("down", "--volumes", "--remove-orphans");
    rmSync(temp, { recursive: true, force: true });
    check(cleanup, "temporary Compose project cleanup");
  }
});
