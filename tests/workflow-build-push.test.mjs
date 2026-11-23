// Static checks for build-push.yml and its tag/scan composite actions.
// See workflows.test.mjs for the checks shared by every workflow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(dirname(fileURLToPath(import.meta.url)));
const workflowsDir = join(directory, ".github/workflows");
const actionsDir = join(directory, ".github/actions");
const read = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const workflows = readdirSync(workflowsDir)
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({ name, text: read(join(workflowsDir, name)) }));

test("tag lists come from docker/metadata-action without implicit latest tags", () => {
  const buildPush = workflows.find((w) => w.name === "build-push.yml").text;
  assert.equal(/Compute tags/.test(buildPush), false);
  const retag = read(join(actionsDir, "retag-image/action.yml"));
  assert.match(retag, /docker\/metadata-action@v6/);
  assert.match(retag, /flavor: latest=false/);
  assert.match(buildPush, /docker\/metadata-action@v6[\s\S]*?flavor: latest=false/);
});

test("the re-tag jobs keep their tags, sources and scan names", () => {
  const text = workflows.find((w) => w.name === "build-push.yml").text;
  const job = (name) => text.split(new RegExp(`^  ${name}:\\n`, "m"))[1].split(/^  (?=[\w-]+:\n)/m)[0];
  for (const image of ["valkey", "meilisearch", "node"]) {
    const body = job(image);
    assert.match(body, new RegExp(`image: ${image}\\n`));
    assert.match(body, /type=raw,value=\$\{\{ needs\.versions\.outputs\.\w+ \}\}\n\s+type=raw,value=latest\n/);
    assert.match(body, new RegExp(`name: ${image}\\n`));
  }
  assert.match(job("mariadb"), /enable=\$\{\{ matrix\.runtime\.id == needs\.versions\.outputs\.mariadb_default \}\}/);
  assert.match(job("mariadb"), /name: mariadb-\$\{\{ matrix\.runtime\.id \}\}/);
  assert.match(job("postgres"), /enable=\$\{\{ matrix\.runtime\.id == needs\.versions\.outputs\.postgres_default \}\}/);
  assert.match(job("postgres"), /name: postgres-\$\{\{ matrix\.runtime\.id \}\}/);
  assert.match(job("postgres"), /source: postgres:\$\{\{ matrix\.runtime\.version \}\}-alpine@\$\{\{ matrix\.runtime\.digest \}\}/);
  assert.match(job("valkey"), /source: valkey\/valkey:\$\{\{ needs\.versions\.outputs\.valkey \}\}-alpine@/);
  assert.match(job("meilisearch"), /source: getmeili\/meilisearch:v\$\{\{/);
  assert.match(job("node"), /source: node:\$\{\{ needs\.versions\.outputs\.node \}\}-bookworm-slim@\$\{\{ needs\.versions\.outputs\.node_digest \}\}/);
  assert.match(job("frankenphp-merge"), /name: frankenphp-php\$\{\{ matrix\.php \}\}/);
});

