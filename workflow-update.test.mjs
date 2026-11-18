// Static checks for the update-* workflows and the open-update-pr composite action.
// See workflows.test.mjs for the checks shared by every workflow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const workflowsDir = join(directory, ".github/workflows");
const actionsDir = join(directory, ".github/actions");
const read = (path) => readFileSync(path, "utf8");
const workflows = readdirSync(workflowsDir)
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({ name, text: read(join(workflowsDir, name)) }));

test("the update workflows keep one fixed branch per update and no close-superseded script", () => {
  for (const [file, branch] of [
    ["update-versions.yml", "chore/docker-versions"],
    ["update-cloudflare-ranges.yml", "chore/cloudflare-ranges"],
  ]) {
    const text = workflows.find((w) => w.name === file).text;
    assert.match(text, new RegExp(`branch: ${branch}\\n`));
    assert.equal(/actions\/github-script/.test(text), false, file);
    assert.match(text, /uses: \.\/\.github\/actions\/open-update-pr/);
  }
  const action = read(join(actionsDir, "open-update-pr/action.yml"));
  assert.match(action, /peter-evans\/create-pull-request@v8/);
  assert.match(action, /delete-branch: true/);
});

