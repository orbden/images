import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { downloads } = JSON.parse(readFileSync(new URL("../versions.json", import.meta.url), "utf8"));

// Each pinned archive is an HTTPS file with a lowercase SHA-256 hex digest: the
// panel sends both to the engine, which refuses anything else.
test("every pinned download has an https URL and a SHA-256", () => {
  assert.ok(Object.keys(downloads).length > 0);
  for (const [name, entry] of Object.entries(downloads)) {
    assert.match(entry.url, /^https:\/\/[a-z0-9.-]+\/[\x21-\x7e]+$/, name);
    assert.ok(!/[?#@\\]/.test(entry.url), name);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, name);
    assert.match(entry.version, /^\d+\.\d+\.\d+$/, name);
  }
});
