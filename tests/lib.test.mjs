import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendOutputs, fetchOk, pinnedReferences, readJson, writeJson } from "../.github/scripts/lib.mjs";

function scratch() {
  return mkdtempSync(join(tmpdir(), "images-lib-"));
}

test("writeJson writes two-space JSON with a final newline and readJson reads it back", () => {
  const dir = scratch();
  try {
    const file = join(dir, "v.json");
    const value = { a: 1, nested: { list: ["x", "y"] }, empty: [] };
    writeJson(file, value);
    assert.equal(readFileSync(file, "utf8"), JSON.stringify(value, null, 2) + "\n");
    assert.deepEqual(readJson(file), value);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readJson rejects a missing file and invalid JSON", () => {
  const dir = scratch();
  try {
    assert.throws(() => readJson(join(dir, "none.json")), { code: "ENOENT" });
    const file = join(dir, "bad.json");
    writeFileSync(file, "{nope");
    assert.throws(() => readJson(file), SyntaxError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendOutputs appends name=value lines and is a no-op without an output file", () => {
  const dir = scratch();
  try {
    const file = join(dir, "out");
    writeFileSync(file, "keep=1\n");
    assert.equal(appendOutputs(file, { changed: true, date: "2026-01-02", table: "a\\nb" }), true);
    assert.equal(readFileSync(file, "utf8"), "keep=1\nchanged=true\ndate=2026-01-02\ntable=a\\nb\n");
    assert.equal(appendOutputs(undefined, { changed: true }), false);
    assert.equal(appendOutputs("", { changed: true }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchOk returns 2xx answers and throws with the default or a custom message otherwise", async () => {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push(request.headers.accept);
    if (request.url === "/ok") {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("fine");
    } else {
      response.writeHead(503);
      response.end("down");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const ok = await fetchOk(base + "/ok", { headers: { Accept: "text/plain" } });
    assert.equal(await ok.text(), "fine");
    assert.equal(seen[0], "text/plain");
    await assert.rejects(fetchOk(base + "/bad"), { message: base + "/bad returned HTTP 503" });
    await assert.rejects(
      fetchOk(base + "/bad", {}, (url, response) => `Docker Hub ${url} → ${response.status}`),
      { message: `Docker Hub ${base}/bad → 503` },
    );
  } finally {
    server.close();
  }
});

test("pinnedReferences names the published and the upstream pin of an entry", () => {
  const valkey = { image: "valkey/valkey", publishedImage: "ghcr.io/orbden/valkey", tagPattern: "{version}-alpine", version: "9", digest: "sha256:a" };
  assert.deepEqual(pinnedReferences(valkey, valkey), [
    "ghcr.io/orbden/valkey:9@sha256:a",
    "valkey/valkey:9-alpine@sha256:a",
  ]);
  const mariadb = { image: "mariadb", publishedImage: "ghcr.io/orbden/mariadb", tagPattern: "{version}" };
  assert.deepEqual(pinnedReferences(mariadb, { version: "11.4", digest: "sha256:b" }), [
    "ghcr.io/orbden/mariadb:11.4@sha256:b",
    "mariadb:11.4@sha256:b",
  ]);
  const bare = { image: "x/y", publishedImage: "ghcr.io/orbden/y" };
  assert.deepEqual(pinnedReferences(bare, { version: "1", digest: "sha256:c" })[1], "x/y:1@sha256:c");
});
