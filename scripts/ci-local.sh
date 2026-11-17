#!/usr/bin/env bash
# Local checks for a pull request, in place of the hosted Test workflow: runs
# `node --test` on this machine, reports it as the commit status `test` on HEAD
# and keeps one result comment on the branch's open pull request (edited in
# place on every run).
#
# Usage: scripts/ci-local.sh [--no-report]
# Needs a clean tree (the result belongs to the commit, not the working copy),
# a pushed HEAD and an authenticated `gh`. Run it after every push.
set -uo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

report=1
[[ "${1:-}" == "--no-report" ]] && report=0

if [[ -n "$(git status --porcelain)" ]]; then
  echo "ci-local: the working tree is not clean; commit or stash first" >&2
  exit 2
fi

sha="$(git rev-parse HEAD)"
repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)"
if [[ $report -eq 1 && -z "$repo" ]]; then
  echo "ci-local: cannot resolve the GitHub repository (gh auth status)" >&2
  exit 2
fi
base_branch=main
versions="node $(node --version)"

post() { # state description
  [[ $report -eq 1 ]] || return 0
  gh api "repos/$repo/statuses/$sha" -f state="$1" -f context="test" \
    -f description="$2" >/dev/null
}

# ── Result reporting (same in every repository) ───────────────────────────────
rows=()
failure_tail=""
log="$(mktemp)"
trap 'rm -f "$log"' EXIT

# step NAME SUMMARY_FN CMD...: runs CMD with its output shown and kept, adds a
# table row with the time and, on success, what SUMMARY_FN prints about the
# output (for example how many tests ran). A failing step keeps the last lines
# of its output for the comment.
step() {
  local name="$1" summary="$2"
  shift 2
  local started=$SECONDS rc=0
  "$@" 2>&1 | tee "$log"
  rc=${PIPESTATUS[0]}
  local took=$((SECONDS - started))
  if [[ $rc -eq 0 ]]; then
    rows+=("| $name | passed | $("$summary") | $took s |")
    echo "ci-local: $name passed"
  else
    rows+=("| $name | **FAILED** | exit $rc | $took s |")
    failure_tail="$(tail -n 25 "$log" | sed 's/\x1b\[[0-9;]*m//g')"
    echo "ci-local: $name FAILED" >&2
  fi
  return $rc
}
none() { :; }

# One comment per pull request, found by its marker and edited in place, so
# repeated runs do not pile up. Never changes the exit code.
# Uses: repo, sha, failed, rows, failure_tail, base_branch, versions (text).
comment() {
  [[ $report -eq 1 ]] || return 0
  local branch pr marker body id verdict behind pushed
  branch="$(git rev-parse --abbrev-ref HEAD)"
  pr="$(gh pr list --head "$branch" --state open --json number --jq '.[0].number' 2>/dev/null || true)"
  [[ -n "$pr" ]] || return 0
  git fetch -q origin "$base_branch" "$branch" 2>/dev/null || true
  behind="$(git rev-list --count "HEAD..origin/$base_branch" 2>/dev/null || echo '?')"
  [[ "$(git rev-parse "origin/$branch" 2>/dev/null)" == "$sha" ]] && pushed=yes || pushed=NO
  verdict=$([[ $failed -eq 0 ]] && echo "all checks passed" || echo "FAILED")
  marker='<!-- ci-local -->'
  body="$marker
**Local checks: $verdict** on commit \`$sha\` ($(date -u +%Y-%m-%dT%H:%MZ))

| Step | Result | Detail | Time |
| --- | --- | --- | --- |
$(printf '%s\n' "${rows[@]}")

| What | Value |
| --- | --- |
| Commit | \`$sha\` on \`$branch\` |
| Tree | clean (the script refuses a dirty tree) |
| Pushed | $pushed (the commit above is the branch head on GitHub) |
| Behind \`$base_branch\` | $behind commit(s) |
| Tools | $versions |
| Host | $(uname -sm) |

Run by \`scripts/ci-local.sh\` on the author's machine; hosted CI is not used. The commit status says the same."
  if [[ -n "$failure_tail" ]]; then
    body="$body

<details><summary>Last output of the failing step</summary>

\`\`\`
$failure_tail
\`\`\`

</details>"
  fi
  id="$(gh api "repos/$repo/issues/$pr/comments" --paginate \
    --jq "[.[] | select(.body | startswith(\"$marker\"))][0].id // empty" 2>/dev/null || true)"
  if [[ -n "$id" ]]; then
    gh api -X PATCH "repos/$repo/issues/comments/$id" -f body="$body" >/dev/null 2>&1 ||
      echo "ci-local: could not update the PR comment" >&2
  else
    gh api "repos/$repo/issues/$pr/comments" -f body="$body" >/dev/null 2>&1 ||
      echo "ci-local: could not post the PR comment" >&2
  fi
}

node_counts() {
  awk '/^ℹ (tests|pass|fail|skipped) /{c[$2]=$3} END{printf "%d tests, %d passed, %d failed, %d skipped", c["tests"], c["pass"], c["fail"], c["skipped"]}' "$log"
}

post pending "running locally"
failed=0
step "node --test" node_counts node --test || failed=1
if [[ $failed -eq 0 ]]; then
  post success "passed locally on $(date -u +%Y-%m-%dT%H:%MZ)"
else
  post failure "failed locally"
fi
comment
exit $failed
