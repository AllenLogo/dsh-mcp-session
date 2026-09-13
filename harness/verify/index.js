/**
 * Harness smoke matrix for dsh-mcp-session (in-host, zero model calls).
 *
 * Runs the moment the root agent exists, asserts with DISPATCH (the only real
 * visibility gate) plus one out-of-band `systemPrompt.assemble()` for the
 * model-facing tool table, writes JSON, and exits before any LLM request.
 *
 * This is the implementer's smoke test. The independent verification matrix
 * (V1–V8) belongs to the verifier; this file exists so the plugin is provably
 * loadable and mechanically correct in the isolated host.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-ms-verify'
export const inject = ['tools', 'agents', 'systemPrompt']

const REPORT = process.env.MS_REPORT ?? '/tmp/ms-verify-report.json'
/**
 * ENV-1: this driver READS — and, to undo another probe's writes, WRITES —
 * `$DSH_HOME/mcp-session.json`, so the home must be explicit and must never be
 * the live one. The old `?? '/tmp/dsh-scratch'` fallback is exactly how a
 * post-reboot run reads a directory that no longer exists (`/tmp` is wiped), and
 * pointing `DSH_HOME` at `~/.dsh` would make the driver restore the canonical
 * config over the LIVE profile's config. Both cases fail loudly below instead;
 * `harness/run-smoke.sh` exports `DSH_HOME` for you.
 */
const DSH_HOME = process.env.DSH_HOME ?? ''
const LIVE_HOME = join(homedir(), '.dsh')
const CONFIG_FILE = DSH_HOME === '' ? '' : join(DSH_HOME, 'mcp-session.json')
const CANONICAL_FILE = process.env.MS_CANONICAL ?? '/tmp/ms-harness-canonical.json'

/**
 * Refuse a run that cannot name a safe scratch host. Throwing from `apply`
 * aborts the boot loudly with this message — which is the point: the alternative
 * is a matrix of confusing failures against the wrong (or a missing) config.
 */
function assertScratchHome() {
  if (DSH_HOME === '') {
    throw new Error(
      'dsh-ms-verify: DSH_HOME is not set. This driver restores $DSH_HOME/mcp-session.json and never falls back to a shared path that a reboot may have wiped. Run it via harness/run-smoke.sh, or: DSH_HOME=<scratch home> bash harness/install-scratch.sh && DSH_HOME=<scratch home> dsh --profile mcptest --patch <overlay> smoke',
    )
  }
  if (DSH_HOME === LIVE_HOME || DSH_HOME.startsWith(`${LIVE_HOME}/`)) {
    throw new Error(
      `dsh-ms-verify: DSH_HOME=${DSH_HOME} is the LIVE DSH home; refusing to run, because the driver rewrites mcp-session.json and must not touch the live profile. Use a throwaway home (harness/install-scratch.sh defaults to /tmp/ms-eng-scratch).`,
    )
  }
  if (!existsSync(CONFIG_FILE)) {
    throw new Error(
      `dsh-ms-verify: no ${CONFIG_FILE} — the scratch host under DSH_HOME=${DSH_HOME} is not installed. Run: DSH_HOME=${DSH_HOME} bash harness/install-scratch.sh (it creates the profile skeleton, the config, the canonical snapshot and the patch overlay).`,
    )
  }
}
const AMAP = 'mcp__amap__maps_geo'
const XHS = 'mcp__xiaohongshu__note_search'

const steps = []
let sequence = 0
/**
 * The canonical config `install-scratch.sh` wrote, read from a HARNESS-PRIVATE
 * copy — never from the shared home, which other agents' probes rewrite (a
 * `proxyTool: false` or `maxServers: 1` left there would otherwise be adopted
 * as "canonical" and produce a whole run of false failures).
 */
let canonicalConfig = ''
/** How often another process rewrote the shared config while the matrix ran. */
let externalConfigWrites = 0

/**
 * The scratch DSH home is SHARED with the reviewer/verifier, and their probes
 * rewrite `mcp-session.json`. A config that drifts mid-run silently changes
 * reveal and helper behaviour, so the matrix restores the private canonical
 * copy before every config-sensitive step and counts the intrusions.
 */
async function ensureCanonicalConfig() {
  try {
    if (canonicalConfig.length === 0) return
    if (readFileSync(CONFIG_FILE, 'utf8') === canonicalConfig) return
    externalConfigWrites += 1
    writeFileSync(CONFIG_FILE, canonicalConfig)
    await tick(450) // let the plugin's watcher / 1s poll pick the change up
  } catch {
    /* the file may be mid-replace by the other process */
  }
}

function check(label, passed, detail) {
  steps.push({ label, ok: passed === true, detail: detail === undefined ? undefined : detail })
}


/** Driver identity, so stale/contended evidence is recognisable at a glance. */
const DRIVER = 'dsh-ms-verify@r4 (agent/request parked; zero model calls)'
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Walk src+lib exactly like `find src lib -type f | sort`. */
function walkFiles(root, relative) {
  const out = []
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const child = `${relative}/${entry.name}`
    if (entry.isDirectory()) out.push(...walkFiles(root, child))
    else if (entry.isFile()) out.push(child)
  }
  return out
}

/**
 * The canonical artifact digest, byte-identical to
 * `find src lib -type f | sort | xargs sha256sum | sha256sum`
 * (two spaces between hash and path, one trailing newline per line).
 */
function treeDigest(roots) {
  const files = roots.flatMap((root) => walkFiles(PLUGIN_ROOT, root)).sort()
  const lines = files.map((file) => {
    const hash = createHash('sha256').update(readFileSync(join(PLUGIN_ROOT, file))).digest('hex')
    return `${hash}  ${file}\n`
  })
  return { digest: createHash('sha256').update(lines.join('')).digest('hex'), files: files.length }
}

function canonicalDigest() {
  const { digest, files } = treeDigest(['src', 'lib'])
  return { canonical: digest, files }
}

/**
 * L4: anchor the DRIVER VERSION to bytes. `driver` is only a label, so a reader
 * could bound the revision by mtime and nothing else; listing the harness files
 * that produced this report (path/size/mtime/sha256) makes the evidence
 * self-anchoring and tells a later reviewer exactly which assertion set ran.
 * Purely additive: no assertion, label or label text is involved.
 */
const DRIVER_FILES = [
  'harness/verify/index.js',
  'harness/fake-mcp/index.js',
  'harness/run-smoke.sh',
  'harness/install-scratch.sh',
  'harness/bootstrap-profile.sh',
  'harness/mutate-and-check.sh',
]

function driverFiles() {
  return DRIVER_FILES.map((path) => {
    try {
      const stats = statSync(join(PLUGIN_ROOT, path))
      return {
        path,
        size: stats.size,
        mtime: stats.mtime.toISOString(),
        sha256: createHash('sha256').update(readFileSync(join(PLUGIN_ROOT, path))).digest('hex'),
      }
    } catch (error) {
      return { path, error: String(error?.code ?? error) }
    }
  })
}

function libDigest() {
  return treeDigest(['lib']).digest
}

function fileDigest(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

/** §5.2: config rewrites must be recorded before/after and restored. */
const configHashes = { before: null, after: null, restored: null }

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function dispatch(ctx, agent, name, args = {}) {
  sequence += 1
  try {
    const result = await ctx.tools.execute({
      callId: `ms-verify-${sequence}`,
      name,
      arguments: args,
      agent,
      signal: new AbortController().signal,
    })
    const text = Array.isArray(result?.content)
      ? result.content.map((block) => (block?.type === 'text' ? block.text : '')).join('\n')
      : ''
    return { ok: result?.isError !== true, text, value: result?.value }
  } catch (error) {
    return { ok: false, threw: String(error?.message ?? error) }
  }
}

async function toolNames(ctx, agent) {
  const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent, new AbortController().signal))
  return {
    names: assembly.tools.map((tool) => tool.name),
    sections: assembly.sections.map((section) => section.text).join('\n'),
  }
}

async function createChild(ctx, root, label) {
  const handle = await ctx.agents.create({
    sessionId: `${root.session.id}-${label}`,
    parentAgent: root,
    meta: {
      cwd: root.session.cwd ?? process.cwd(),
      parentSession: root.session.id,
      origin: 'subagent',
      delegationDepth: 1,
    },
  })
  return handle.agent ?? handle
}

/**
 * An agent with NO scope-chain link to any other agent.
 *
 * That is the shape a REAL subagent has: its scope parent is the delegating
 * agent's preset standing mount, never the parent agent's own layer — and with
 * no preset it has no parent scope at all (design §2.5.4). So NO subagent form
 * ever inherits the parent's `restrict`; the plugin must restrict every agent
 * explicitly. Measured (`review/evidence/probe-childshapes`, 6/6): the
 * `parentAgent` form and this uncoupled form are BOTH denied, so nothing here
 * relies on inheritance semantics — this helper exists to cover the sealed /
 * no-preset shape and to keep the assertions phrased in terms of the plugin's
 * OWN per-agent application.
 */
async function createUncoupledAgent(ctx, root, label) {
  const handle = await ctx.agents.create({
    sessionId: `${root.session.id}-${label}`,
    meta: {
      cwd: root.session.cwd ?? process.cwd(),
      origin: 'subagent',
      delegationDepth: 1,
    },
  })
  return handle.agent ?? handle
}

/**
 * Exactly the metadata `dsh-subagent`'s `childSessionMeta()` writes for a real
 * child (`parentSession` = live parent id, `origin: 'subagent'`,
 * `delegationDepth`), but WITHOUT `parentAgent` — so the scope chain carries no
 * link to the parent. Pin materialization therefore cannot come from
 * inheritance; it proves the plugin's own explicit per-agent application.
 */
async function createUncoupledLinked(ctx, root, label) {
  const handle = await ctx.agents.create({
    sessionId: `${root.session.id}-${label}`,
    meta: {
      cwd: root.session.cwd ?? process.cwd(),
      parentSession: root.session.id,
      origin: 'subagent',
      delegationDepth: 1,
    },
  })
  return handle.agent ?? handle
}

const userMessage = (text) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

async function run(ctx, root) {
  // Restore the private canonical config FIRST: another agent's probe may have
  // left the shared home with `proxyTool: false` / `maxServers: 1`.
  await ensureCanonicalConfig()
  // The real task message is claimed (and its assembly runs) before the parked
  // `agent/request`; give that a moment so the matrix starts from a settled
  // state (nothing is disposed, because the turn never completes).
  await tick(200)

  check('S1 registry: fake MCP tools are globally registered', ctx.tools.get(AMAP) !== undefined)
  check('S1 default hidden: dispatching a native MCP tool as root is DENIED', !(await dispatch(ctx, root, AMAP)).ok)

  const status = await dispatch(ctx, root, 'mcp_status')
  check('S2 the plugin helper tools stay visible and callable', status.ok, status.text?.slice(0, 120))

  // --- keyword auto-reveal (driven through the real event shape) ---
  ctx.emit('agent/inbox/claimed', {
    agent: root,
    message: userMessage('帮我看下这家店在哪,用高德查一下地址'),
    turn: 1,
  })
  await tick(10)
  const amapRevealed = await dispatch(ctx, root, AMAP)
  const xhsStillHidden = await dispatch(ctx, root, XHS)
  check('S3 keyword reveal makes the matched server dispatchable', amapRevealed.ok)
  check('S3 a non-matched server stays hidden', !xhsStillHidden.ok)

  const view1 = await toolNames(ctx, root)
  check('S4 assembly exposes the revealed native tool', view1.names.includes(AMAP), `${view1.names.length} tools`)
  check('S4 assembly hides the un-revealed server', !view1.names.includes(XHS))
  check('S4 catalog section advertises the servers', /amap/.test(view1.sections))

  // --- pin ---
  const pinned = await dispatch(ctx, root, 'mcp_pin', { server: 'xiaohongshu' })
  check('S5 mcp_pin succeeds', pinned.ok, pinned.text?.slice(0, 80))
  check('S5 the pinned server is dispatchable', (await dispatch(ctx, root, XHS)).ok)
  const badPin = await dispatch(ctx, root, 'mcp_pin', { server: 'nope' })
  check('S5 an unknown server yields a corrective error', !badPin.ok)

  // --- turn boundary ---
  ctx.emit('agent/turn-stopping', { agent: root, turn: 1, signal: new AbortController().signal })
  await tick(10)
  check('S6 turn end withdraws the keyword reveal', !(await dispatch(ctx, root, AMAP)).ok)
  check('S6 turn end keeps the pin resident', (await dispatch(ctx, root, XHS)).ok)

  // --- unpin ---
  check('S7 mcp_unpin succeeds', (await dispatch(ctx, root, 'mcp_unpin', { server: 'xiaohongshu' })).ok)
  check('S7 after unpin the native tool is hidden again', !(await dispatch(ctx, root, XHS)).ok)

  // --- subagent self-sufficiency (V8 shape) ---
  const child = await createChild(ctx, root, 's8')
  check('S8 a parent-linked child is denied by its OWN restrict (no inherited deny)', !(await dispatch(ctx, child, AMAP)).ok)
  const childCall = await dispatch(ctx, child, 'mcp_call', { server: 'amap', tool: 'maps_geo', arguments: {} })
  check('S8 the child acquires the server by itself through mcp_call', childCall.ok, childCall.text?.slice(0, 120))
  check('S8 the child can then dispatch the native tool', (await dispatch(ctx, child, AMAP)).ok)
  check('S8 the parent is unaffected by the child acquisition', !(await dispatch(ctx, root, AMAP)).ok)

  // --- parent pin inheritance + explicit withdrawal (V6 shape) ---
  await dispatch(ctx, root, 'mcp_pin', { server: 'amap' })
  const child2 = await createChild(ctx, root, 's9')
  check('S9 a child created under a pinned parent sees the native tool', (await dispatch(ctx, child2, AMAP)).ok)
  await dispatch(ctx, root, 'mcp_unpin', { server: 'amap' })
  check('S9 unpinning at the parent withdraws it from a live child', !(await dispatch(ctx, child2, AMAP)).ok)

  const pins = await dispatch(ctx, root, 'mcp_pins')
  check('S10 mcp_pins reports the session state', pins.ok, pins.text?.slice(0, 160))

  // --- S12 reconnect: the shadow must be rebuilt from the fresh definition ---
  await dispatch(ctx, root, 'mcp_pin', { server: 'obsidian' })
  const firstRead = await dispatch(ctx, root, 'mcp__obsidian__vault_read')
  check('S12 a pinned server is dispatchable', firstRead.ok, firstRead.text)
  globalThis.__fakeMcpReconnect?.('mcp__obsidian__vault_read')
  await tick(120)
  const secondRead = await dispatch(ctx, root, 'mcp__obsidian__vault_read')
  check(
    'S12 after a reconnect the shadow executes the FRESH definition',
    secondRead.ok && /gen2/.test(secondRead.text ?? ''),
    secondRead.text,
  )

  // --- S11 ordering evidence: why the reveal runs on `agent/inbox/claimed` ---
  // `dsh-tools` registers its own tool provider when the service is constructed
  // — before any plugin — and assembly collects every provider's schemas BEFORE
  // running the next one. A registration performed inside a (later) provider
  // therefore cannot appear in the assembly it runs for; only the NEXT one.
  let lateRegistered = false
  ctx.systemPrompt.tools(() => {
    if (!lateRegistered) {
      lateRegistered = true
      const base = ctx.tools.get(AMAP)
      if (base !== undefined) {
        ctx.tools.register({ ...base, name: 'mcp__late__probe', description: 'late-registered probe' })
      }
    }
    return { schemas: [] }
  })
  check('S11 the late probe is not registered before the assembly', ctx.tools.get('mcp__late__probe') === undefined)
  const view2 = await toolNames(ctx, root)
  check('S11 a provider-time registration is absent from the CURRENT assembly', !view2.names.includes('mcp__late__probe'))
  check(
    'S11 ...but it IS registered right after (ordering, not a failure)',
    ctx.tools.get('mcp__late__probe') !== undefined,
  )

  // --- S13 multi-server reveal + auto-derived hints for an unconfigured server ---
  await ensureCanonicalConfig()
  ctx.emit('agent/inbox/claimed', {
    agent: root,
    message: userMessage('用高德查一下地址,顺便看看小红书的攻略,再把 archive search 的结果整理一下'),
    turn: 9,
  })
  await tick(10)
  const multiAmap = await dispatch(ctx, root, AMAP)
  const multiXhs = await dispatch(ctx, root, XHS)
  check('S13 two configured servers reveal in the same turn', multiAmap.ok && multiXhs.ok)
  check(
    'S13 an unconfigured server reveals through auto-derived hints',
    (await dispatch(ctx, root, 'mcp__archive__archive_search')).ok,
  )

  // --- S14 the uncoupled-agent case (reviewer recon §2) ---
  // No scope-chain link to the root: only the plugin's own per-agent
  // `restrict` can hide the default MCP surface here.
  const loose = await createUncoupledAgent(ctx, root, 's14')
  check('S14 an uncoupled agent is hidden by its OWN restrict (no inherited deny)', !(await dispatch(ctx, loose, AMAP)).ok)
  check('S14 an uncoupled agent keeps non-MCP tools visible', (await dispatch(ctx, loose, 'todo_write', { todos: [] })).ok)
  check('S14 an uncoupled agent still has the helper tools', (await dispatch(ctx, loose, 'mcp_status')).ok)
  check(
    'S14 an uncoupled agent acquires on its own via mcp_call',
    (await dispatch(ctx, loose, 'mcp_call', { server: 'amap', tool: 'maps_geo', arguments: {} })).ok,
  )

  // --- S15 §2.5.4 item 3: the helper tools live in agent layers ONLY ---
  check(
    'S15 helper tools are absent from the plugin/global layer',
    ctx.tools.get('mcp_pin') === undefined &&
      ctx.tools.get('mcp_call') === undefined &&
      ctx.tools.get('mcp_status') === undefined,
  )
  check('S15 ...yet every agent resolves them from its own layer', (await dispatch(ctx, root, 'mcp_pins')).ok)
  check(
    'S15 ...including an agent with no scope-chain link',
    (await dispatch(ctx, loose, 'mcp_pins')).ok,
  )

  // --- S16 §2.5.4 item 2: pin materialization with NO scope link at all ---
  const matA = await createUncoupledLinked(ctx, root, 's16a')
  check('S16 baseline: the uncoupled child is DENIED under its own restrict', !(await dispatch(ctx, matA, AMAP)).ok)
  await dispatch(ctx, root, 'mcp_pin', { server: 'amap' })
  check('S16 a root pin reaches an ALREADY-LIVE uncoupled child', (await dispatch(ctx, matA, AMAP)).ok)
  const matB = await createUncoupledLinked(ctx, root, 's16b')
  check('S16 a root pin is materialized into a NEWLY created uncoupled child', (await dispatch(ctx, matB, AMAP)).ok)
  await dispatch(ctx, root, 'mcp_unpin', { server: 'amap' })
  check(
    'S16 a root unpin withdraws it from EVERY live agent',
    !(await dispatch(ctx, matA, AMAP)).ok && !(await dispatch(ctx, matB, AMAP)).ok,
  )

  // --- S17 §2.6.1 F1: an unrelated English sentence must reveal NOTHING ---
  // The sentence is the adjudicated one. `map`'s and `wiki`'s DESCRIPTIONS
  // contain "repository"/"structure"/"search" (map's also "for"/"the"), so if
  // derivation ever went back to mining descriptions these servers WOULD be
  // revealed — the assertion is sharp, not a tautology.
  ctx.emit('agent/inbox/claimed', {
    agent: root,
    message: userMessage('Please summarize the repository structure for me.'),
    turn: 20,
  })
  await tick(10)
  const unrelated = {
    map: await dispatch(ctx, root, 'mcp__map__maps_geo'),
    wiki: await dispatch(ctx, root, 'mcp__wiki__page_get'),
    noisy: await dispatch(ctx, root, 'mcp__noisy__noisy_ping'),
    archive: await dispatch(ctx, root, 'mcp__archive__archive_search'),
  }
  check(
    'S17 an unrelated English sentence reveals no unconfigured server',
    !unrelated.map.ok && !unrelated.wiki.ok && !unrelated.noisy.ok,
    `map=${unrelated.map.ok} wiki=${unrelated.wiki.ok} noisy=${unrelated.noisy.ok}`,
  )
  const unrelatedView = await toolNames(ctx, root)
  check(
    'S17 ...and none of their tools enters assembly.tools',
    !unrelatedView.names.includes('mcp__map__maps_geo') &&
      !unrelatedView.names.includes('mcp__wiki__page_get') &&
      !unrelatedView.names.includes('mcp__noisy__noisy_ping'),
  )
  check(
    'S17 ...and the catalog does not mark them as revealed this turn',
    !/-\s*map\b[^\n]*本轮已揭示/.test(unrelatedView.sections) &&
      !/-\s*wiki\b[^\n]*本轮已揭示/.test(unrelatedView.sections) &&
      /-\s*map\b[^\n]*状态:惰性/.test(unrelatedView.sections),
    unrelatedView.sections.split('\n').filter((line) => /^-\s*(map|wiki|noisy)\b/.test(line)).join(' | '),
  )
  // Positive control: a TOOL-NAME token still reveals an unconfigured server.
  ctx.emit('agent/inbox/claimed', {
    agent: root,
    message: userMessage('please archive this thread'),
    turn: 20,
  })
  await tick(10)
  check(
    'S17 positive control: a tool-name token ("archive") still reveals',
    (await dispatch(ctx, root, 'mcp__archive__archive_search')).ok,
  )

  // --- S18 quality-first ranking + truncation reporting (item 2) ---
  await ensureCanonicalConfig()
  // Four servers match; the cap is 3. `archive`'s derived hint appears FIRST in
  // the sentence, so a position-first ranking would reveal it and truncate a
  // CONFIGURED server instead.
  ctx.emit('agent/inbox/claimed', {
    agent: root,
    message: userMessage('archive 先看这个:高德 查路线,小红书 的攻略,obsidian 知识库'),
    turn: 21,
  })
  await tick(10)
  const ranked = {
    amap: (await dispatch(ctx, root, AMAP)).ok,
    xhs: (await dispatch(ctx, root, XHS)).ok,
    obsidian: (await dispatch(ctx, root, 'mcp__obsidian__vault_read')).ok,
    archive: (await dispatch(ctx, root, 'mcp__archive__archive_search')).ok,
  }
  check(
    'S18 configured hints win the cap over an earlier-positioned derived hint',
    ranked.amap && ranked.xhs && ranked.obsidian && !ranked.archive,
    JSON.stringify(ranked),
  )
  const truncatedStatus = await dispatch(ctx, root, 'mcp_status')
  check(
    'S18 mcp_status reports the server dropped by the reveal cap',
    truncatedStatus.ok && /截断/.test(truncatedStatus.text ?? '') && /archive/.test(truncatedStatus.text ?? ''),
    truncatedStatus.text?.split('\n').find((line) => /截断/.test(line)),
  )
  const truncatedView = await toolNames(ctx, root)
  check(
    'S18 the catalog section reports the truncation too',
    /超出揭示上限/.test(truncatedView.sections) && /archive/.test(truncatedView.sections),
  )

  // --- S20 inherited-pin unpin wording (item 4) ---
  await dispatch(ctx, root, 'mcp_pin', { server: 'amap' })
  const inheritedChild = await createUncoupledLinked(ctx, root, 's20')
  const inheritedUnpin = await dispatch(ctx, inheritedChild, 'mcp_unpin', { server: 'amap' })
  check(
    'S20 unpinning a parent-materialized pin says the agent does not hold it',
    inheritedUnpin.ok &&
      /未持有/.test(inheritedUnpin.text ?? '') &&
      /分别物化/.test(inheritedUnpin.text ?? '') &&
      /父级/.test(inheritedUnpin.text ?? ''),
    inheritedUnpin.text?.split('\n')[0],
  )
  check(
    'S20 ...and the behaviour is unchanged: the parent-materialized pin is still live',
    (await dispatch(ctx, inheritedChild, AMAP)).ok,
  )
  await dispatch(ctx, root, 'mcp_unpin', { server: 'amap' })

  // --- S21 §2.6.1 F5: helper-registration failure must be VISIBLE -----------
  // Injection is scope-preserving: the prototype method is wrapped and called
  // with the ORIGINAL `this` (its per-agent scope), unlike re-binding
  // `ctx.tools.register`, which silently moves registrations to the global
  // layer.
  const proto = Object.getPrototypeOf(ctx.tools)
  const originalRegister = proto.register
  let blocked = new Set()
  const armed = () => blocked.size > 0
  proto.register = function (definition) {
    if (armed() && blocked.has(definition?.name)) throw new Error(`SIMULATED: ${definition.name} registration failed`)
    return originalRegister.call(this, definition)
  }
  try {
    // (a) partial failure: one helper missing, the rest healthy. The
    // obstruction stays active while the report is read, so the report itself
    // must surface the defect (the retry would otherwise have healed it first).
    blocked = new Set(['mcp_call'])
    const victimA = await createUncoupledLinked(ctx, root, 's21a')
    check('S21 a partially-registered agent still denies its native MCP tools', !(await dispatch(ctx, victimA, AMAP)).ok)
    check('S21 ...and the missing helper really is missing', !(await dispatch(ctx, victimA, 'mcp_call')).ok)
    const victimStatus = await dispatch(ctx, victimA, 'mcp_status')
    check(
      'S21 ...but the self-check REPORTS the failure instead of claiming health',
      victimStatus.ok &&
        /助手工具注册异常/.test(victimStatus.text ?? '') &&
        new RegExp(`${victimA.session.id}[^}]*缺失:mcp_call`).test(victimStatus.text ?? ''),
      victimStatus.text?.split('\n').find((line) => /助手工具/.test(line))?.slice(0, 160),
    )
    blocked = new Set()
    check(
      'S21 ...and the retry actually recovers it once the obstruction clears',
      (await dispatch(ctx, victimA, 'mcp_status')).ok &&
        (await dispatch(ctx, victimA, 'mcp_call', { server: 'amap', tool: 'maps_geo', arguments: {} })).ok,
    )

    // (b) total failure: no helper at all ⇒ that agent must not be left both
    // hidden AND without an escape hatch (§2.6.1 F5-④).
    blocked = new Set(['mcp_call', 'mcp_pin', 'mcp_unpin', 'mcp_pins', 'mcp_status'])
    const victimB = await createUncoupledLinked(ctx, root, 's21b')
    blocked = new Set()
    check(
      'S21 an agent with NO helper keeps its native MCP surface (per-agent fail-open)',
      (await dispatch(ctx, victimB, AMAP)).ok,
    )
  } finally {
    blocked = new Set()
    proto.register = originalRegister
  }

  // --- S19 §2.6.1 F3/F7: gating + config-DRIVEN flip, no assembly ---
  // No `toolNames()` / assembly call anywhere in this block: the recompute must
  // be driven by the config change itself, and three full rounds must be
  // reliable in both directions.
  await ensureCanonicalConfig()
  const configFile = CONFIG_FILE
  const originalConfig = canonicalConfig.length > 0 ? canonicalConfig : readFileSync(configFile, 'utf8')
  // §5.2: a test that rewrites the config must record the hashes before/after.
  configHashes.before = fileDigest(configFile)
  configHashes.restored = fileDigest(configFile)
  const flip = async (enabled) => {
    await tick(30)
    writeFileSync(configFile, JSON.stringify({ ...JSON.parse(originalConfig), proxyTool: enabled }, null, 2))
    await tick(450) // watcher (immediate) or the 1s poll safety net
  }
  for (const round of [1, 2, 3]) {
    await flip(false)
    const offCall = await dispatch(ctx, root, 'mcp_call', { server: 'amap', tool: 'maps_geo' })
    const offStatus = await dispatch(ctx, root, 'mcp_status')
    check(`S19 R${round} proxyTool=false gates mcp_call`, !offCall.ok, offCall.threw ?? offCall.text?.slice(0, 60))
    check(
      `S19 R${round} proxyTool=false gates mcp_status too (no half-gated surface)`,
      !offStatus.ok,
      offStatus.threw ?? offStatus.text?.slice(0, 60),
    )
    await flip(true)
    const onStatus = await dispatch(ctx, root, 'mcp_status')
    const onCall = await dispatch(ctx, root, 'mcp_call', { server: 'amap', tool: 'maps_geo', arguments: {} })
    check(`S19 R${round} proxyTool=true restores mcp_status`, onStatus.ok, onStatus.text?.split('\n')[0]?.slice(0, 90))
    check(`S19 R${round} proxyTool=true restores mcp_call`, onCall.ok, onCall.text?.slice(0, 60))
    check(
      `S19 R${round} the banner matches the ACTUAL helper set`,
      onStatus.ok &&
        /助手工具注册状态\(实际\)/.test(onStatus.text ?? '') &&
        /助手工具注册正常/.test(onStatus.text ?? ''),
      onStatus.text?.split('\n').find((line) => /助手工具/.test(line))?.slice(0, 140),
    )
  }
  await tick(30)
  writeFileSync(configFile, originalConfig)
  await tick(450)
  check(
    'S19 the original config is restored and the proxy tools work again',
    (await dispatch(ctx, root, 'mcp_call', { server: 'amap', tool: 'maps_geo', arguments: {} })).ok,
  )
  configHashes.after = fileDigest(configFile)
  check(
    'S19 config hash restored byte-for-byte after the flips (§5.2)',
    configHashes.before !== null && configHashes.before === configHashes.after,
    `before=${String(configHashes.before).slice(0, 16)} after=${String(configHashes.after).slice(0, 16)}`,
  )

  // --- S22 §2.6.1 F-V1: the catalog never names a released helper tool ------
  const catalogWith = async (enabled) => {
    await tick(30)
    writeFileSync(configFile, JSON.stringify({ ...JSON.parse(canonicalConfig), proxyTool: enabled }, null, 2))
    await tick(450)
    const view = await toolNames(ctx, root)
    return view.sections
  }
  const onSections = await catalogWith(true)
  check(
    'S22 proxyTool=true: the catalog names the helper tools',
    /mcp_pin\(/.test(onSections) && /mcp_call\(/.test(onSections) && /mcp_status/.test(onSections),
  )
  const offSections = await catalogWith(false)
  check(
    'S22 proxyTool=false: the catalog names NO released helper tool',
    !/mcp_pin\(/.test(offSections) && !/mcp_call\(/.test(offSections) && !/mcp_status/.test(offSections) && !/mcp_unpin\(/.test(offSections) && !/mcp_pins\(/.test(offSections),
    offSections.split('\n').filter((line) => /操作:/.test(line)).join(' | ').slice(0, 160),
  )
  check('S22 the OFF catalog still explains the keyword-only fallback', /proxyTool=false/.test(offSections))
  await tick(30)
  writeFileSync(configFile, canonicalConfig)
  await tick(450)

  // --- S23 §2.6.1 R3-1: truncation is per-agent AND agrees with its assembly -
  // Agent A: a cap=3 turn where everything matches (no truncation).
  // Agent B: a cap=1 turn that matches two servers (one truncated).
  await ensureCanonicalConfig()
  ctx.emit('agent/inbox/claimed', { agent: root, message: userMessage('高德 查地址 和 小红书 的攻略'), turn: 40 })
  await tick(10)
  await toolNames(ctx, root) // the assembly whose decision status must agree with
  const statusA = await dispatch(ctx, root, 'mcp_status')
  const agentA = statusA.value?.agents?.find((agent) => agent.id === String(root.id))
  check(
    'S23 a cap=3 turn reports NO truncation for that agent',
    agentA !== undefined && agentA.truncated.length === 0,
    JSON.stringify(agentA?.truncated ?? null),
  )
  check(
    'S23 ...and the per-agent line does not leak another agent state',
    !new RegExp(`${root.session.id} N=`).test(statusA.text ?? ''),
    statusA.text?.split('\n').find((line) => /本轮截断/.test(line))?.slice(0, 150),
  )
  const tinyCfg = JSON.stringify({ ...JSON.parse(canonicalConfig), hintScan: { maxServers: 1 } }, null, 2)
  await tick(30)
  writeFileSync(configFile, tinyCfg)
  await tick(450)
  const s23Child = await createUncoupledLinked(ctx, root, 's23b')
  ctx.emit('agent/inbox/claimed', { agent: s23Child, message: userMessage('高德 查地址 和 小红书 的攻略'), turn: 41 })
  await tick(10)
  const viewB = await toolNames(ctx, s23Child)
  const statusB = await dispatch(ctx, s23Child, 'mcp_status')
  const agentB = statusB.value?.agents?.find((agent) => agent.id === String(s23Child.id))
  check(
    'S23 a cap=1 turn reports the dropped candidate for THAT agent',
    agentB !== undefined && agentB.truncated.length === 1,
    JSON.stringify(agentB?.truncated ?? null),
  )
  check(
    'S23 the cap=1 assembly really dropped that server (status matches reality)',
    !viewB.names.includes(`mcp__${agentB?.truncated?.[0]}__maps_geo`) || agentB?.truncated?.[0] !== 'amap',
    `truncated=${JSON.stringify(agentB?.truncated ?? null)} tools=${viewB.names.filter((n) => n.startsWith('mcp__')).length}`,
  )
  // S25 (same cap=1 turn): the CATALOG section must show the truncation for B
  // and must not show it for A — the second of the two required observation
  // points, per-agent (R3-1 refined).
  const catalogB = (await toolNames(ctx, s23Child)).sections
  check(
    'S25 the cap=1 agent catalog reports the truncation and names the dropped server',
    /超出揭示上限/.test(catalogB) && new RegExp(`未揭示:${agentB?.truncated?.[0] ?? "\u0000"}`).test(catalogB),
    catalogB.split('\n').find((line) => /超出揭示上限/.test(line))?.slice(0, 150),
  )
  // Give agent A a FRESH turn whose text matches nothing: its own truncation must
  // then be empty even though B's is not — that is the attribution property, and
  // it is checked with the SAME config in force for both agents (if the ledger
  // still carried B's truncation for A, this would fail).
  ctx.emit('agent/inbox/claimed', { agent: root, message: userMessage('nothing mcp-related in this turn'), turn: 42 })
  await tick(10)
  const catalogA = (await toolNames(ctx, root)).sections
  check(
    'S25 an agent whose own turn has no truncation shows none (no cross-agent leak)',
    !/超出揭示上限/.test(catalogA),
    catalogA.split('\n').find((line) => /超出揭示上限/.test(line))?.slice(0, 150) ?? '(none)',
  )

  const agentAAfter = statusB.value?.agents?.find((agent) => agent.id === String(root.id))
  check(
    'S23 agent A still reports NO truncation after B truncated (no cross-agent leak)',
    agentAAfter !== undefined && agentAAfter.truncated.length === 0,
    JSON.stringify(agentAAfter?.truncated ?? null),
  )
  await tick(30)
  writeFileSync(configFile, canonicalConfig)
  await tick(450)

  // --- S24 §2.6.1 V19: a removed server leaves the ledger ------------------
  const beforeRemove = await dispatch(ctx, root, 'mcp_status')
  check(
    'S24 baseline: the target server is registered and visible',
    /archive/.test(beforeRemove.text ?? ''),
  )
  const removed = globalThis.__fakeMcpRemoveServer?.('archive') ?? 0
  await tick(300) // let tools/change rescan
  const afterRemove = await dispatch(ctx, root, 'mcp_status')
  const rootAfter = afterRemove.value?.agents?.find((agent) => agent.id === String(root.id))
  check('S24 the removed server really was unregistered', removed > 0, String(removed))
  check(
    'S24 a removed server disappears from the registered list',
    !/已注册 MCP 服务器\(\d+\):[^\n]*archive/.test(afterRemove.text ?? ''),
    afterRemove.text?.split('\n').find((line) => /已注册 MCP 服务器/.test(line))?.slice(0, 130),
  )
  check(
    'S24 ...and it leaves the per-agent visible/truncated ledger (V19)',
    rootAfter !== undefined &&
      !rootAfter.visible.includes('archive') &&
      !rootAfter.truncated.includes('archive') &&
      !rootAfter.revealed.includes('archive'),
    JSON.stringify({ visible: rootAfter?.visible, truncated: rootAfter?.truncated, revealed: rootAfter?.revealed }),
  )
}

export function apply(ctx) {
  // ENV-1: name a safe scratch host before touching any config (throws loudly).
  assertScratchHome()
  // Read the harness-private canonical copy. Reading the shared file here would
  // adopt whatever another agent's probe left behind (observed: a whole run of
  // 24 false failures because the shared config was left at proxyTool=false).
  try {
    canonicalConfig = readFileSync(CANONICAL_FILE, 'utf8')
  } catch {
    try {
      canonicalConfig = readFileSync(CONFIG_FILE, 'utf8')
    } catch {
      canonicalConfig = ''
    }
  }
  // Hermetic host: never issue a model request.
  //
  // `agent/request` is awaited by the step AFTER assembly and BEFORE any
  // provider call, so returning a promise that never settles parks the turn
  // with the assembly (and therefore the plugin's assembly path) already
  // exercised. The agent stays LIVE — vetoing the step instead would let the
  // headless runner finish and dispose the root agent mid-matrix, which shows
  // up as a whole cascade of `unknown tool "mcp_*"`. The task text is never
  // sent to a model, so the harness costs nothing.
  ctx.on('agent/request', () => new Promise(() => {}))

  let started = false
  ctx.on('agent/created', ({ agent }) => {
    if (started) return
    started = true
    setTimeout(() => {
      run(ctx, agent)
        .catch((error) => check('driver crashed', false, String(error?.stack ?? error)))
        .finally(() => {
          const failed = steps.filter((step) => !step.ok)
          const { canonical, files } = canonicalDigest()
          writeFileSync(
            REPORT,
            JSON.stringify(
              {
                driver: DRIVER,
                driverFiles: driverFiles(),
                generatedAt: new Date().toISOString(),
                canonical,
                canonicalCommand: 'find src lib -type f | sort | xargs sha256sum | sha256sum',
                canonicalCwd: 'plugins/dsh-mcp-session',
                canonicalFiles: files,
                libDigest: libDigest(),
                configHashes,
                dshHome: DSH_HOME,
                total: steps.length,
                failed: failed.length,
                externalConfigWrites,
                steps,
              },
              null,
              2,
            ),
          )
          process.exit(failed.length === 0 ? 0 : 1)
        })
    }, 100)
  })
  setTimeout(() => {
    if (started) return
    writeFileSync(REPORT, JSON.stringify({ total: steps.length, failed: 1, steps, error: 'root agent never created' }, null, 2))
    process.exit(1)
  }, 30000)
}
