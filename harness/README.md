# harness/ — run dsh-mcp-session in a throwaway host

Everything here runs against **your own** scratch `DSH_HOME` (default
`/tmp/ms-eng-scratch`), never the live `~/.dsh` and never the live 3080 host.
`/tmp` is wiped by a reboot, so a scratch host is (re)created by
`harness/install-scratch.sh` — see
[Profile bootstrap & ENV-1 recovery](#profile-bootstrap--env-1-recovery).

## Layout

| Path | Role |
|---|---|
| `bootstrap-profile.sh` | **Profile bootstrap** (ENV-1): under a given `DSH_HOME`, creates `profiles/<name>/package.json` (+ an empty `cordis.patch.yml`), repairs the module farm, and proves the profile composes. Idempotent; refuses the live home and the shared baseline. Runnable on its own, and called by `install-scratch.sh`. |
| `install-scratch.sh` | Runs `bootstrap-profile.sh`, then symlinks the plugin + probes into `profiles/mcptest/node_modules`, writes the scratch config + patch overlay, and verifies the composed tree contains the three overlay plugins. |
| `run-smoke.sh` | Installs, boots the host with the overlay, prints the assertion table, exits with the report's status. |
| `mutate-and-check.sh` | Anti-vacuity check with F-mut hardening: **runs in a private COPY** (`$DSH_HOME/plugin-copy`, never the delivered workspace), takes an exclusive `flock`, rebuilds from `src` first, derives `expected` from the **bytes the patch step wrote** (never a second disk read), samples the mutated file's sha256 after apply AND after `run_harness` (a mismatch ⇒ `INCONCLUSIVE`, never `NOT CAUGHT`), requires the failure set to be exactly that behaviour's assertion(s), writes a per-mutation self-proof JSON **on every branch incl. INCONCLUSIVE** (with the `run_harness` start/end timestamps and the branch taken), digests the **delivered tree** before and after the run (it must not change), and ends by rebuilding and re-asserting the digest. |
| `fake-mcp/` | A harness-only plugin that registers fake `mcp__<server>__<tool>` tools (6 servers). `globalThis.__fakeMcpReconnect(name)` re-registers one tool with a fresh definition object — the shape of a real server reconnect. |
| `verify/` | The in-host driver: asserts with **dispatch** (plus one out-of-band `systemPrompt.assemble()` for the model-facing tool table), writes JSON, and calls `process.exit` **before any LLM request**. |

## DSH home (§5.2) — never the live home, never the shared baseline

| Priority | Source | Note |
|---|---|---|
| 1 | `DSH_SCRATCH` | explicit harness override (legacy name) |
| 2 | `DSH_HOME` | honoured **unless** it is the live `~/.dsh` (the ambient DSH session exports exactly that, so it is skipped) |
| 3 | default | `/tmp/ms-eng-scratch` (the engineer's own home) |

`~/.dsh` and `/tmp/dsh-scratch` are **refused** (the latter is the read-only shared
baseline; override deliberately with `MS_ALLOW_SHARED_HOME=1`). Each member uses
their own home: engineer `/tmp/ms-eng-scratch`, verifier `/tmp/ms-verify-scratch`,
reviewer `/tmp/ms-review-scratch`.

## ⚠️ Never run `dsh` without pinning `DSH_HOME`

`dsh` resolves its home from `DSH_HOME` and otherwise falls back to the **live**
`~/.dsh`. A bare

```sh
dsh plugin --profile mcptest add @deepseek-ai/dsh-base @deepseek-ai/dsh-headless
```

therefore **initializes/rewrites the live `~/.dsh/profiles/<name>/cordis.yml`**
(and creates that profile directory) — observed on this host at **17:02:30** while
the bootstrap command itself was being checked. It happened to be content-neutral
(the live file was byte-identical to its backup) but it is still a **live-home
write**, which nothing in this harness may cause.

Correct form — always pin a **throwaway** home:

```sh
DSH_HOME=/tmp/ms-eng-scratch dsh --profile mcptest --patch /tmp/ms-smoke.yml smoke
DSH_HOME=/tmp/ms-eng-scratch bash harness/install-scratch.sh   # preferred: the script pins it for you
```

Invariants the scripts enforce (audit them any time):

| Invariant | How to check |
|---|---|
| every `dsh` invocation in this directory sets `DSH_HOME="$SCRATCH"` explicitly (no inheritance) | `grep -n 'DSH_HOME="$SCRATCH" dsh' harness/*.sh` — every call site must appear there |
| if the resolved home is empty, the live `~/.dsh`, or the read-only baseline `/tmp/dsh-scratch`, the script **fails loudly and refuses to run** | the same scripts print `refusing to run dsh: DSH_HOME resolved to …` |
| `mutate-and-check.sh` never calls `dsh` directly; it delegates to `run-smoke.sh`, which carries the guard | `grep -n 'dsh \|DSH_HOME' harness/mutate-and-check.sh` |

If the **module farm** is missing (a wiped `/tmp`), that is *not* an error: dsh
rebuilds it from its installation anchor on the first real boot. The scripts say
so loudly on stderr and print the fallback for the case where the installation
anchor is gone too:

```sh
DSH_HOME=/tmp/ms-eng-scratch dsh plugin --profile mcptest add @deepseek-ai/dsh-base @deepseek-ai/dsh-headless
```

— always with `DSH_HOME` pinned. See `/tmp` can disappear (home **and** module
farm) — one-step recovery below for the whole procedure.

## Profile bootstrap & ENV-1 recovery

`bootstrap-profile.sh` is the **standalone** entry point for host preconditions and
`install-scratch.sh` calls it, so both of these orderings work:

```sh
# whole host in one step (recommended)
DSH_HOME=/tmp/ms-eng-scratch bash harness/install-scratch.sh

# or step by step, the way the repair task's verify chain does it
T=$(mktemp -d)
DSH_HOME=$T bash harness/bootstrap-profile.sh       # profile + compose check
DSH_HOME=$T bash harness/install-scratch.sh         # plugin links + config + overlay
DSH_HOME=$T bash harness/run-smoke.sh               # 85/0, zero model calls
```

Both scripts are idempotent — re-running them **is** the recovery procedure. They
refuse the live `~/.dsh` and the read-only baseline `/tmp/dsh-scratch`
(`MS_ALLOW_SHARED_HOME=1` overrides the latter deliberately), and they write
nothing outside `$DSH_HOME`.

### `/tmp` can disappear (home **and** module farm) — one-step recovery

`/tmp` was wiped repeatedly on 2026-09-13, which removed `/tmp/dsh-scratch`, the
private homes **and** the `profiles/node_modules` module farm. That is the
environment this whole section exists for: the home may not exist *at all*
(`mkdir -p` creates the directory tree, the profile skeleton and the plugin links
in one go), and the farm is re-created by dsh from its installation anchor on the
first real boot. Neither condition is an error, but neither may pass silently —
the scripts say so on stderr, with the recovery command inline.

One step, from any state (missing directory included):

```sh
cd plugins/dsh-mcp-session
DSH_HOME=/tmp/ms-eng-scratch bash harness/install-scratch.sh   # creates everything, then proves it composes
DSH_HOME=/tmp/ms-eng-scratch bash harness/run-smoke.sh         # 85/0
```

If the **installation anchor** is unavailable too (so dsh cannot rebuild the
farm), restore the bundles into the profile instead — pinning the home, because a
bare `dsh plugin --profile` writes the LIVE `~/.dsh`:

```sh
DSH_HOME=/tmp/ms-eng-scratch dsh plugin --profile mcptest add @deepseek-ai/dsh-base @deepseek-ai/dsh-headless
```

Who writes what inside the profile directory:

| File | Writer | Meaning |
|---|---|---|
| `package.json` | `bootstrap-profile.sh` | profile manifest + `dsh.profile.bundles = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]`. **Hard precondition**: a custom profile name is not a shipped template, so without this file the launcher aborts (see the table below). |
| `cordis.yml` | **dsh** | the profile-root entry list, generated on the first compose (`# dsh profile root — an empty entry list … Edit cordis.patch.yml, not this file`). `bootstrap-profile.sh` asserts it exists afterwards rather than writing its own copy. |
| `cordis.patch.yml` | `bootstrap-profile.sh` | the profile's user patch layer, applied after the bundle layers and before `--patch` overlays. Absent means "no user patches"; an empty list is written so the place for overrides is visible. |
| `node_modules/` | `install-scratch.sh` | the three harness links (`dsh-mcp-session`, `dsh-fake-mcp`, `dsh-ms-verify`). |
| `../node_modules/` | **dsh** | the module farm — see step 2 below. |

`bootstrap-profile.sh` does four things:

1. **Scripts the profile skeleton** — writes `<home>/profiles/<name>/package.json`.
   The launcher requires that file: without it `dsh --profile mcptest` aborts with
   `profile "mcptest" does not exist; create it with 'dsh plugin --profile mcptest add <package>'`
   (`dsh-app-boot`, `loadProfile()`, because `mcptest` is not a shipped template).
   The manifest written here is the equivalent of that suggested
   `dsh plugin --profile mcptest add @deepseek-ai/dsh-base @deepseek-ai/dsh-headless`
   command, and it is chosen because `dsh plugin add` forwards to pnpm *inside the
   profile directory* — where `install-scratch.sh` has already created
   `node_modules` symlinks into the plugin repository. A package manager writing
   through such a link is the hazard documented at the end of this file, which
   already damaged the npx installation once. (If you do want the pnpm route, run
   it on a clean profile directory, before the plugin links exist.)
2. **Repairs the module farm** `<home>/profiles/node_modules`. That directory is
   **owned by dsh**, not by this harness: `healProfilesModuleFallback()` `mkdir`s it
   and links the installation dependency closure into it on every **real boot**
   (not on `--dump-config`). The bootstrap therefore never creates it — it only
   removes a symlink found there, because both variants break:
   * a symlink to *another* home makes dsh write its links into **that** home;
   * a symlink whose target is gone (the normal outcome of "baseline existed, then
     the reboot wiped `/tmp`") makes **every** launch die with a bare
     `ENOENT: no such file or directory, mkdir '<home>/profiles/node_modules'`
     thrown from `healProfilesModuleFallback` — a message that names neither the
     cause nor the fix.
3. **Fails loudly** on every precondition it can check (`dsh`/`node` on PATH, a
   manifest with non-empty `bundles[]`, the plugin root, a built `lib/index.js`,
   the three plugin links resolving) and names the failing path and the fix.
4. **Proves the profile composes** — `dsh --profile mcptest --dump-default-config`
   for the bootstrap alone (zero model calls), and `install-scratch.sh`
   additionally runs `--dump-config` with the overlay and asserts the composed tree
   contains `fake-mcp`, `mcp-session` and `ms-verify`. Skip with
   `MS_SKIP_VERIFY=1`; logs are `$DSH_HOME/.bootstrap-profile.log` (`MS_BOOTSTRAP_LOG`)
   and `$DSH_HOME/.install-scratch-verify.log` (`MS_VERIFY_LOG`).

`bootstrap-profile.sh` accepts `DSH_PROFILE` as either a profile **name**
(`mcptest` ⇒ `$DSH_HOME/profiles/mcptest`, the form used in the verification
chain) or a **path** (what `install-scratch.sh`/`run-smoke.sh` pass along).

Symptom → cause → fix (all observed on this host after the 17:0x reboot wiped `/tmp`):

| Symptom | Cause | Fix |
|---|---|---|
| `profile "mcptest" does not exist; create it with 'dsh plugin --profile mcptest add <package>'` | the home was wiped; there is no profile manifest | `DSH_HOME=<home> bash harness/install-scratch.sh` (recreates the skeleton) |
| `Error: ENOENT: no such file or directory, mkdir '<home>/profiles/node_modules'` at `healProfilesModuleFallback` | a `profiles/node_modules` symlink (typically created when a shared baseline existed) is now dangling | re-run `install-scratch.sh`: it removes the link and dsh re-creates the directory from its installation anchor |
| dsh boots but the plugin row is missing / `Cannot find package "dsh-mcp-session"` | the plugin symlink is gone, or `lib/` is not built | `pnpm build` in the plugin root, then re-run `install-scratch.sh` |
| the driver aborts with `dsh-ms-verify: DSH_HOME is not set` / `…is the LIVE DSH home` / `no <home>/mcp-session.json` | a manual boot without a scratch home, or a boot against `~/.dsh` | run through `harness/run-smoke.sh`, or export `DSH_HOME=<home>` **after** `bootstrap-profile.sh` + `install-scratch.sh` |

Full recovery from a clean slate — a wiped `/tmp`, no shared baseline, nothing
installed (about a minute, zero tokens):

```sh
cd plugins/dsh-mcp-session
pnpm build                                            # lib/ must match src/
T=$(mktemp -d)                                        # or DSH_HOME=/tmp/ms-eng-scratch
DSH_HOME=$T bash harness/bootstrap-profile.sh         # profile manifest + compose check
DSH_HOME=$T bash harness/install-scratch.sh           # plugin links + config + overlay
DSH_HOME=$T bash harness/run-smoke.sh                 # 85/0
```

Verified from a pristine `mktemp -d` home with no shared baseline present at all:
`bootstrap-profile.sh` exit 0, `install-scratch.sh` exit 0
(`profile composes: 90 top-level entries`), then the full matrix
`total=85 failed=0 externalConfigWrites=0`, canonical unchanged, and zero bytes on
stdout (no model call). The dangling-farm case was verified both ways: raw boot →
the `ENOENT … mkdir` above; after the repair → `85/0`.

## Artifact digest algorithm (write it this way)

`canonical` is **not** `cat lib/*.js | sha256sum`. It is, byte for byte:

```sh
cd plugins/dsh-mcp-session
find src lib -type f | sort | xargs sha256sum | sha256sum          # canonical
find src lib -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum   # NUL-safe, same value
```

i.e. **sha256 every file, sort the resulting `<hash>  <path>` lines, concatenate
them, then hash that text** (relative paths — an absolute path changes the value).

⚠️ The digest covers `lib/**/*.js.map` too, and a source map embeds its output
path (`file:`/`sources` are relative to the map). So `--outDir` changes `.js.map`
while leaving every `.js` byte-identical, and the canonical value would drift.
**Always build with the repository `tsconfig.json` (`outDir: lib`)** — that is the
only supported way to reproduce the certified value. (Excluding `.map` from the
canonical was considered and rejected: t2/t8 certified values include them.)
A second, secondary fingerprint covers only executable output
(`find lib -name '*.js' …`) and is reported as the "runtime fingerprint".
`lib/index.js` alone must never be used as an artifact identity: it is a 580 B
wiring wrapper that no implementation change can alter.

## F5 helper healing is entry-point driven (per agent)

When a helper registration fails, healing happens at **that agent's own next
entry point** — its own helper execute (`refreshAgent` is wired into all four
action tools plus `mcp_status`) or its own assembly. Reading `mcp_status` on a
*different* agent does not heal it, and that is by design (§2.6.1): the retry set
is per agent and the check is a cheap name-set diff. Do not read a foreign
agent's status and conclude "not healed".

## Evidence metadata (F-json)

Every report embeds, so stale or contended evidence is recognisable at a glance:

```json
{
  "driver": "dsh-ms-verify@r4 (agent/request parked; zero model calls)",
  "driverFiles": [ { "path": "harness/verify/index.js", "size": 0, "mtime": "…", "sha256": "…" } ],
  "generatedAt": "2026-09-13T…Z",
  "canonical": "<sha256 over src+lib>",
  "canonicalCommand": "find src lib -type f | sort | xargs sha256sum | sha256sum",
  "canonicalCwd": "plugins/dsh-mcp-session",
  "libDigest": "<sha256 over lib>",
  "configHashes": { "before": "…", "after": "…" },
  "dshHome": "/tmp/ms-eng-scratch"
}
```

`driver` is only a label; **`driverFiles` anchors the driver version to bytes**
(`path`/`size`/`mtime`/`sha256` for the driver, the fake-MCP probe and the four
harness scripts), so a later reviewer can tell exactly which assertion set
produced a report instead of bounding it by mtime. It is a purely additive
field — no assertion, label or label text is involved.

`canonical` is computed inside the driver and verified byte-identical to the shell
command above; the NUL-safe equivalent
(`find src lib -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum`)
produces the same value.

## Run

```sh
cd plugins/dsh-mcp-session
pnpm build                          # or: tsc -p tsconfig.json
DSH_HOME=/tmp/ms-eng-scratch bash harness/install-scratch.sh   # bootstrap the host (idempotent)
bash harness/run-smoke.sh           # installs if needed, then runs the matrix, zero model calls
bash harness/mutate-and-check.sh    # anti-vacuity: baseline green + 6/6 mutations caught
MS_ONLY=M5 bash harness/mutate-and-check.sh   # one mutation only (a full round takes minutes)
```

`mutate-and-check.sh` prints one line per mutation and expects, e.g.:

```
M1 description-mining: caught by 3 assertion(s) under 'S17' …
M5 fail-open insurance removed: caught by 1 assertion(s) under 'S21' …
lib digest unchanged ⇒ every mutation was byte-for-byte reverted.
```

A verdict of `NOT CAUGHT` (the assertion cannot fail) or `UNEXPECTED COLLATERAL`
(failures outside the mutated behaviour) fails the script. **`INCONCLUSIVE` has
four distinct causes and they are not interchangeable** — every one of them is
logged *and* written into that mutation's self-proof JSON with its `branch`:

| Branch | Meaning | What to do |
|---|---|---|
| `inconclusive-pristine-at-sample` | the patch step's own output already equals the pristine backup (a concurrent writer restored the file before we sampled) | find the other writer (a concurrent `pnpm build` / hand edit); do **not** re-run into the same contention |
| `inconclusive-changed-after-apply` | the file on disk right after patching differs from the bytes the patch step wrote (a second writer hit the work copy inside the sample gap) | same: an external writer touched the work copy |
| `inconclusive-not-landed` | the lib digest equals the baseline right after patching (the anchor did not apply) | update the script's anchor — the mutation is now vacuous |
| `inconclusive-contaminated-in-window` | the mutated file changed between the patch sample and the end of the run (mid-run rewrite, or a rewrite that landed before the harness loaded the module) | same as above: an external writer touched the work copy |
| `inconclusive-restore-drift` | `lib` did not return to the baseline after restoring | the build is not deterministic, or something else wrote `lib` |
| `inconclusive-truncated` | the run produced fewer steps than the baseline (shared-host contention) | rerun — this is the only "just rerun" case |

The two contamination branches are the ones that would otherwise be *misreported
as `NOT CAUGHT`* and blamed on the assertion: `expected` is therefore the digest
of the bytes the patch step **wrote** (never a second read of the file), and a
rewrite inside the run is caught by the post-run sample.

Every mutation writes `$MS_MUT_DIR/<label>.selfproof.json` on **every** branch
(caught / not-caught / collateral / all four INCONCLUSIVE branches), with
`{label, file, expect, branch, reason, libBaseline, mutatedFileAfterApply,
mutatedFileAfterRun, libAfterRestore, runStartedAt, runFinishedAt,
runStartedEpochMs, runFinishedEpochMs, generatedAt}` — so "was the contamination
inside the run?" is answerable from the artefact. The whole run also digests the
**delivered tree** (`find src lib … | sha256sum`, same command as the release
gate) before and after and fails if it changed: mutations only ever touch the
private copy.

A killed run rebuilds `lib` from `src` via an `EXIT/INT/TERM` trap; a `SIGKILL`
cannot be trapped, so re-run `pnpm build` if a run is force-killed.

Useful environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `DSH_SCRATCH` | unset | Explicit harness override (legacy name). When unset the home comes from `DSH_HOME` (unless it is the live `~/.dsh`), else `/tmp/ms-eng-scratch`. Point one home at one member. |
| `DSH_PROFILE` | `$SCRATCH/profiles/mcptest` | Profile to install into. |
| `MS_PATCH` | `/tmp/ms-smoke.yml` | Generated patch overlay. |
| `MS_REPORT` | `/tmp/ms-verify-report.json` | Report path. Give each **concurrent** member their own (`MS_REPORT=/tmp/<member>-report.json`), or two runs overwrite each other's evidence. |
| `MS_CANONICAL` | `/tmp/ms-harness-canonical.json` | Harness-private snapshot of the canonical config; the driver restores from it (see below). |
| `MS_SHARED_HOME` | `/tmp/dsh-scratch` | Optional donor for `settings.yaml` / `.credentials.yaml` only (the module farm is **not** borrowed any more — dsh owns it). Absent ⇒ a warning, not an error. |
| `MS_VERIFY_LOG` | `$SCRATCH/.install-scratch-verify.log` | Where the bootstrap compose check writes dsh's output. |
| `MS_SKIP_VERIFY` | `0` | `1` skips the compose check in `install-scratch.sh`. |

Raw boot logs land in `/tmp/ms-smoke.stdout` / `/tmp/ms-smoke.stderr` — a fixed
path, so **concurrent** runs interleave there; read the report instead.

## Shared-host concurrency guard

When two members share one scratch home (the pre-reboot setup pointed every
probe at `/tmp/dsh-scratch`), they also share `$DSH_HOME/mcp-session.json`, and
they rewrite it (a r2 probe left `hintScan.maxServers: 1`, another left
`proxyTool: false`). Adopting that as "the config" produced a whole run of
**false** failures — 24 of them, in the worst case.

So `install-scratch.sh` also copies the canonical config to a harness-private
path (`MS_CANONICAL`), and the driver restores `mcp-session.json` from that copy
at the start of the matrix **and** before every config-sensitive step (S13, S18,
S19). The report carries an `externalConfigWrites` counter, so an intruding
write is visible instead of being mistaken for a product defect. Verified: with
the shared config polluted after install, the run reports green with
`externalConfigWrites=1` instead of cascading failures.

The cleanest option is still a private home for each agent
(`DSH_HOME=/tmp/<agent>-scratch`); `install-scratch.sh` creates everything such a
home needs now, including the profile skeleton.

## What the smoke covers

`S1` default hidden · `S2` helper tools visible · `S3` keyword reveal + isolation ·
`S4` model-facing tool table + catalog section · `S5` multi-pin + corrective
errors · `S6` turn boundary (reveal withdrawn, pin kept) · `S7` unpin ·
`S8` subagent self-sufficiency (parent unaffected) · `S9` parent-pin inheritance
and explicit withdrawal from a live child · `S10` ledger · `S11` provider
ordering evidence · `S12` shadow rebuild after a reconnect · `S13` multi-server
reveal + auto-derived hints for an unconfigured server · `S14` an agent with NO
scope-chain link is still restricted by its own layer · `S15` helper tools exist
only in agent layers, never in the plugin/global layer · `S16` a parent pin is
materialized into a new agent with no scope link at all · `S17` description text
("for"/"the"/"search") is never mined into hints · `S18` quality-first ranking +
truncation reporting · `S19` `proxyTool=false` releases the proxy tools (and
restoring it re-registers them) · `S20` unpinning an inherited pin explains that
the parent owns it.

## Hermetic by construction

The driver registers `agent/request` and returns a promise that never settles.
That event is awaited by the step **after assembly and before any provider
call**, so the turn parks with the assembly already exercised: no model request
is ever issued (the harness costs zero tokens — assert it by checking that
`/tmp/ms-smoke.stdout` is empty), and the root agent is never disposed mid-run.

Do not replace that with a `agent/pre-step` rejection: the headless runner then
sees a finished turn with no answer, tears the agent down, and every later
dispatch fails with a cascade of `unknown tool "mcp_*"`.

## Writing more probes

Add a folder with a `package.json` (`"main": "index.js"`, `"type": "module"`)
and an `index.js` exporting `name` / `inject` / `apply`, then add a row to the
overlay. Probe plugins are mounted as untagged cordis contexts, so they receive
every scope-filtered agent event. Reuse `verify/index.js`'s `dispatch` helper:
visibility must be judged by dispatch, never by `tools.schemas()` without an
explicit scope key (that returns the global view).

## ⚠️ Environment hazard (learned the hard way)

**Never** create a `node_modules/<name>` entry that is a symlink pointing INTO
the shared DSH checkout (`~/.npm/_npx/*/node_modules/...`), and then run
`pnpm install` / `npm install` from that project. The package manager links
dependencies by writing through that path, so it replaces real packages inside
the checkout with symlinks into the project's own `.pnpm` store — which breaks
the checkout for everyone (the live host). Recovery is
`cd ~/.npm/_npx/<hash> && npm install --prefer-offline`, which restores the
missing packages from `package-lock.json`.

Resolve types and runtime deps for the plugin's own build with a real
`pnpm install` in `plugins/dsh-mcp-session` (the committed `pnpm-lock.yaml`
covers it); the harness symlinks the plugin directory into the *scratch*
profile in the other direction, which is safe because no install runs there.

