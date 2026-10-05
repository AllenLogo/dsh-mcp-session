#!/usr/bin/env bash
# Anti-vacuity check ("mutation testing") for the dsh-mcp-session harness.
#
# A green harness proves nothing on its own: an assertion that can never fail
# is worse than no assertion, because it looks like coverage. This script
# mutates the BUILT plugin so that one specific behaviour is broken, runs the
# harness, and REQUIRES the matching assertion to fail. Restores the build
# afterwards (and re-runs `pnpm build` so `lib/` provably matches `src/`).
#
# Usage:  bash harness/mutate-and-check.sh
# Exit:   0 = baseline green and every mutation was caught by its assertion
#         1 = baseline not green, a mutation was not caught, an anchor moved, or
#             a run was INCONCLUSIVE (contamination/truncation). An unreliable
#             reading is NEVER reported as "NOT CAUGHT": a premature verdict must
#             not be blamed on the assertion.
#
# Every mutation writes $MS_MUT_DIR/<label>.<branch>.selfproof.json — including the
# INCONCLUSIVE branches — carrying the sampled digests, the branch it took and
# the run_harness start/end timestamps, so "was the contamination inside the
# run?" is answerable from the artefact instead of from a guess.
# The DELIVERED tree (src+lib) is digested before and after the whole run and
# must not change: mutations only ever touch the private working copy.
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# §5.2: one DSH_HOME per member. Precedence:
#   DSH_SCRATCH (explicit harness override, legacy)  >  DSH_HOME (unless it is
#   the LIVE home, which the ambient DSH session always exports)  >  default.
# The live home and the shared read-only baseline /tmp/dsh-scratch are refused.
LIVE_HOME="${HOME}/.dsh"
DEFAULT_HOME="/tmp/ms-eng-scratch"
if [[ -n "${DSH_SCRATCH:-}" ]]; then
  HOME_DIR="$DSH_SCRATCH"
elif [[ -n "${DSH_HOME:-}" && "$DSH_HOME" != "$LIVE_HOME" ]]; then
  HOME_DIR="$DSH_HOME"
else
  HOME_DIR="$DEFAULT_HOME"
fi
if [[ "$HOME_DIR" == "$LIVE_HOME" ]]; then
  echo "refusing to install into the live DSH home: $HOME_DIR" >&2
  exit 1
fi
if [[ "$HOME_DIR" == "/tmp/dsh-scratch" && "${MS_ALLOW_SHARED_HOME:-}" != "1" ]]; then
  echo "refusing to write the shared read-only baseline /tmp/dsh-scratch (use DSH_HOME=<your own home>, or set MS_ALLOW_SHARED_HOME=1)" >&2
  exit 1
fi
SCRATCH="$HOME_DIR"
MUT_DIR="${MS_MUT_DIR:-/tmp/ms-mutation}"
BASELINE_REPORT="$MUT_DIR/baseline.json"

mkdir -p "$MUT_DIR"

# F-mut ④: NEVER mutate the delivered workspace. Everything below (rsync, patch,
# build, harness) runs against a private COPY, so a concurrent reader/reviewer or
# another build can never observe — or be contaminated by — a mutated `lib/`.
SRC_DIR="$PLUGIN_DIR"
PLUGIN_DIR="${MS_MUT_WORK:-$SCRATCH/plugin-copy}"
mkdir -p "$PLUGIN_DIR"
rsync -a --delete --exclude node_modules --exclude review --exclude verification "$SRC_DIR"/ "$PLUGIN_DIR"/ 2>/dev/null \
  || cp -a "$SRC_DIR"/. "$PLUGIN_DIR"/
ln -sfn "$SRC_DIR/node_modules" "$PLUGIN_DIR/node_modules"
echo "== working copy =="
echo "  src: $SRC_DIR"
echo "  work: $PLUGIN_DIR (mutations happen HERE)"

cd "$PLUGIN_DIR"

overall=0

# F-mut ①: mutual exclusion. A second concurrent run (or a hand-edit) would make
# the measured digests meaningless, so take an exclusive lock and refuse to run
# without it. `flock` when available, else an atomic mkdir lock.
LOCK_DIR="$MUT_DIR/lock"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$MUT_DIR/.lockfile"
  if ! flock -n 9; then
    echo "another mutate-and-check run holds the lock — refusing to run concurrently" >&2
    exit 1
  fi
else
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "another mutate-and-check run holds $LOCK_DIR — refusing to run concurrently" >&2
    exit 1
  fi
  trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT
fi

lib_digest() {
  # One deterministic fingerprint over every emitted module.
  find lib -name '*.js' -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1
}

# Canonical digest of the DELIVERED tree (src+lib) — the same command the release
# gate uses, run from the source root, so the two numbers are comparable. The
# mutations must never change it (they run in the copy above).
delivered_digest() {
  ( cd "$SRC_DIR" && find src lib -type f | sort | xargs sha256sum | sha256sum | cut -d' ' -f1 )
}

DELIVERED_BEFORE="$(delivered_digest)"
echo "  delivered tree canonical (before): $DELIVERED_BEFORE"

# Crash-safe: any exit path (including Ctrl-C or a killed run) rebuilds `lib`
# from `src`, so a mutation can never be left behind in the delivered artifact.
restore_build() {
  cd "$PLUGIN_DIR" 2>/dev/null || true
  pnpm build >/dev/null 2>&1 || true
}
trap restore_build EXIT INT TERM

run_harness() {
  local report="$1"
  rm -f "$report"
  # ENV-1b: this script never calls `dsh` itself — it delegates to run-smoke.sh,
  # which pins DSH_HOME explicitly (a bare `dsh plugin --profile <name>` rewrites
  # the LIVE ~/.dsh/profiles/<name>; incident 2026-09-13 17:02:30). Audit:
  #   grep -n 'DSH_HOME="$SCRATCH" dsh' harness/*.sh
  # The driver restores the canonical config itself (see harness/README.md), so
  # a concurrently polluted shared home cannot skew the result.
  RUN_STARTED_AT="$(date -Is)"
  RUN_STARTED_EPOCH_MS="$(date +%s%3N)"
  DSH_SCRATCH="$SCRATCH" MS_REPORT="$report" bash harness/run-smoke.sh >/dev/null 2>&1 || true
  RUN_FINISHED_AT="$(date -Is)"
  RUN_FINISHED_EPOCH_MS="$(date +%s%3N)"
  [[ -f "$report" ]]
}

# Self-proof writer: one JSON per mutation, on EVERY branch (incl. INCONCLUSIVE).
#   $1 label  $2 file  $3 expect  $4 expected(before run)  $5 runFileAfter
#   $6 libAfterRestore  $7 branch  $8 reason
# globals: LIB_BASELINE, RUN_STARTED_AT, RUN_FINISHED_AT
selfproof_path() {
  # One file per (label, branch): two INCONCLUSIVE runs of one label in the same
  # MS_MUT_DIR must not overwrite each other's evidence (reviewer gate 3b). The
  # gates resolve the file by its `branch` FIELD; the name is only an index.
  echo "$MUT_DIR/$(echo "$1" | tr -cd 'A-Za-z0-9_-').$(echo "${2:-unknown}" | tr -cd 'A-Za-z0-9_-').selfproof.json"
}

write_selfproof() {
  node -e '
    const fs = require("fs")
    const [out, payload] = process.argv.slice(1)
    fs.writeFileSync(out, JSON.stringify(JSON.parse(payload), null, 2))
  ' "$(selfproof_path "$1" "${7:-}")" "$(node -e '
    console.log(JSON.stringify({
      label: process.argv[1], file: process.argv[2], expect: process.argv[3],
      branch: process.argv[4], reason: process.argv[5],
      libBaseline: process.argv[6],
      mutatedFileAfterApply: process.argv[7],
      mutatedFileAfterRun: process.argv[8],
      libAfterRestore: process.argv[9],
      runStartedAt: process.argv[10] || null, runFinishedAt: process.argv[11] || null,
      runStartedEpochMs: process.argv[12] || null, runFinishedEpochMs: process.argv[13] || null,
      generatedAt: new Date().toISOString(),
    }))
  ' "$1" "$2" "$3" "${7:-}" "${8:-}" "$LIB_BASELINE" "${4:-}" "${5:-}" "${6:-}" \
    "${RUN_STARTED_AT:-}" "${RUN_FINISHED_AT:-}" "${RUN_STARTED_EPOCH_MS:-}" "${RUN_FINISHED_EPOCH_MS:-}")"
}

summarise() {
  node -e '
    const report = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
    console.log(`  total=${report.total} failed=${report.failed} externalConfigWrites=${report.externalConfigWrites ?? 0}`)
  ' "$1"
}

echo "== baseline (unmutated) =="
echo "  rebuilding lib from src (a dirty workspace cannot skew the run)…"
pnpm build >/dev/null 2>&1 || { echo "pnpm build failed" >&2; exit 1; }
LIB_BASELINE="$(lib_digest)"
LIB_BEFORE="$LIB_BASELINE"
echo "  lib digest baseline: $LIB_BASELINE"
if ! run_harness "$BASELINE_REPORT"; then
  echo "  no report produced — cannot continue" >&2
  exit 1
fi
summarise "$BASELINE_REPORT"
baseline_failed=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).failed)' "$BASELINE_REPORT")
if [[ "$baseline_failed" != "0" ]]; then
  echo "  baseline is NOT green — fix that first, otherwise mutations prove nothing" >&2
  exit 1
fi
BASELINE_TOTAL=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).total)' "$BASELINE_REPORT")
echo "  baseline total=$BASELINE_TOTAL"

# mutate <label> <file> <expect-label-prefix> <json-replacements>
#   json-replacements: [["anchor","replacement"], ...] applied literally, in order
mutate() {
  local label="$1" file="$2" expect="$3" replacements="$4"
  # MS_ONLY lets a caller run a subset (a full round takes several minutes):
  #   MS_ONLY=M3 bash harness/mutate-and-check.sh
  if [[ -n "${MS_ONLY:-}" && "$label" != ${MS_ONLY}* ]]; then return; fi
  local backup="$MUT_DIR/$(basename "$file").orig"
  local report="$MUT_DIR/$(echo "$label" | tr -cd 'A-Za-z0-9_-').json"

  cp "$file" "$backup"
  local written_digest
  if ! written_digest="$(node -e '
      const fs = require("fs")
      const { createHash } = require("node:crypto")
      const [file, pairs] = process.argv.slice(1)
      let source = fs.readFileSync(file, "utf8")
      for (const [anchor, replacement] of JSON.parse(pairs)) {
        if (!source.includes(anchor)) {
          console.error(`ANCHOR MISSING: ${anchor.slice(0, 70)}`)
          process.exit(2)
        }
        source = source.replace(anchor, replacement)
      }
      fs.writeFileSync(file, source)
      console.log(createHash("sha256").update(Buffer.from(source, "utf8")).digest("hex"))
    ' "$file" "$replacements")"; then
    cp "$backup" "$file"
    echo "  $label: ANCHOR MOVED (skipped, counts as failure — update the script)"
    overall=1
    return
  fi

  # F-mut ②: prove the patch landed AND that it survived the run. The mutated
  # FILE is sampled twice (after apply, after run_harness); both samples must
  # equal the digest this mutation is expected to produce, otherwise the run was
  # contaminated (e.g. a concurrent `pnpm build` restored `lib` mid-run) and the
  # verdict is INCONCLUSIVE — never NOT CAUGHT.
  local mutated_digest expected_file_digest run_file_digest
  mutated_digest="$(lib_digest)"
  # (b) `expected` is the digest of the bytes the patch step WROTE — never a
  # second read of the file. Reading it from disk left a narrow window in which a
  # concurrent writer could restore pristine content, making a landed mutation
  # look like a vacuous assertion (false `NOT CAUGHT`, reviewer finding).
  expected_file_digest="$written_digest"
  # (a) double insurance: if what we wrote already equals the pristine backup, we
  # sampled after someone else restored it ⇒ INCONCLUSIVE, never NOT CAUGHT.
  local backup_digest
  backup_digest="$(sha256sum "$backup" | cut -d' ' -f1)"
  if [[ "$expected_file_digest" == "$backup_digest" ]]; then
    cp "$backup" "$file"
    echo "  $label: INCONCLUSIVE — the patch step wrote pristine bytes (contamination before the sample)"
    write_selfproof "$label" "$file" "$expect" "$expected_file_digest" "" "$(lib_digest)"       "inconclusive-pristine-at-sample" "the patch step's own output equals the pristine backup"
    overall=1
    return
  fi
  if [[ "$mutated_digest" == "$LIB_BASELINE" ]]; then
    cp "$backup" "$file"
    echo "  $label: INCONCLUSIVE — the patched lib digest equals the baseline (patch did not land)"
    write_selfproof "$label" "$file" "$expect" "$expected_file_digest" "" "$(lib_digest)" \
      "inconclusive-not-landed" "the lib digest equals the baseline right after patching"
    overall=1
    return
  fi
  # Criterion ②: what is on disk right after patching must still be what the patch
  # step wrote. `expected` is already fixed from the writer's own output, so this is
  # a diagnostic comparison — if it differs, a concurrent writer hit the work copy
  # inside the sample gap ⇒ INCONCLUSIVE (never NOT CAUGHT).
  local disk_after_apply
  disk_after_apply="$(sha256sum "$file" | cut -d' ' -f1)"
  if [[ "$disk_after_apply" != "$expected_file_digest" ]]; then
    cp "$backup" "$file"
    echo "  $label: INCONCLUSIVE — the file on disk differs from what the patch step wrote (concurrent writer inside the sample gap)"
    echo "      wrote=${expected_file_digest:0:16} onDisk=${disk_after_apply:0:16}"
    write_selfproof "$label" "$file" "$expect" "$expected_file_digest" "" "$(lib_digest)" \
      "inconclusive-changed-after-apply" "the file on disk right after patching differs from the bytes the patch step wrote"
    overall=1
    return
  fi

  run_harness "$report" || true

  run_file_digest="$(sha256sum "$file" | cut -d' ' -f1)"
  if [[ "$run_file_digest" != "$expected_file_digest" ]]; then
    cp "$backup" "$file"
    echo "  $label: INCONCLUSIVE — the mutated file changed during the run (workspace contaminated mid-run)"
    echo "      expected=${expected_file_digest:0:16} afterRun=${run_file_digest:0:16}"
    echo "      run window: ${RUN_STARTED_AT} → ${RUN_FINISHED_AT}"
    write_selfproof "$label" "$file" "$expect" "$expected_file_digest" "$run_file_digest" "$(lib_digest)"       "inconclusive-contaminated-in-window" "the mutated file changed between the patch sample and the end of the run"
    overall=1
    return
  fi
  # Exact-failure-set semantics: the mutation must break AT LEAST ONE assertion
  # under `expect`, and it must break NOTHING outside it (no collateral damage —
  # that is what makes the failure set meaningful rather than "something broke").
  local verdict
  verdict=$(node -e '
    const report = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
    const expected = process.argv[2]
    const re = new RegExp(expected)
    const failed = report.steps.filter((step) => !step.ok).map((step) => step.label)
    const inside = failed.filter((label) => re.test(label))
    const outside = failed.filter((label) => !re.test(label))
    console.log(JSON.stringify({ inside: inside.length, outside, first: inside[0] ?? null, total: report.total }))
  ' "$report" "$expect")

  cp "$backup" "$file"
  local after_restore_digest
  after_restore_digest="$(lib_digest)"
  if [[ "$after_restore_digest" != "$LIB_BASELINE" ]]; then
    echo "  $label: INCONCLUSIVE — lib digest did not return to the baseline after restore"
    write_selfproof "$label" "$file" "$expect" "$expected_file_digest" "$run_file_digest" "$after_restore_digest"       "inconclusive-restore-drift" "the lib digest did not return to the baseline after restoring the build"
    overall=1
    return
  fi

  # (the self-proof is written once the verdict is known — see below — so that a
  # contaminated/truncated run is recorded with the branch it actually took.)

  local inside outside first
  inside=$(node -e 'console.log(JSON.parse(process.argv[1]).inside)' "$verdict")
  outside=$(node -e 'const o=JSON.parse(process.argv[1]).outside; console.log(o.length ? o.join(" | ") : "")' "$verdict")
  first=$(node -e 'console.log(JSON.parse(process.argv[1]).first ?? "")' "$verdict")

  # Completeness FIRST: a run truncated by shared-host contention must never be
  # misread as "the assertion is vacuous" (observed once: M3 looked vacuous only
  # because the harness died before reaching S19 while a real-turn probe ran).
  local branch reason
  if [[ "$(node -e 'console.log(JSON.parse(process.argv[1]).total)' "$verdict")" -lt "$BASELINE_TOTAL" ]]; then
    branch="inconclusive-truncated"
    reason="the run produced fewer steps than the baseline (shared-host contention?)"
    echo "  $label: INCONCLUSIVE — $reason; rerun"
    overall=1
  elif [[ "$inside" == "0" ]]; then
    branch="not-caught"
    reason="no failing assertion matched '$expect' and the run was complete"
    echo "  $label: NOT CAUGHT — no failing assertion matched '$expect' and the run was complete (the assertion is VACUOUS)"
    overall=1
  elif [[ -n "$outside" ]]; then
    branch="unexpected-collateral"
    reason="failures outside '$expect': $outside"
    echo "  $label: UNEXPECTED COLLATERAL — $inside '$expect' failure(s) but also: $outside"
    overall=1
  else
    branch="caught"
    reason="$inside assertion(s) under '$expect'"
    echo "  $label: caught by $inside assertion(s) under '$expect' — exactly: ${first:0:66}…"
  fi
  # F-mut ② self-proof: digests + branch + the run window, on every branch.
  write_selfproof "$label" "$file" "$expect" "$expected_file_digest" "$run_file_digest" "$after_restore_digest" "$branch" "$reason"
}

echo
echo "== mutations (each must break its own assertion) =="

# M1: derive hints from tool DESCRIPTIONS again (F1 regression).
mutate "M1 description-mining" "lib/hints.js" "^S17 " \
  '[["for (const token of identifierTokens(tool))\n            out.add(token);",
     "for (const token of identifierTokens(tool))\n            out.add(token);\n        for (const token of identifierTokens(entry.names.get(tool).description ?? \"\"))\n            out.add(token);"]]'

# M2: rank by text position first instead of hint quality (F2 regression).
mutate "M2 position-first ranking" "lib/hints.js" "^S18 " \
  '[["scored.sort((a, b) => Number(b.configured) - Number(a.configured) ||\n        b.length - a.length ||\n        a.at - b.at ||",
     "scored.sort((a, b) => a.at - b.at ||"]]'

# M3: ignore config.proxyTool when computing the wanted helper set (F3 regression).
mutate "M3 proxyTool ignored" "lib/manager.js" "^(S19|S22) " \
  '[["return this.config.proxyTool ? [...HELPER_TOOL_NAMES] : [];", "return [...HELPER_TOOL_NAMES];"]]'

# M4: revert the F4 wording so the diagnosis no longer says the agent holds nothing.
mutate "M4 unpin wording reverted" "lib/manager.js" "^S20 " \
  '[["本 agent 未持有", "本 agent 已有"], ["分别物化", "内部物化"]]'

# M6: always advertise the helper tools in the catalog, even when released
# (F-V1 regression, isolated from F3's gating so the two are independently proven).
mutate "M6 catalog ignores proxyTool" "lib/manager.js" "^S22 " \
  '[["const helpersEnabled = this.wantedHelperNames().length > 0;", "const helpersEnabled = true;"]]'

# M5: drop the per-agent fail-open insurance (F5-④ regression).
mutate "M5 fail-open insurance removed" "lib/manager.js" "^S21 " \
  '[["state.helperFailOpen = wantHelp && state.helperNames.length === 0 && state.helperFailures.length > 0", "state.helperFailOpen = false"]]'

echo
echo "== restoring the build from src =="
pnpm build >/dev/null 2>&1 && echo "  pnpm build ok" || { echo "  pnpm build FAILED" >&2; overall=1; }

LIB_AFTER="$(lib_digest)"
echo "  lib digest after:  $LIB_AFTER"
if [[ "$LIB_AFTER" != "$LIB_BEFORE" ]]; then
  echo "  lib digest CHANGED — the mutation was not fully reverted (or the build is not deterministic)" >&2
  overall=1
else
  echo "  lib digest unchanged ⇒ every mutation was byte-for-byte reverted."
fi

DELIVERED_AFTER="$(delivered_digest)"
echo "  delivered tree canonical (after):  $DELIVERED_AFTER"
if [[ "$DELIVERED_AFTER" != "$DELIVERED_BEFORE" ]]; then
  echo "  DELIVERED TREE CHANGED — mutations must only ever touch the working copy" >&2
  overall=1
else
  echo "  delivered tree unchanged ⇒ every mutation stayed inside the working copy."
fi

# L5 (machine-readable): one record for the whole run. The "after" value only
# exists once every mutation has finished, so it is written here instead of being
# stamped into each self-proof; the stdout lines above stay as they were.
node -e '
  const fs = require("fs")
  const [out, before, after] = process.argv.slice(1)
  fs.writeFileSync(out, JSON.stringify({
    deliveredTreeCanonicalBefore: before,
    deliveredTreeCanonicalAfter: after,
    deliveredTreeUnchanged: before === after && after !== "",
    cwd: "plugins/dsh-mcp-session",
    command: "find src lib -type f | sort | xargs sha256sum | sha256sum",
    generatedAt: new Date().toISOString(),
  }, null, 2))
' "$MUT_DIR/delivered-tree.json" "$DELIVERED_BEFORE" "$DELIVERED_AFTER"

if [[ "$overall" == "0" ]]; then
  echo
  echo "RESULT: baseline green; every mutation was caught by exactly its own assertion; lib restored byte-for-byte."
else
  echo
  echo "RESULT: at least one mutation was NOT caught cleanly (see above)." >&2
fi
exit "$overall"
