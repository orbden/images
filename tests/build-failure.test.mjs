import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("an interrupted image preparation retains only successful results in the root manifest", () => {
  const temp = mkdtempSync(join(tmpdir(), "images-partial-build-"));
  try {
    mkdirSync(join(temp, "scripts"));
    copyFileSync(join(root, "scripts/build.mjs"), join(temp, "scripts/build.mjs"));
    copyFileSync(join(root, "versions.json"), join(temp, "versions.json"));
    const log = join(temp, "commands.jsonl");
    const mock = join(temp, "mock.mjs");
    writeFileSync(mock, `import child from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; import {appendFileSync} from 'node:fs'; child.spawnSync = (command, args) => { appendFileSync(process.env.TEST_LOG, JSON.stringify([command, ...args]) + '\\n'); return {status: args[0] === 'image' || (args[0] === 'pull' && args.at(-1).startsWith('getmeili/')) ? 1 : 0, stdout: ''}; }; syncBuiltinESMExports();`);
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(mock).href, join(temp, "scripts/build.mjs"), "valkey", "meilisearch"], { cwd: tmpdir(), encoding: "utf8", env: { ...process.env, TEST_LOG: log } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /docker failed \(exit 1\)/);
    const manifest = JSON.parse(readFileSync(join(temp, "built-images.json"), "utf8"));
    assert.deepEqual(Object.keys(manifest), ["valkey"]);
    assert.equal(manifest.valkey.official, true);
    assert.match(manifest.valkey.tag, /^valkey\/valkey:/);
    const commands = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(commands.filter((command) => command[1] === "pull").length, 2);
    assert.ok(commands.every((command) => command[0] === "docker"));
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("a failed FrankenPHP build preserves the previously built runtime", () => {
  const temp = mkdtempSync(join(tmpdir(), "images-build-failure-"));
  try {
    mkdirSync(join(temp, "scripts"));
    copyFileSync(join(root, "scripts/build.mjs"), join(temp, "scripts/build.mjs"));
    const images = JSON.parse(readFileSync(join(root, "versions.json"), "utf8"));
    const runtimes = images.images.frankenphp.runtimes.filter((runtime) => runtime.supportStatus === "supported");
    assert.ok(runtimes.length >= 2);
    writeFileSync(join(temp, "versions.json"), JSON.stringify(images));
    const mock = join(temp, "mock.mjs");
    writeFileSync(mock, `import child from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; let builds = 0; child.spawnSync = (command, args) => ({status: args[0] === 'image' ? 1 : ++builds === 2 ? 1 : 0, stdout: ''}); syncBuiltinESMExports();`);
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(mock).href, join(temp, "scripts/build.mjs"), "frankenphp"], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /docker failed \(exit 1\)/);
    const manifest = JSON.parse(readFileSync(join(temp, "built-images.json"), "utf8"));
    assert.deepEqual(Object.keys(manifest), [`frankenphp:${runtimes[0].phpVersion}`]);
    assert.equal(manifest[`frankenphp:${runtimes[0].phpVersion}`].official, false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
