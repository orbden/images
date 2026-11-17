import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, appendFileSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const directory = dirname(fileURLToPath(import.meta.url));

// The "Detect changed images" step of build-push.yml, taken from the workflow
// text so the test runs the exact script CI runs.
function detectScript() {
  const lines = readFileSync(join(directory, ".github/workflows/build-push.yml"), "utf8").split("\n");
  const id = lines.findIndex((line) => /^\s+id: changes\s*$/.test(line));
  const run = lines.findIndex((line, index) => index > id && /^\s+run: \|\s*$/.test(line));
  assert.ok(id > 0 && run > id, "Detect changed images step not found");
  const indent = lines[run + 1].match(/^\s*/)[0].length;
  const body = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== "" && line.match(/^\s*/)[0].length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

const git = (cwd, ...args) => {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const editVersions = (repo, edit) => {
  const file = join(repo, "versions.json");
  const data = JSON.parse(readFileSync(file, "utf8"));
  edit(data.images);
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
};

// Commits `change` on top of the current versions.json and files, then reports
// which images the workflow step considers changed.
function changedAfter(change) {
  const repo = mkdtempSync(join(tmpdir(), "images-detect-"));
  try {
    cpSync(join(directory, "versions.json"), join(repo, "versions.json"));
    cpSync(join(directory, "frankenphp"), join(repo, "frankenphp"), { recursive: true });
    git(repo, "init", "-q");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    const base = git(repo, "rev-parse", "HEAD");
    change(repo);
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "change");
    const output = join(repo, "github-output.txt");
    writeFileSync(output, "");
    const result = spawnSync("bash", ["-c", detectScript()], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, EVENT_NAME: "push", BASE_SHA: base, GITHUB_OUTPUT: output },
    });
    assert.equal(result.status, 0, result.stderr);
    return Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map((line) => line.split("=")));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}
const none = { frankenphp: "false", mariadb: "false", valkey: "false", postgres: "false", meilisearch: "false" };

test("a compose or documentation change in frankenphp rebuilds nothing", () => {
  assert.deepEqual(changedAfter((repo) => appendFileSync(join(repo, "frankenphp/docker-compose.yml"), "# note\n")), none);
  assert.deepEqual(changedAfter((repo) => writeFileSync(join(repo, "frankenphp/README.md"), "notes\n")), none);
});

test("a file that goes into the frankenphp image rebuilds frankenphp only", () => {
  assert.deepEqual(changedAfter((repo) => appendFileSync(join(repo, "frankenphp/Dockerfile"), "# note\n")), { ...none, frankenphp: "true" });
});

test("recorded digests are build outputs: a digest-only change rebuilds nothing", () => {
  assert.deepEqual(changedAfter((repo) => editVersions(repo, (images) => {
    images.frankenphp.runtimes[0].digest = "sha256:" + "0".repeat(64);
    images.frankenphp.runtimes[0].platformDigests = {};
  })), none);
});

test("a changed frankenphp version or runtime rebuilds frankenphp", () => {
  assert.deepEqual(changedAfter((repo) => editVersions(repo, (images) => { images.frankenphp.baseVersion = "9.9.9"; })), { ...none, frankenphp: "true" });
});

test("a changed pin of a re-tagged service re-tags that service only", () => {
  assert.deepEqual(changedAfter((repo) => editVersions(repo, (images) => { images.meilisearch.version = "9.9.9"; })), { ...none, meilisearch: "true" });
});
