// Static checks for the workflows and the local composite actions they use.
// The workflows cannot be run here, so these pin what must not drift: the
// narrow `permissions` blocks, that every local action exists and has a
// checkout before it, and that action inputs never reach a shell unescaped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(dirname(fileURLToPath(import.meta.url)));
const workflowsDir = join(directory, ".github/workflows");
const actionsDir = join(directory, ".github/actions");
const read = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const workflows = readdirSync(workflowsDir)
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({ name, text: read(join(workflowsDir, name)) }));
const actions = readdirSync(actionsDir).map((name) => ({
  name,
  file: join(actionsDir, name, "action.yml"),
}));

/** Top-level `permissions:` block: lines up to the next unindented key. */
function topPermissions(text) {
  const match = text.match(/^permissions:\n((?:  .*\n)+)/m);
  return match ? match[1].trimEnd().split("\n").map((line) => line.trim()) : null;
}

test("workflow permissions stay exactly as narrow as they are", () => {
  const expected = {
    "build-push.yml": ["contents: read", "packages: write", "security-events: write"],
    "update-versions.yml": ["contents: write", "pull-requests: write"],
    "update-cloudflare-ranges.yml": ["contents: write", "pull-requests: write"],
  };
  assert.deepEqual(workflows.map((w) => w.name).sort(), Object.keys(expected).sort());
  for (const { name, text } of workflows) {
    assert.deepEqual(topPermissions(text), expected[name], name);
    // A job-level block would silently replace the workflow-level one.
    assert.equal(/^    permissions:/m.test(text), false, name + " has a job-level permissions block");
  }
});

test("composite actions declare no permissions and every local `uses` resolves", () => {
  for (const { name, file } of actions) {
    assert.ok(existsSync(file), name + " has no action.yml");
    const text = read(file);
    assert.match(text, /^runs:\n  using: composite$/m, name);
    assert.equal(/permissions:/.test(text.replace(/^#.*$/gm, "")), false, name);
  }
  for (const { name, text } of [...workflows, ...actions.map((a) => ({ name: a.name, text: read(a.file) }))]) {
    for (const [, action] of text.matchAll(/uses: \.\/\.github\/actions\/([\w-]+)/g)) {
      assert.ok(actions.some((a) => a.name === action), `${name} uses missing action ${action}`);
    }
  }
});

test("a job that uses a local action checks the repository out first", () => {
  for (const { name, text } of workflows) {
    const jobs = text.split(/^  (?=[\w-]+:\n)/m).slice(1);
    for (const job of jobs) {
      const local = job.search(/uses: \.\/\.github\/actions\//);
      if (local === -1) continue;
      const checkout = job.search(/uses: actions\/checkout@/);
      assert.ok(checkout !== -1 && checkout < local, `${name}: ${job.split("\n")[0]} needs a checkout before its local action`);
    }
  }
});

test("action inputs are passed to shell steps through env, never interpolated", () => {
  for (const { name, file } of actions) {
    const text = read(file);
    for (const [, script] of text.matchAll(/^\s+run: [|>]?-?\n?((?:\s{8,}.*\n?)+)/gm)) {
      assert.equal(/\$\{\{/.test(script), false, `${name}: expression inside a run script`);
    }
  }
});

test("no tabs in workflow or action files", () => {
  for (const { name, text } of workflows) assert.equal(text.includes("\t"), false, name);
  for (const { name, file } of actions) assert.equal(read(file).includes("\t"), false, name);
});
