import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const digest = (char) => `sha256:${char.repeat(64)}`;
const platforms = ["amd64", "arm64"].map((architecture, i) => ({ os: "linux", architecture, digest: digest(i ? "b" : "a") }));
const tag = (name, images = platforms) => ({ name, images, digest: digest("c") });

function runVersionCheck({ version = "1.2.0", tags = [], dryRun = false, status = 200 }, check) {
  const temp = mkdtempSync(join(tmpdir(), "docker-versions-test-"));
  try {
    mkdirSync(join(temp, ".github/scripts"), { recursive: true });
    mkdirSync(join(temp, "stack"));
    for (const name of ["lib.mjs", "check-docker-versions.mjs"]) copyFileSync(join(root, ".github/scripts", name), join(temp, ".github/scripts", name));
    const cfg = { image: "example/demo", publishedImage: "ghcr.io/example/demo", tagPattern: "v{version}-alpine", version, digest: digest("d") };
    const original = JSON.stringify({ images: { demo: cfg } }, null, 2) + "\n";
    writeFileSync(join(temp, "versions.json"), original);
    const oldRef = `${cfg.image}:v${version}-alpine@${cfg.digest}`;
    const compose = join(temp, "stack/docker-compose.v2.yml");
    writeFileSync(compose, `image: ${oldRef}\n`);
    const output = join(temp, "output");
    writeFileSync(output, "");
    const mock = join(temp, "mock.mjs");
    writeFileSync(mock, `globalThis.fetch = async () => new Response(JSON.stringify({results: JSON.parse(process.env.TEST_TAGS)}), {status: Number(process.env.TEST_STATUS), headers: {'content-type':'application/json'}});`);
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(mock).href, join(temp, ".github/scripts/check-docker-versions.mjs")], { encoding: "utf8", env: { ...process.env, TEST_TAGS: JSON.stringify(tags), TEST_STATUS: String(status), DRY_RUN: String(dryRun), GITHUB_OUTPUT: output } });
    check({ result, versions: JSON.parse(readFileSync(join(temp, "versions.json"), "utf8")), original, raw: readFileSync(join(temp, "versions.json"), "utf8"), compose: readFileSync(compose, "utf8"), output: readFileSync(output, "utf8"), oldRef });
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

test("Docker versions use the newest compatible stable multi-platform tag and report newer majors", () => {
  runVersionCheck({ tags: [tag("v2.0.0-alpine"), tag("v1.2.10-alpine"), tag("v1.2.9-alpine"), tag("v1.2.20-alpine", [platforms[0]]), tag("v1.2.30-beta-alpine"), tag("v1.2.40"), tag("v1.3.0-alpine")] }, ({ result, versions, compose, output }) => {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(versions.images.demo.version, "1.2.10");
    assert.equal(versions.images.demo.digest, digest("c"));
    assert.deepEqual(versions.images.demo.platformDigests, { "linux/amd64": digest("a"), "linux/arm64": digest("b") });
    assert.ok(compose.includes(`example/demo:v1.2.10-alpine@${digest("c")}`));
    assert.match(output, /changed=true/);
    assert.match(output, /2\.0\.0/);
  });
});

test("Docker versions preserve major-only pin precision and dry-run leaves files untouched", () => {
  runVersionCheck({ version: "1", dryRun: true, tags: [tag("v1.8.2-alpine"), tag("v2.0.0-alpine")] }, ({ result, raw, original, compose, oldRef, output }) => {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(raw, original);
    assert.ok(compose.includes(oldRef));
    assert.match(output, /changed=true/);
    assert.match(output, /2\.0\.0/);
  });
  runVersionCheck({ version: "1", tags: [tag("v1.8.2-alpine")] }, ({ versions }) => {
    assert.equal(versions.images.demo.version, "1");
    assert.equal(versions.images.demo.resolvedVersion, "1.8.2");
  });
});

test("Docker versions do not modify pins when no suitable tag exists or Docker Hub fails", () => {
  for (const scenario of [{ tags: [tag("v1.3.0-alpine"), tag("v1.2.5-alpine", [platforms[0]])] }, { status: 503 }]) {
    runVersionCheck(scenario, ({ result, raw, original, compose, oldRef, output }) => {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(raw, original);
      assert.ok(compose.includes(oldRef));
      assert.match(output, /changed=false/);
      if (scenario.status) assert.match(result.stdout, /ERROR:.*503/);
    });
  }
});
