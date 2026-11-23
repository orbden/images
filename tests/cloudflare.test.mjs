import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function fixture(run) {
  const temp = mkdtempSync(join(tmpdir(), "cloudflare-test-"));
  try {
    mkdirSync(join(temp, ".github/scripts"), { recursive: true });
    mkdirSync(join(temp, "frankenphp/caddy-global/trusted-proxies"), { recursive: true });
    for (const file of ["lib.mjs", "update-cloudflare-ranges.mjs"]) {
      copyFileSync(join(root, ".github/scripts", file), join(temp, ".github/scripts", file));
    }
    const preload = join(temp, "mock-fetch.mjs");
    writeFileSync(preload, `globalThis.fetch = async (url) => new Response(url.endsWith('ips-v4') ? process.env.TEST_IPV4 : process.env.TEST_IPV6, {status: Number(process.env.TEST_STATUS || 200)});`);
    const output = join(temp, "output");
    const target = join(temp, "frankenphp/caddy-global/trusted-proxies/cloudflare.caddyfile");
    writeFileSync(output, "");
    const execute = (env = {}) => spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, join(temp, ".github/scripts/update-cloudflare-ranges.mjs")], {
      encoding: "utf8", env: { ...process.env, TEST_IPV4: "192.0.2.0/24\n192.0.2.0/24\n", TEST_IPV6: "2001:db8::/32\n", TEST_STATUS: "200", DRY_RUN: "false", ...env, GITHUB_OUTPUT: output },
    });
    run({ execute, output, target });
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

test("Cloudflare updates deduplicate ranges and report only actual changes", () => fixture(({ execute, output, target }) => {
  let result = execute();
  assert.equal(result.status, 0, result.stderr);
  const content = readFileSync(target, "utf8");
  assert.match(content, /trusted_proxies static \\\n192\.0\.2\.0\/24 \\\n2001:db8::\/32\n/);
  assert.match(content, /trusted_proxies_strict\nclient_ip_headers CF-Connecting-IP X-Forwarded-For/);
  assert.equal(readFileSync(output, "utf8"), "changed=true\n");
  result = execute();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, "utf8"), "changed=true\nchanged=false\n");
}));

test("Cloudflare dry-run reports changes without writing", () => fixture(({ execute, output, target }) => {
  writeFileSync(target, "original\n");
  const result = execute({ DRY_RUN: "true" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(target, "utf8"), "original\n");
  assert.equal(readFileSync(output, "utf8"), "changed=true\n");
}));

test("Cloudflare rejects malformed or empty CIDR lists and HTTP errors without modifying the target", () => fixture(({ execute, output, target }) => {
  writeFileSync(target, "original\n");
  for (const env of [
    { TEST_IPV4: "" }, { TEST_IPV4: "192.0.2.1/" }, { TEST_IPV4: "192.0.2.1/  " },
    { TEST_IPV4: "192.0.2.1/33" }, { TEST_IPV4: "2001:db8::/32" },
    { TEST_IPV6: "2001:db8::/129" }, { TEST_STATUS: "503" },
  ]) {
    const result = execute(env);
    assert.notEqual(result.status, 0, JSON.stringify(env));
    assert.match(result.stderr, /invalid .* CIDR list|HTTP 503/);
    assert.equal(readFileSync(target, "utf8"), "original\n");
    assert.equal(readFileSync(output, "utf8"), "");
  }
}));
