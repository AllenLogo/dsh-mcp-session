# dsh-mcp-session

Session-level MCP visibility for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
English | [中文](README.zh.md)

MCP tools are expensive context: every connected server's schemas ride along in
every request, whether or not the current conversation needs them.
`dsh-mcp-session` makes the default cost **zero** — every `mcp__<server>__*`
tool is hidden until something actually needs it — without ever forcing the
model to "activate" a server first.

## What it does

| Capability | Behaviour |
|---|---|
| **Zero-cost default** | With no trigger, no MCP tool schema is sent. Only the plugin's 5 small tools and one compact catalog section remain. |
| **Keyword auto-reveal** | A hint appearing anywhere in the turn's user text (e.g. `高德`, `地址`, `在哪`) reveals that server's native tools **for that turn**, with no activation step. |
| **Session pins (multi)** | `mcp_pin("amap")` + `mcp_pin("xiaohongshu")` → both stay resident for the whole session, both live at the same time. `mcp_unpin` releases one. |
| **Proxy fallback** | `mcp_call("amap","maps_geo",{...})` reaches any registered MCP tool in one step even when the server was never revealed. |
| **Subagents are first-class** | A subagent acquires servers **on its own** (`mcp_call` / `mcp_pin` inside its own scope). A scheduling parent never needs to know an MCP server exists. |
| **Catalog section** | One compact line per server (alias, triggers, pin state, how to call) so the model never has to guess. |

## Install

```sh
# in your DSH profile (e.g. ~/.dsh/profiles/web)
pnpm add dsh-mcp-session
```

The package ships its own `cordis.patch.yml`, so adding it to the profile's
bundle list is enough. For a local checkout, insert the row manually:

```yaml
- insert:
    - id: dsh-mcp-session
      name: dsh-mcp-session
      config: {}
```

### Coexistence with `dsh-mcp-lazy`

Use **one** visibility owner. `dsh-mcp-lazy`'s manager also calls
`tools.restrict()`, and two writers of the same per-agent mask produce
unpredictable results. Migration:

1. snapshot `~/.dsh/profiles/web/cordis.patch.yml`;
2. add the `dsh-mcp-session` insert row and set `mcp-lazy-manager` to
   `disabled: true`;
3. restart and run `mcp_status()`: with nothing pinned, zero `mcp__*` tools
   should be visible;
4. rollback = restore the patch file and restart.

Connections are untouched either way: `dsh-mcp-manager` / `dsh-mcp-client`
keep registering the tools, so disabling the lazy *manager* does not disconnect
anything. The full runbook — rollout order, pin migration, fail-open and
rollback — is in [`docs/MIGRATION.md`](docs/MIGRATION.md).

## Configuration

`$DSH_HOME/mcp-session.json` (hot-reloaded by mtime); the cordis row's `config`
wins over the file.

```json
{
  "defaultPolicy": "lazy",
  "keywordReveal": true,
  "proxyTool": true,
  "catalog": true,
  "hintScan": { "maxServers": 3 },
  "servers": {
    "amap":        { "label": "高德地图", "hints": ["高德", "地图", "导航", "地址", "位置", "路线", "天气", "周边"] },
    "xiaohongshu": { "label": "小红书",   "hints": ["小红书", "笔记", "攻略", "种草"] }
  },
  "pins": { "default": [], "byWorkspace": { "/home/me/travel": ["amap"] } }
}
```

| Field | Default | Meaning |
|---|---|---|
| `defaultPolicy` | `lazy` | `lazy` hides every MCP tool; `eager` hides nothing (the plugin then only provides the session tools). |
| `keywordReveal` | `true` | Reveal matched servers for the current turn. |
| `proxyTool` | `true` | Register the **five** helper tools (`mcp_call` / `mcp_pin` / `mcp_unpin` / `mcp_pins` / `mcp_status`) in every agent's own layer. `false` releases **all five, `mcp_status` included** — the plugin then only hides the default surface, reveals by keyword and renders the catalog, so there is never a half-gated surface whose self-check contradicts the facts. Hot-reloaded: `mcp-session.json` is watched (directory watcher + a 1 s poll safety net) and any change is re-applied to **every live agent** without waiting for a dispatch or an assembly. The catalog section is rendered **against the facts**, so with `false` it never names a released tool. |
| `catalog` | `true` | Inject the compact catalog section. |
| `hintScan.maxServers` | `3` | Cap on servers revealed by one turn. Matches are ranked by **hint quality** (configured before derived, longer before shorter) and only then by text position, so a derived token that happens to appear early cannot take an explicitly configured server's slot. Whatever the cap drops is reported in the catalog section and by `mcp_status()`. |
| `servers.<name>.label` | – | Alias used in the catalog. |
| `servers.<name>.hints` | derived | Substrings that reveal the server. An unconfigured server derives hints from its **server name and tool names only** — never from tool descriptions, which are prose ("Search for a place by address…") whose words would otherwise reveal unrelated servers on any English sentence. Derived tokens must be at least 4 characters, are split on `_`/`-`/`.`/camelCase, and drop a built-in English stopword list (function words **and** generic verbs/nouns: `for`/`the`/`search`/`get`/`read`/`list`/`send`/`create`/`status`/`data`…). A server whose vocabulary is genuinely prose must be configured explicitly. |
| `pins.default` | `[]` | Servers every NEW root session starts pinned to. |
| `pins.byWorkspace` | `{}` | Session cwd prefix → servers pinned by default there. |

### Ledger hygiene

`mcp_status()` / `mcp_pins()` report **per agent**, and never claim a server the
registry no longer has: when a server disappears, it leaves the `visible` /
`revealed` / `truncated` sets immediately. A `pinned` entry is durable intent and
is deliberately kept, but shown as *“常驻但当前未注册(不重连不生效)”* and restored
automatically when the server comes back.

Truncation is reported twice on purpose: **per agent** (each agent's own turn,
same source as the assembly it just produced — so the ledger cannot contradict
the tool table) and once as an explicitly labelled **global union for overview**.

## The five tools

| Tool | Purpose |
|---|---|
| `mcp_pin(server)` | Keep a server resident in this session (multi-select). Effective from the next step. |
| `mcp_unpin(server)` | Release a pin. Also withdraws an inherited parent pin from live descendants. |
| `mcp_pins()` | Pinned / revealed / inherited / currently visible servers. |
| `mcp_status()` | Full diagnostics: every registered server, its tool count, every live agent's ledger (visible / pinned / revealed / truncated, helper registration state). Helper healing is **entry-point driven and per agent**: a failed registration is retried at that agent's own next tool call or assembly, so reading another agent's status will not heal it. |
| `mcp_call(server, tool, arguments)` | Reveal + dispatch one native MCP tool in a single call. |

## How it works

1. **Registry observation** — the global `mcp__<server>__<tool>` surface is
   mirrored from `ctx.tools.schemas()` / `ctx.tools.get()` and re-scanned on
   `tools/change`, so a server connecting later is picked up and a reconnect
   (fresh definition objects) rebuilds every shadow.
2. **Per-agent state** — `agent/created` (which fires for subagents too)
   installs one state record: pins, this turn's reveals, shadow registrations.
3. **Visibility control** — `restrict({ deny: [every mcp__* name] })` in the
   agent's scope hides the default surface; *revealing* means registering the
   server's real definition into **that agent's own layer**, which shadows the
   global tool and is exempt from every ancestor restriction. Both directions
   are per-agent, so restrictions never leak upward.
4. **Triggers** — a keyword hit on the turn's claimed user text, an explicit
   pin, `mcp_call`, and a delegation-prompt hint (for `subagent`,
   `subagent_fork`, `workflow`, `ralph`).
5. **Prompt layer** — a `systemPrompt.section` resolved per scope renders the
   catalog with the calling session's pin state.

Anything that can fail degrades open: if `restrict` throws, nothing is hidden
and `mcp_status()` reports the fail-open state.

### Subagent semantics (design §2.5.4)

A parent's `restrict()` does **not** reach a subagent: a real child's scope
parent is the parent's *agent-preset standing mount*, not the parent agent — and
with no preset it has no parent scope at all. So a subagent is not "narrowed by
its parent"; it was simply **never restricted**, and would otherwise see every
`mcp__*` tool. That is the biggest hole in a zero-cost promise, and closing it
is explicit work:

1. **Per-agent materialization** — `agent/created` fires for subagents too, and
   the plugin installs `restrict({ deny: [every mcp__* name] })` and its own
   helper tools into *that agent's own layer*, for every agent.
2. **Pins are materialized, not inherited** — a new agent is given the session's
   pin set explicitly (the child's `session.header.parentSession` links it), and
   `mcp_unpin` re-applies to **every live agent**, including already-running
   children (parent-scope shadow inheritance is a creation-time snapshot).
3. **The helper tools live in agent layers only** — never in the plugin's
   global layer, because only an own-layer registration is exempt from ancestor
   restrictions (an allow-filter composition would otherwise hide the plugin's
   own escape hatch).
4. All of the above happens in the **synchronous** part of the `agent/created`
   handler: a listener's returned promise is not awaited, so any `await` before
   it would let the agent's first assembly race ahead.

### Trigger timing note (deviation from the design draft)

The design's §2.5.3 proposed doing the reveal inside the per-agent
`systemPrompt.tools(provider)` hook. That hook cannot deliver the tool to the
assembly it runs for: `dsh-tools` registers its own tool provider when the
service is constructed (before any plugin), and assembly collects every
provider's schemas *before* invoking the next provider. A registration made
inside a later provider therefore lands in the **next** assembly only — the
model would need one extra round trip in exactly the case the feature exists to
avoid. `harness/verify` step **S11** reproduces this ordering with evidence.

The implementation therefore reveals on **`agent/inbox/claimed`**, which the
agent loop emits synchronously *before* `systemPrompt.assemble()`, and keeps
the provider hook as an idempotent safety net (pins, reconnects). The
architecture is unchanged: same per-agent scoped shadow mechanism, same module
split; only the trigger point moved — which is what the design's own Q3
question ("a time point earlier than tool-surface assembly") asks for.

**Undocumented coupling (accepted risk).** Keyword reveal reads the
`agent/inbox/claimed` payload as `{ agent, message, turn }` and takes the text
blocks of `message.content`. That event is an existing extension point used by
first-party code (`dsh-acp`, `dsh-goal-round-driver`, `dsh-subagent`), but DSH
does not document it as a stable plugin contract. **Applicable versions:** the
shape was verified against DSH `0.1.5-rc.1` (`dsh --version`) on the
`0.1.5-rc.2` package line, which is what `engines.dsh: ">=0.1.5-rc.1"` covers;
it is *not* covered by a compatibility guarantee, so a future release that
changes the event may need a plugin update. If a future release changes
its shape, the plugin degrades **quietly rather than dangerously**: the handler
is total (it guards on `agent`, and matching an empty text simply reveals
nothing), so a missing field disables keyword reveal for that turn while
`mcp_pin` / `mcp_call` / the catalog keep working, and the failure path is
logged rather than thrown. Nothing else in the plugin depends on undocumented
internals.

## Verification harness

`harness/` runs the plugin inside a **throwaway** DSH home — one per member,
never the live `~/.dsh`, never port 3080 — with a fake MCP surface and **without
any model call**:

```sh
cd plugins/dsh-mcp-session
pnpm build                                                    # or: tsc -p tsconfig.json
DSH_HOME=/tmp/ms-eng-scratch bash harness/install-scratch.sh  # bootstrap the host + link the plugin
bash harness/run-smoke.sh                                     # 85 assertions, zero model calls
bash harness/mutate-and-check.sh                              # anti-vacuity: 6/6 mutations, in a private copy
```

`install-scratch.sh` calls the standalone `harness/bootstrap-profile.sh`, which
creates the profile skeleton, repairs the module farm and proves the profile
composes — a wiped `/tmp` (or a fresh machine) therefore needs **no manual
steps**; re-running either script is the recovery procedure. The independent
V1–V8 matrix lives in `verification/` (owned by the verifier), whose
`install-verify.sh` installs the plugin + probes into the throwaway profile
`vtest`.

### Reproducing the artifact identity

The identity of this plugin is **one** number over `src/` **and** `lib/`, taken
from the plugin root with **relative** paths:

```sh
cd plugins/dsh-mcp-session
find src lib -type f | sort | xargs sha256sum | sha256sum                 # canonical (64 hex)
find src lib -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum   # NUL-safe, same value
```

That is *hash every file, sort the `<hash>  <path>` lines, then hash that text* —
**not** `cat lib/*.js | sha256sum` (a different value), never with absolute
paths, and never with `sort` omitted. The `cwd` is part of the recipe: the same
tree hashed from another directory is a different string. `lib/**/*.js.map` is
inside the digest and a source map records its output path, so the tree must be
built with this repository's `tsconfig.json` (`outDir: lib`). The published
build is reproducible: `tsc -p tsconfig.json` in a fresh copy of this repo
reproduces **every** file in `lib/` byte-for-byte. `lib/index.js` alone (a small
wiring wrapper) is *not* an identity.

### Certification run template

A run that claims to judge a revision records all of:

```json
{
  "DSH_HOME": "/tmp/<member>-scratch",
  "mcpSessionConfigSha256": "<sha256 of $DSH_HOME/mcp-session.json>",
  "canonical": "<64 hex over src+lib, command and cwd as above>",
  "driver": "<driver id + sha256, e.g. dsh-ms-verify@r4 (agent/request parked)>",
  "consecutiveRuns": ["85/0", "85/0"]
}
```

It counts only if `canonical` is identical **before and after** the run
(hash-stable) and the home was installed through the scripts above: a profile
left over from an older probe copy silently changes results, which is exactly
why `verification/install-verify.sh` must be run before any hand-run `dsh`
(`verification/run-all.sh` does it first, then the hash-stable certification).

## Credits & scope

This is a **self-contained implementation, not a fork**. It was inspired by —
and is a deliberate contrast to — [`mcp-lazy`
(leaforbook/dsh-mcp-lazy)](https://github.com/leaforbook/dsh-mcp-lazy),
especially its issue #1 "explicit server residency" semantics: `dsh-mcp-lazy`
keeps one selected server per agent and clears it every turn, while this plugin
keeps a per-session **set**, reveals it at claim time so the tool table already
contains it, and lets each subagent acquire servers on its own. No code was
copied; the shared vocabulary is the DSH cordis plugin API (`tools.restrict`,
scoped `tools.register`, `systemPrompt`) documented by DSH itself.

## License

MIT
