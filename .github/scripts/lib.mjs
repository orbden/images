/** Small helpers shared by the scripts in this directory. */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

/** Parses the JSON file at `path`. */
export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Writes `value` as JSON with two-space indentation and a final newline. */
export function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/**
 * `fetch` that throws on a non-2xx answer. `describeFailure(url, response)`
 * builds the error message; the default names the URL and the HTTP status.
 */
export async function fetchOk(
  url,
  init,
  describeFailure = (target, response) => target + " returned HTTP " + response.status,
) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(describeFailure(url, response));
  return response;
}

/**
 * Appends `name=value` lines to the GitHub Actions step output file. Returns
 * false (and writes nothing) when the file is not set, e.g. a local run.
 */
export function appendOutputs(outputFile, outputs) {
  if (!outputFile) return false;
  appendFileSync(outputFile, Object.entries(outputs).map(([name, value]) => name + "=" + value + "\n").join(""));
  return true;
}
