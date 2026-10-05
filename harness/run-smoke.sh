#!/usr/bin/env bash
# Run the in-host smoke matrix (zero model calls; the driver exits as soon as
# the assertions settle).
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
PROFILE="${DSH_PROFILE:-$SCRATCH/profiles/mcptest}"
PATCH_FILE="${MS_PATCH:-/tmp/ms-smoke.yml}"
REPORT="${MS_REPORT:-/tmp/ms-verify-report.json}"
# Harness-private canonical config snapshot (see install-scratch.sh).
CANONICAL_FILE="${MS_CANONICAL:-/tmp/ms-harness-canonical.json}"

bash "$PLUGIN_DIR/harness/install-scratch.sh" >/dev/null
rm -f "$REPORT"

# ENV-1b HARD RULE (2026-09-13 incident): every `dsh` call pins DSH_HOME
# explicitly — never inherit it. A bare `dsh plugin --profile <name>` (or any dsh
# call without DSH_HOME) runs against the LIVE home and rewrites
# `~/.dsh/profiles/<name>/cordis.yml`. Audit:
#   grep -n 'DSH_HOME="$SCRATCH" dsh' harness/*.sh
if [[ -z "${SCRATCH:-}" || "$SCRATCH" == "$LIVE_HOME" || "$SCRATCH" == "/tmp/dsh-scratch" ]]; then
  echo "refusing to run dsh: DSH_HOME resolved to '${SCRATCH:-<unset>}' (live home or read-only baseline). Pin it to a throwaway home — a bare 'dsh plugin --profile <name>' rewrites the LIVE ~/.dsh/profiles/<name>." >&2
  exit 1
fi

set +e
DSH_HOME="$SCRATCH" MS_REPORT="$REPORT" MS_CANONICAL="$CANONICAL_FILE" \
  dsh --profile "$(basename "$PROFILE")" --patch "$PATCH_FILE" "smoke" >/tmp/ms-smoke.stdout 2>/tmp/ms-smoke.stderr
code=$?
set -e

echo "exit=$code"
if [[ -f "$REPORT" ]]; then
  node -e '
    const report = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log(`total=${report.total} failed=${report.failed}`);
    for (const step of report.steps) {
      console.log(`${step.ok ? "PASS" : "FAIL"}  ${step.label}${step.detail ? "  -- " + step.detail : ""}`);
    }
  ' "$REPORT"
else
  echo "no report at $REPORT"
  tail -40 /tmp/ms-smoke.stderr
fi
exit $code
