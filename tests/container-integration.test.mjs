import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const enabled = process.env.RUN_CONTAINER_TESTS === "1";
const { frankenphp } = JSON.parse(readFileSync(join(root, "versions.json"), "utf8")).images;

for (const runtime of frankenphp.runtimes.filter((item) => item.supportStatus === "supported")) {
  test(`build and validate FrankenPHP ${runtime.phpVersion} in a real container`, { skip: enabled ? false : "set RUN_CONTAINER_TESTS=1 to build and run containers", timeout: 1800000 }, () => {
    const image = `wcp-test-frankenphp:${randomUUID()}`;
    const docker = (...args) => spawnSync("docker", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 1800000 });
    const check = (result, description) => assert.equal(result.status, 0, `${description}: ${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`);
    try {
      check(docker("build", "--tag", image, "--build-arg", `FRANKENPHP_VERSION=${frankenphp.baseVersion}`, "--build-arg", `PHP_VERSION=${runtime.phpVersion}`, join(root, "frankenphp")), "build");
      check(docker("run", "--rm", "--network", "none", "--entrypoint", "frankenphp", image, "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"), "Caddy configuration");
      const code = '$required = ["redis", "Zend OPcache", "imagick", "intl", "apcu", "igbinary", "mysqli", "pdo_mysql", "pdo_pgsql"]; foreach ($required as $name) { if (!extension_loaded($name)) { fwrite(STDERR, "Missing extension: $name\\n"); exit(1); } }';
      check(docker("run", "--rm", "--network", "none", "--entrypoint", "php", image, "-r", code), "PHP extensions");
      const wp = docker("run", "--rm", "--network", "none", "--entrypoint", "wp", image, "--version");
      assert.equal(wp.status, 127, `WP-CLI exit status: ${wp.stderr}`);
      assert.match(wp.stderr, /WP-CLI is not installed on this server/);
    } finally {
      docker("image", "rm", image);
    }
  });
}
