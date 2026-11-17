/**
 * nyaterm-bridge — run AI commands inside NyaTerm terminal sessions, gated by a
 * per-workspace allowlist over NyaTerm groups and hosts.
 *
 * WHY THIS PLUGIN OWNS THE MCP CONNECTION
 * ---------------------------------------
 * NyaTerm ships an MCP bridge (`nyaterm-mcp`) in front of its own MCP server.
 * Mounting that bridge through `@deepseek-ai/dsh-mcp-client` would register its
 * raw tools as `mcp__nyaterm__*` directly on `ctx.tools`, where the model can
 * call them without passing any workspace check. Plan A therefore does NOT use
 * the generic MCP client: this plugin speaks MCP to the bridge itself and
 * registers only the gated `nt_*` tools below. The raw tools never enter the
 * tool registry, so there is no bypass surface to defend.
 *
 * Enforcement is defence-in-depth:
 *   1. every tool body resolves the calling session's cwd and checks the
 *      target connection against the allowlist (primary, awaited);
 *   2. a global `ctx.tools.guard()` registers a monotonic synchronous denial
 *      for the same calls, which no later listener can turn back into
 *      permission (backstop).
 *
 * The allowlist itself lives in a workspace-owned store file rather than in the
 * profile patch, so the plugin can keep it in sync with NyaTerm without asking
 * the user to hand-edit profile configuration.
 *
 * WIRE SCHEMAS ARE CHECKED AT LOAD TIME
 * -------------------------------------
 * The provider forwards each tool's `parameters` verbatim, so a schema that is
 * not object-rooted fails every request that names the tool — the whole
 * conversation, not one tool call. Every tool is therefore registered through a
 * local seam that validates the schema first, which turns such a regression into
 * a visible plugin-load failure instead of a stream of opaque provider errors.
 */

import {
  accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Locating the NyaTerm MCP bridge and its discovery document
// ---------------------------------------------------------------------------

/**
 * Candidate bridge executables per platform, in preference order.
 *
 * NyaTerm ships `nyaterm-mcp` beside the app (a helper binary, not an npm
 * package), so the location follows each platform's install convention. These
 * lists are best-effort discovery only: `bridgeExecutable` in the plugin config
 * or in the saved settings wins, and a PATH lookup is the last resort, because
 * the exact install path differs between stable/Preview builds, between
 * installer formats (AppImage mounts under a per-run directory, for instance),
 * and — on Windows — between users (`%LOCALAPPDATA%\Programs\NyaTerm`, which is
 * why the settings page can override it).
 */
const BRIDGE_CANDIDATES = process.platform === 'darwin'
  ? [
    // Stable builds first, in every install location, then Preview builds.
    '/Applications/NyaTerm.app/Contents/MacOS/nyaterm-mcp',
    // A per-user install (no admin rights) lands here instead of /Applications.
    path.join(homedir(), 'Applications', 'NyaTerm.app', 'Contents', 'MacOS', 'nyaterm-mcp'),
    '/Applications/NyaTerm Preview.app/Contents/MacOS/nyaterm-mcp',
    path.join(homedir(), 'Applications', 'NyaTerm Preview.app', 'Contents', 'MacOS', 'nyaterm-mcp'),
  ]
  : process.platform === 'win32'
    ? [
      // A Windows install is per-user unless an administrator installed it, so
      // both %LOCALAPPDATA%\Programs and %PROGRAMFILES% are checked, stable first.
      path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'NyaTerm', 'nyaterm-mcp.exe'),
      path.join(process.env.PROGRAMFILES ?? '', 'NyaTerm', 'nyaterm-mcp.exe'),
      path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'NyaTerm Preview', 'nyaterm-mcp.exe'),
      path.join(process.env.PROGRAMFILES ?? '', 'NyaTerm Preview', 'nyaterm-mcp.exe'),
    ]
    : [
      '/usr/bin/nyaterm-mcp',
      '/usr/local/bin/nyaterm-mcp',
      '/opt/NyaTerm/nyaterm-mcp',
      '/opt/nyaterm/nyaterm-mcp',
      path.join(homedir(), '.local', 'bin', 'nyaterm-mcp'),
    ]

/** Executable names the PATH lookup tries, most specific first. */
const BRIDGE_NAMES = process.platform === 'win32'
  ? ['nyaterm-mcp.exe', 'nyaterm-mcp.cmd', 'nyaterm-mcp.bat', 'nyaterm-mcp']
  : ['nyaterm-mcp']

/**
 * Find an executable on PATH without spawning anything.
 *
 * @returns the first existing absolute path, or undefined.
 */
function findOnPath(names) {
  const searched = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter)
  for (const entry of searched) {
    // Windows PATH entries are sometimes quoted; an empty entry means "current".
    const dir = entry.replace(/^"|"$/gu, '')
    if (dir.length === 0) continue
    for (const name of names) {
      const candidate = path.join(dir, name)
      try {
        if (existsSync(candidate)) return candidate
      } catch {
        /* unreadable PATH entry: keep looking */
      }
    }
  }
  return undefined
}

/**
 * The helper must be NyaTerm's own `nyaterm-mcp`, not an arbitrary executable.
 *
 * The settings page can point the plugin at a hand-picked file, which means it
 * can ask the host to spawn that file. Requiring the shipped name keeps a
 * compromised or mistaken edit from turning the page into a launch-anything
 * surface; a custom install still keeps the binary's name.
 */
const BRIDGE_FILENAME = /^nyaterm-mcp(?:\.(?:exe|cmd|bat))?$/iu

/**
 * Normalize a user-supplied bridge path.
 *
 * Accepts what people actually paste: a path wrapped in quotes, a `~` prefix,
 * or Windows-style `%LOCALAPPDATA%` references. Returns '' when nothing usable
 * was given, which means "not configured" to callers.
 */
function normalizeBridgePath(value) {
  let text = String(value ?? '').trim()
  if (text.length === 0) return ''
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim()
  }
  if (text === '~' || text.startsWith('~/') || text.startsWith('~\\')) {
    text = path.join(homedir(), text.slice(1))
  }
  text = text.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/gu, (match, name) => {
    const key = Object.keys(process.env).find((candidate) => candidate.toUpperCase() === String(name).toUpperCase())
    return key === undefined ? match : String(process.env[key])
  })
  return path.normalize(text)
}

/**
 * Check one bridge path without spawning it.
 *
 * @returns `{ path, exists, problem }`; `problem` is undefined when the path is
 *   usable. The checks are deliberately strict: a typo that spawns the wrong
 *   file fails later with an opaque MCP timeout, so it must fail here instead.
 */
function inspectBridge(value) {
  const file = normalizeBridgePath(value)
  if (file.length === 0) return { path: '', exists: false, problem: undefined }
  let stat
  try {
    stat = statSync(file)
  } catch {
    return { path: file, exists: false, problem: 'file does not exist' }
  }
  if (!stat.isFile()) return { path: file, exists: true, problem: 'not a regular file' }
  if (!BRIDGE_FILENAME.test(path.basename(file))) {
    return { path: file, exists: true, problem: 'the file name must be nyaterm-mcp (nyaterm-mcp.exe on Windows)' }
  }
  if (process.platform !== 'win32') {
    try {
      accessSync(file, constants.X_OK)
    } catch {
      return { path: file, exists: true, problem: 'not executable' }
    }
  }
  return { path: file, exists: true, problem: undefined }
}

/** Installed bridge executables: platform defaults first, then PATH. */
function detectBridges() {
  const found = []
  for (const candidate of BRIDGE_CANDIDATES) {
    // A Windows install is per-user; an unset %LOCALAPPDATA% must not turn the
    // candidate into a path relative to the process working directory.
    if (candidate.length === 0 || !path.isAbsolute(candidate)) continue
    try {
      if (statSync(candidate).isFile()) found.push(path.normalize(candidate))
    } catch {
      /* not installed there: keep looking */
    }
  }
  try {
    const onPath = findOnPath(BRIDGE_NAMES)
    if (onPath !== undefined) found.push(path.normalize(onPath))
  } catch {
    /* unreadable PATH: keep what the platform candidates found */
  }
  return [...new Set(found)]
}

/**
 * The first bridge to use, for the hot path.
 *
 * Separate from {@link detectBridges} so a tool call does not scan all of PATH
 * on every invocation: the platform candidates answer immediately, and PATH is
 * only walked when none of them is installed.
 */
function firstBridge() {
  for (const candidate of BRIDGE_CANDIDATES) {
    if (candidate.length === 0 || !path.isAbsolute(candidate)) continue
    try {
      if (statSync(candidate).isFile()) return path.normalize(candidate)
    } catch {
      /* not installed there: keep looking */
    }
  }
  try {
    const onPath = findOnPath(BRIDGE_NAMES)
    return onPath === undefined ? undefined : path.normalize(onPath)
  } catch {
    return undefined
  }
}

/**
 * Resolve the NyaTerm discovery document. NyaTerm writes it when "External MCP"
 * is enabled; the bridge reads it (or `NYATERM_MCP_DISCOVERY` may point at it).
 * Two shapes exist across NyaTerm builds: `discovery.json` inside an `mcp/`
 * directory, and a legacy `mcpdiscovery.json` beside the redb store.
 */
function discoveryCandidates(cfg, bridgePath, ctx) {
  const out = []
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0 && !out.includes(value)) out.push(value)
  }
  push(cfg.discoveryFile)
  push(process.env.NYATERM_MCP_DISCOVERY)
  // `homedir()` rather than process.env.HOME: a Windows GUI process usually has
  // no HOME at all, which used to build "\\.nyaterm" instead of the real path.
  const home = homedir()
  const stable = path.join(home, '.nyaterm')
  const preview = path.join(home, '.nyaterm-preview')
  // A Preview bridge must not bind to the stable install's endpoint. The hint is
  // the word "preview" anywhere in the effective bridge path, which covers the
  // macOS ".app" spelling and a Windows/Linux install directory alike.
  const prefersPreview = /nyaterm[ _-]?preview/iu.test(String(bridgePath ?? ''))
  const dataDirs = prefersPreview ? [preview, stable] : [stable, preview]
  for (const dir of dataDirs) {
    push(path.join(dir, 'mcp', 'discovery.json'))
    push(path.join(dir, 'mcpdiscovery.json'))
  }
  if (ctx?.logger !== undefined) ctx.logger.debug?.(`nyaterm-bridge: discovery candidates ${out.join(', ')}`)
  return out
}

/** Where the effective bridge path came from, for diagnostics and the page. */
const BRIDGE_SOURCES = {
  setting: 'saved setting',
  config: 'plugin config',
  detected: 'auto-detect',
}

/**
 * Resolve the bridge and the discovery document it should read.
 *
 * Precedence: the saved setting (per user, edited in Settings → NyaTerm 白名单),
 * then the plugin config, then auto-detection. The saved setting exists because
 * Windows installs under `%LOCALAPPDATA%\Programs`, so the helper path differs
 * per user and must not be baked into a shared profile.
 */
function resolveTransport(cfg, ctx, savedBridge = '') {
  const saved = normalizeBridgePath(savedBridge)
  const configured = normalizeBridgePath(cfg.bridgeExecutable)
  let bridge = saved.length > 0 ? saved : configured
  let source = saved.length > 0 ? 'setting' : configured.length > 0 ? 'config' : undefined
  if (bridge.length === 0) {
    bridge = firstBridge()
    if (bridge !== undefined) source = 'detected'
  }
  const files = discoveryCandidates(cfg, bridge ?? '', ctx)
  const found = files.find((file) => existsSync(file))
  return { discoveryFile: found, bridge, source }
}

/** Read and validate the discovery document; never trust its contents. */
function readDiscovery(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  if (raw === null || typeof raw !== 'object') throw new Error('discovery document is not an object')
  if (raw.host !== '127.0.0.1') throw new Error(`discovery host must be 127.0.0.1, got ${String(raw.host)}`)
  if (!Number.isInteger(raw.port) || raw.port <= 0 || raw.port > 65535) throw new Error('discovery port is invalid')
  if (typeof raw.token !== 'string' || raw.token.length === 0) throw new Error('discovery token is missing')
  if (typeof raw.generation !== 'string' || raw.generation.length === 0) throw new Error('discovery generation must be a string')
  return raw
}

/** One actionable message instead of a stack trace when NyaTerm is not ready. */
function transportFailure(cfg, ctx, savedBridge = '') {
  const { discoveryFile, bridge } = resolveTransport(cfg, ctx, savedBridge)
  if (bridge === undefined) {
    return `NyaTerm MCP bridge not found. Install NyaTerm, then set the helper location in Settings → NyaTerm 白名单 → MCP 程序位置 (config: \`bridgeExecutable\`). Searched: ${BRIDGE_CANDIDATES.filter((entry) => entry.length > 0 && path.isAbsolute(entry)).join(', ') || '(no platform defaults)'} and PATH.`
  }
  if (discoveryFile === undefined) {
    return 'NyaTerm External MCP is not enabled. In NyaTerm open Settings and enable External MCP, then retry. (No discovery document was found in ~/.nyaterm/mcp/ or ~/.nyaterm-preview/mcp/.) Set `discoveryFile` if this build stores it elsewhere.'
  }
  return `NyaTerm discovery document is unreadable: ${discoveryFile}`
}

// ---------------------------------------------------------------------------
// Minimal MCP stdio client
// ---------------------------------------------------------------------------

/**
 * One long-lived MCP connection to the NyaTerm bridge, speaking newline
 * delimited JSON-RPC 2.0 over the bridge's stdio. Requests are matched by id,
 * so unrelated calls may be in flight concurrently.
 */
class NyaTermMcpClient {
  #child
  #bridge
  #discoveryFile
  #server
  #pending = new Map()
  #nextId = 1
  #buffer = ''
  #stderr = ''
  #ready = null
  #closed = false

  constructor(bridge, discoveryFile) {
    this.#bridge = bridge
    this.#discoveryFile = discoveryFile
  }

  /** Spawn the bridge and complete the MCP initialize handshake once. */
  #ensureReady() {
    if (this.#ready !== null) return this.#ready
    this.#ready = new Promise((resolve, reject) => {
      let child
      try {
        // On Windows a `.cmd`/`.bat` helper cannot be spawned directly (EINVAL)
        // and must go through cmd.exe; an `.exe` must NOT, or a path containing
        // spaces would be split. Everything else spawns the binary directly.
        const viaCmd = process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(this.#bridge)
        const command = viaCmd ? (process.env.ComSpec ?? 'cmd.exe') : this.#bridge
        const argv = viaCmd ? ['/d', '/s', '/c', `"${this.#bridge}"`] : []
        child = spawn(command, argv, {
          env: { ...process.env, NYATERM_MCP_DISCOVERY: this.#discoveryFile },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (error) {
        reject(new Error(`failed to spawn NyaTerm MCP bridge: ${String(error?.message ?? error)}`))
        return
      }
      this.#child = child
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => this.#onData(chunk))
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        this.#stderr = (this.#stderr + chunk).slice(-4096)
      })
      child.on('error', (error) => this.#failAll(new Error(`NyaTerm MCP bridge error: ${String(error?.message ?? error)}`)))
      child.on('exit', (code) => {
        this.#closed = true
        const detail = this.#stderr.trim()
        this.#failAll(new Error(`NyaTerm MCP bridge exited (code ${String(code)})${detail.length > 0 ? `: ${detail}` : ''}`))
      })
      this.#request('initialize', {
        protocolVersion: '2026-07-28',
        capabilities: {},
        clientInfo: { name: 'nyaterm-bridge', version: '0.2.0' },
      }).then((result) => {
        this.#server = result?.serverInfo
        // The initialized notification is fire-and-forget by protocol design.
        this.#notify('notifications/initialized')
        resolve(undefined)
      }, reject)
    })
    return this.#ready
  }

  #onData(chunk) {
    this.#buffer += chunk
    let index
    while ((index = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, index).trim()
      this.#buffer = this.#buffer.slice(index + 1)
      if (line.length === 0) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message !== null && typeof message.id === 'number' && this.#pending.has(message.id)) {
        const { resolve, reject } = this.#pending.get(message.id)
        this.#pending.delete(message.id)
        if (message.error !== undefined) reject(new Error(String(message.error?.message ?? 'MCP error')))
        else resolve(message.result)
      }
    }
  }

  #failAll(error) {
    for (const { reject } of this.#pending.values()) reject(error)
    this.#pending.clear()
  }

  #write(payload) {
    if (this.#closed || this.#child === undefined) throw new Error('NyaTerm MCP bridge is not connected')
    this.#child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  #notify(method, params) {
    this.#write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }

  #request(method, params) {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`NyaTerm MCP request timed out: ${method}`))
      }, 60_000)
      timer.unref?.()
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        this.#write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(error)
      }
    })
  }

  /** List the bridge's tools (used by the diagnostic tool). */
  async listTools() {
    await this.#ensureReady()
    const result = await this.#request('tools/list', {})
    return Array.isArray(result?.tools) ? result.tools : []
  }

  /** `serverInfo` from the MCP handshake (name + version), once connected. */
  serverInfo() {
    return this.#server
  }

  /** Call one NyaTerm tool and return its structured and text payloads. */
  async callTool(name, args) {
    await this.#ensureReady()
    const result = await this.#request('tools/call', { name, arguments: args ?? {} })
    const text = Array.isArray(result?.content)
      ? result.content.filter((part) => part?.type === 'text').map((part) => String(part.text ?? '')).join('\n')
      : ''
    return { structured: result?.structuredContent, text, isError: result?.isError === true }
  }

  /** Terminate the bridge process and reject anything still in flight. */
  dispose() {
    this.#closed = true
    this.#failAll(new Error('NyaTerm MCP bridge was closed'))
    try {
      this.#child?.kill()
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// Workspace allowlist
// ---------------------------------------------------------------------------

/**
 * Canonical spelling for workspace matching: forward slashes, no trailing
 * separator, upper-case Windows drive letter.
 *
 * A Windows directory arrives as `C:\\Users\\me\\proj` (from `fs.realpath` via
 * the workspace registry) while a hand-typed rule may say `C:/Users/me/proj`, so
 * both sides are folded to one spelling before they are compared. Matching stays
 * case-SENSITIVE on purpose: a case mismatch then denies rather than grants,
 * which is the safe direction on a case-insensitive filesystem.
 */
function normalizeWorkspacePath(value) {
  const slashes = String(value ?? '').replace(/\\/gu, '/').replace(/\/+$/u, '')
  return slashes.replace(/^([a-z]):\//u, (_match, letter) => `${letter.toUpperCase()}:/`)
}

/**
 * Turn a workspace glob (`*` = one path segment, `**` = any depth) into a regex.
 *
 * Both the pattern and the candidate path go through
 * {@link normalizeWorkspacePath} first, so a single `*` never crosses a separator
 * on any platform — without that, a Windows rule `C:\\work\\*` also matched
 * `C:\\work\\a\\b` because only `/` counted as a separator.
 */
function workspacePatternToRegExp(pattern) {
  const normalized = normalizeWorkspacePath(pattern)
  let source = ''
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        index += 1
        source += '.*'
      } else {
        source += '[^/]*'
      }
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

/** Read `allowlist.json` from the store directory; a missing file is not an error. */
function loadStore(storeFile) {
  try {
    const raw = JSON.parse(readFileSync(storeFile, 'utf8'))
    if (raw === null || typeof raw !== 'object') return { workspaces: {} }
    const workspaces = raw.workspaces !== null && typeof raw.workspaces === 'object' ? raw.workspaces : {}
    return { ...raw, workspaces }
  } catch {
    return { workspaces: {} }
  }
}

/** Bounds keeping one edited store file from becoming hostile or unreadable. */
const STORE_LIMITS = { patterns: 200, entriesPerList: 500, patternChars: 1024, pathChars: 4096, bytes: 256 * 1024 }

/**
 * Validate and normalize an author-supplied `workspaces` map.
 *
 * The editor page and a hand-edited file are two doors onto the same data, so
 * both go through this: a plain object of non-empty patterns, each mapping to
 * optional string arrays (`groups`, `hosts`, `connections`) plus an optional
 * boolean `observe`. Unknown keys inside a rule are dropped rather than
 * rejected, so an older or newer editor cannot wedge the file.
 *
 * @returns `{ workspaces, problems }`. A non-empty `problems` means "refuse the
 *   write and say why" — callers must never save a partial result.
 */
function sanitizeWorkspaces(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { workspaces: {}, problems: ['"workspaces" must be an object mapping a workspace pattern to its rule'] }
  }
  const problems = []
  const patterns = Object.keys(input)
  if (patterns.length > STORE_LIMITS.patterns) {
    problems.push(`at most ${STORE_LIMITS.patterns} workspace rules are allowed (got ${patterns.length})`)
  }
  const workspaces = {}
  for (const rawPattern of patterns) {
    const pattern = rawPattern.trim()
    if (pattern.length === 0) {
      problems.push('a workspace pattern is empty')
      continue
    }
    if (pattern.length > STORE_LIMITS.patternChars) {
      problems.push(`the workspace pattern "${pattern.slice(0, 40)}…" is longer than ${STORE_LIMITS.patternChars} characters`)
      continue
    }
    if (Object.hasOwn(workspaces, pattern)) {
      problems.push(`duplicate workspace pattern "${pattern}"`)
      continue
    }
    const rule = input[rawPattern]
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      problems.push(`the rule for "${pattern}" must be an object`)
      continue
    }
    const lists = {}
    for (const field of ['groups', 'hosts', 'connections', 'observeGroups', 'observeHosts', 'observeConnections']) {
      const value = rule[field]
      if (value === undefined || value === null) {
        lists[field] = []
        continue
      }
      if (!Array.isArray(value)) {
        problems.push(`"${pattern}".${field} must be an array of strings`)
        lists[field] = []
        continue
      }
      if (value.length > STORE_LIMITS.entriesPerList) {
        problems.push(`"${pattern}".${field} has more than ${STORE_LIMITS.entriesPerList} entries`)
      }
      const entries = []
      for (const entry of value) {
        if (typeof entry !== 'string') {
          problems.push(`"${pattern}".${field} contains a non-string entry`)
          break
        }
        const trimmed = entry.trim()
        if (trimmed.length > 0 && !entries.includes(trimmed)) entries.push(trimmed)
      }
      lists[field] = entries
    }
    if (rule.observe !== undefined && typeof rule.observe !== 'boolean') {
      problems.push(`"${pattern}".observe must be true or false`)
    }
    workspaces[pattern] = {
      groups: lists.groups,
      hosts: lists.hosts,
      connections: lists.connections,
      observeGroups: lists.observeGroups,
      observeHosts: lists.observeHosts,
      observeConnections: lists.observeConnections,
      observe: rule.observe === true,
    }
  }
  return { workspaces, problems }
}

/**
 * Validate a bridge location submitted by the settings page.
 *
 * `undefined` means the field was not sent and the stored value stays as-is;
 * an empty string clears the override back to auto-detection. A non-empty path
 * must be usable right now (exists, executable, named `nyaterm-mcp`) so saving
 * cannot leave the plugin pointing at a broken helper.
 *
 * @returns `{ value, problems }`; `value` is the normalized path to store.
 */
function sanitizeBridgePath(input) {
  if (input === undefined) return { value: undefined, problems: [] }
  if (input === null) input = ''
  if (typeof input !== 'string') return { value: '', problems: ['"bridgeExecutable" must be a string'] }
  const file = normalizeBridgePath(input)
  if (file.length === 0) return { value: '', problems: [] }
  if (file.length > STORE_LIMITS.pathChars) {
    return { value: file, problems: [`the bridge path is longer than ${STORE_LIMITS.pathChars} characters`] }
  }
  const inspected = inspectBridge(file)
  if (inspected.problem !== undefined) return { value: file, problems: [`${file}: ${inspected.problem}`] }
  return { value: file, problems: [] }
}

/** Replace the store atomically, so a crash mid-write cannot truncate permissions. */
function writeStoreAtomic(storeFile, data) {
  mkdirSync(path.dirname(storeFile), { recursive: true })
  const temporary = `${storeFile}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  renameSync(temporary, storeFile)
}

/**
 * One allowlist rule with no target of its own.
 *
 * `groups`/`hosts`/`connections` grant read-write; the parallel `observe*`
 * arrays grant read-only, so a single rule can mix "汉腾 可读写, 东信 只读"
 * without splitting a workspace across two rules. `observe` stays as the
 * whole-workspace switch and overrides every grant.
 */
function emptyEntry() {
  return { connections: [], groups: [], hosts: [], observeConnections: [], observeGroups: [], observeHosts: [], observe: false }
}

/** Normalize one allowlist entry (a bare array, a string, or an object). */
function normalizeEntry(entry) {
  if (Array.isArray(entry)) return { ...emptyEntry(), connections: entry.map(String) }
  if (typeof entry === 'string') return { ...emptyEntry(), connections: [entry] }
  if (entry !== null && typeof entry === 'object') {
    const list = (value) => (Array.isArray(value) ? value.map(String) : [])
    return {
      connections: list(entry.connections ?? entry.ids),
      groups: list(entry.groups),
      hosts: list(entry.hosts),
      observeConnections: list(entry.observeConnections),
      observeGroups: list(entry.observeGroups),
      observeHosts: list(entry.observeHosts),
      observe: entry.observe === true,
    }
  }
  return emptyEntry()
}

/** The calling session's working directory, or undefined outside a session. */
function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/**
 * Resolve the allowlist entry governing one workspace. The most specific
 * matching pattern wins (longest pattern, then latest declaration), so a narrow
 * rule can override a broad one regardless of file order.
 */
function resolveEntry(cfg, store, cwd) {
  const table = new Map()
  for (const [pattern, entry] of Object.entries(cfg.workspaces ?? {})) table.set(pattern, entry)
  for (const [pattern, entry] of Object.entries(store.workspaces ?? {})) table.set(pattern, entry)
  const full = cwd === undefined ? undefined : normalizeWorkspacePath(path.resolve(cwd))
  let best
  if (full !== undefined) {
    for (const [pattern, entry] of table) {
      let matches = false
      try {
        matches = workspacePatternToRegExp(pattern).test(full)
      } catch {
        matches = false
      }
      if (!matches) continue
      if (best === undefined || String(pattern).length >= String(best.pattern).length) {
        best = { pattern, entry: normalizeEntry(entry) }
      }
    }
  }
  if (best !== undefined) return { ...best.entry, pattern: best.pattern }
  return { ...emptyEntry(), pattern: undefined, unconfigured: true }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Render a compact, model-readable line for one connection. */
function formatConnection(connection) {
  const group = Array.isArray(connection.groupPath) && connection.groupPath.length > 0
    ? `[${connection.groupPath.join(' / ')}] `
    : ''
  return `- ${group}${connection.name}  (type=${connection.type}, id=${connection.id})`
}

/** Render an allowlist decision for diagnostics. */
function describeEntry(entry) {
  const parts = []
  if (entry.pattern !== undefined) parts.push(`matched pattern "${entry.pattern}"`)
  else parts.push('no workspace pattern matched')
  if (entry.connections.length > 0) parts.push(`connectionIds=${entry.connections.join(',')}`)
  if (entry.groups.length > 0) parts.push(`groups=${entry.groups.join(',')}`)
  if (entry.hosts.length > 0) parts.push(`hosts=${entry.hosts.join(',')}`)
  if (entry.observeGroups.length > 0) parts.push(`readOnlyGroups=${entry.observeGroups.join(',')}`)
  if (entry.observeHosts.length > 0) parts.push(`readOnlyHosts=${entry.observeHosts.join(',')}`)
  if (entry.observeConnections.length > 0) parts.push(`readOnlyConnections=${entry.observeConnections.join(',')}`)
  if (entry.observe) parts.push('wholeWorkspace=readOnly')
  return parts.join('; ')
}

/**
 * Compile one author-facing parameter map into the wire JSON Schema that is
 * actually sent to the model.
 *
 * `ctx.tools.register()` stores `parameters` verbatim and the provider forwards
 * it unchanged as the function's `parameters` (`defineTool` is the only thing
 * that compiles; this plugin imports no Harness package, so it must compile by
 * hand). The author-facing per-property map is therefore NOT registerable on its
 * own: it has no root `type`, and the provider rejects every request naming such
 * a tool with
 *   Invalid schema for function 'nt_exec': schema must be a JSON Schema of
 *   'type: "object"', got 'type: null'.
 * Per-property `required: true` is lifted into the root `required` array and the
 * flag stripped, because `required` is not a JSON Schema keyword on a property.
 *
 * The result is intentionally byte-identical to
 * `parameterSchemaSpecToJsonSchema(spec)` from `@deepseek-ai/dsh-tools`, so these
 * tools reach the provider shaped exactly like a first-party `defineTool` tool.
 * {@link assertWireParameters} re-checks that at registration.
 */
function objectSchema(properties) {
  const keys = Object.keys(properties)
  const required = keys.filter((key) => properties[key]?.required === true)
  const compiled = {}
  for (const key of keys) {
    const { required: _lifted, ...rest } = properties[key]
    compiled[key] = rest
  }
  return { type: 'object', properties: compiled, ...(required.length === 0 ? {} : { required }) }
}

/**
 * Refuse to register a tool whose `parameters` the provider would reject.
 *
 * Nothing between this file and the API repairs a malformed schema: the
 * provider forwards `parameters` verbatim (`dsh-llm-deepseek` maps it straight
 * to the request's `input_schema`; OpenAI-compatible adapters to
 * `function.parameters`). A root that is not `type: "object"` — the shape a
 * bare per-property map has — makes EVERY request that names the tool fail with
 *   Invalid schema for function '<name>': schema must be a JSON Schema of
 *   'type: "object"', got 'type: null'.
 * That is a whole-conversation failure, not a failed tool call, so the check
 * runs here at load time: a violation disables this one plugin and surfaces in
 * the profile's plugin status instead of poisoning every request silently.
 *
 * `defineTool` would compile the schema for us, but a bundle installed by
 * symlink (`link:` dependency) cannot resolve `@deepseek-ai/*` from its real
 * path inside the workspace, so the equivalent rules are enforced by hand:
 * an object root, a single string `type` per property, and a `required` array
 * that only names declared properties. `additionalProperties` is deliberately
 * NOT required here: `parameterSchemaSpecToJsonSchema` omits it on a parameters
 * root too (it is required only of an author-declared nested `type: "object"`
 * node), and `objectSchema` keeps this plugin byte-identical to that compiler.
 */
function assertWireParameters(name, parameters) {
  const fail = (detail) => {
    throw new Error(`nyaterm-bridge: tool "${name}" declares an unusable parameters schema (${detail}). The provider rejects the entire request, so this plugin refuses to load rather than break every conversation.`)
  }
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) fail('parameters is not a schema object')
  if (parameters.type !== 'object') fail(`root type must be "object", got ${parameters.type === undefined ? 'no "type"' : JSON.stringify(parameters.type)}`)
  const properties = parameters.properties
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) fail('"properties" must be an object')
  const required = parameters.required
  if (required !== undefined && (!Array.isArray(required) || required.some((key) => typeof key !== 'string'))) fail('"required" must be an array of strings')
  for (const key of required ?? []) {
    if (!Object.hasOwn(properties, key)) fail(`"required" names "${key}", which is not declared in "properties"`)
  }
  for (const [key, node] of Object.entries(properties)) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) fail(`property "${key}" is not a schema object`)
    if (typeof node.type !== 'string') fail(`property "${key}" must declare a single string "type"`)
  }
  return parameters
}

/** JSON Schema for a tool that takes no arguments. */
const NO_ARGS = objectSchema({})

/**
 * Strip terminal control sequences from captured output.
 *
 * NyaTerm hands back the session's raw byte stream, so even one shell prompt
 * arrives as
 *   ESC ] 133;A BEL  ESC [ ?2004h  ESC ] 0;root@host:~ BEL  root@host:~#
 * Both families are matched at their introducer — CSI (`ESC [ params final`) and
 * OSC (`ESC ] … BEL | ESC \`) — rather than by a full terminal grammar, which is
 * enough to leave the printable text the model should actually read. C0 controls
 * other than tab, newline and carriage return are dropped with them.
 */
function stripTerminalControls(text) {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '')
    .replace(/\u001b[@-Z\\-_]/gu, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
}

/**
 * True when a NyaTerm result exceeded its inline budget and was replaced by
 * `{outputId, preview, totalBytes, truncated}`.
 *
 * NyaTerm then serves the real payload in chunks through `tool_output_read`;
 * each chunk's `data` is the JSON text of the original result. A chunk boundary
 * can fall inside a JSON string, so chunks must be concatenated before parsing.
 */
function isOutputWrapper(value) {
  return value !== null && typeof value === 'object'
    && typeof value.outputId === 'string' && value.outputId.length > 0
    && !Object.hasOwn(value, 'output')
    && !Object.hasOwn(value, 'items')
}

/** Human byte count for listings and diagnostics. */
function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '?'
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${bytes} B`
}

/** ISO-8601 second precision for remote mtimes. */
function formatMtime(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '-'
  return new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 19)
}

/** One `sftp_list` entry as a compact, aligned line. */
function formatFsEntry(entry, index) {
  const kind = entry.is_dir === true ? 'd' : entry.is_symlink === true ? 'l' : '-'
  const pad = (value, width) => String(value ?? '-').padEnd(width)
  const size = String(entry.size ?? '-').padStart(10)
  return `${String(index).padStart(3)} ${kind} ${pad(entry.permissions, 4)} ${pad(entry.owner, 8)} ${pad(entry.group, 8)} ${size} ${formatMtime(entry.mtime)} ${entry.name ?? '?'}`
}

/**
 * Render one `terminal_execute` result for the model.
 *
 * This bridge runs the command and returns its output inline as
 * `{durationMs, exitCode, output, sourceTruncated, timedOut}`, so the output
 * belongs in this tool's own result. It cannot be re-read afterwards either:
 * the same call consumes the `terminal_recent_output` cursor, which then reports
 * nothing for that command.
 */
function describeExecResult(structured, text) {
  const raw = typeof structured?.output === 'string' ? structured.output : text
  const output = typeof raw === 'string' ? stripTerminalControls(raw) : raw
  const notes = []
  if (structured?.timedOut === true) {
    // NyaTerm cannot tell whether a timed-out write actually ran, so the model
    // must not treat a retry as idempotent.
    notes.push(`timed out${structured.durationMs === undefined ? '' : ` after ${structured.durationMs} ms`}; the command may or may not have run — do not blindly retry a mutating command, and use nt_job_start with a connectionId for long or busy targets`)
  } else if (structured?.exitCode !== undefined && structured?.exitCode !== null) {
    notes.push(`exit code ${structured.exitCode}`)
  }
  if (structured?.sourceTruncated === true) notes.push('NyaTerm truncated the captured output')
  const body = typeof output === 'string' && output.length > 0 ? output : '(the command produced no output)'
  return notes.length === 0 ? body : `${body}\n[NyaTerm: ${notes.join('; ')}]`
}

/** Build a tool definition without importing `defineTool` (kept self-contained). */
function textOutput(render) {
  return { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: render(value) }] }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const name = 'nyaterm-bridge'

export const inject = ['tools']

/**
 * Normalize one plugin Config row.
 *
 * This plugin deliberately declares no `Config` schema and imports no Harness
 * package: a bundle installed by symlink (`link:` dependency, as `install_bundle`
 * does) has its real path inside the workspace, where `@deepseek-ai/*` packages
 * do not resolve. Staying plain-JS keeps the bundle self-contained. Field names
 * and defaults match the documented Config.
 */
function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const str = (value, fallback) => (typeof value === 'string' ? value : fallback)
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  return {
    enabled: bool(source.enabled, true),
    bridgeExecutable: str(source.bridgeExecutable, ''),
    discoveryFile: str(source.discoveryFile, ''),
    storeDir: str(source.storeDir, ''),
    enforceAllowlist: bool(source.enforceAllowlist, true),
    allowOtherTools: bool(source.allowOtherTools, true),
    defaultObserveOnly: bool(source.defaultObserveOnly, false),
    observeTools: Array.isArray(source.observeTools) ? source.observeTools.filter((n) => typeof n === 'string') : [],
    workspaces: source.workspaces !== null && typeof source.workspaces === 'object' ? source.workspaces : {},
  }
}

/** Read-only global tools that an observe-only workspace may still call. */
const OBSERVE_READ_ONLY = new Set([
  'read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch',
  'todo_write', 'ask_user_question', 'get_goal', 'list_agents',
  'cordis_inspect_list', 'cordis_inspect_query',
])

export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)
  if (cfg.enabled !== true) {
    ctx.logger?.info?.('nyaterm-bridge: disabled by config')
    return
  }

  // GLOBAL by default: the allowlist governs every workspace this Harness
  // serves, so it must not live inside one of them (nor depend on the process
  // working directory, which is not stable across launches).
  const storeDir = cfg.storeDir.length > 0
    ? cfg.storeDir
    : path.join(homedir(), '.dsh', 'nyaterm-bridge')
  const storeFile = path.join(storeDir, 'allowlist.json')

  /** Long-lived bridge client; replaced whenever the discovery document rotates. */
  let client
  /**
   * Identity of the endpoint `client` is attached to.
   *
   * Comparing the discovery FILE PATH is not enough: NyaTerm rewrites that file
   * in place — new port, token and `generation` — whenever its MCP settings
   * change, and keeps the path identical. A bridge spawned against the previous
   * endpoint does not fail loudly; it loses its session scope and answers with
   * an empty session list, so every nt_exec then looks like an allowlist
   * failure. Identity, not path, is what decides whether `client` is still the
   * right connection.
   */
  let clientIdentity
  /** In-flight connect attempt, so concurrent callers share ONE bridge process. */
  let connecting

  const readStore = () => loadStore(storeFile)

  /**
   * Describe the effective bridge for the settings page and `nt_status`: what is
   * saved, how it resolved, and what is actually installed on this machine.
   */
  const describeBridge = (savedValue) => {
    const savedBridge = typeof savedValue === 'string' ? savedValue : ''
    const transport = resolveTransport(cfg, ctx, savedBridge)
    const inspected = transport.bridge === undefined ? undefined : inspectBridge(transport.bridge)
    return {
      // What the page shows in the field; empty means "auto-detect".
      saved: savedBridge,
      configured: cfg.bridgeExecutable,
      effective: transport.bridge ?? '',
      source: transport.source ?? '',
      discovery: transport.discoveryFile ?? '',
      exists: inspected?.exists ?? false,
      problem: transport.bridge === undefined
        ? 'no nyaterm-mcp found by auto-detection'
        : inspected?.problem,
      // Per-user installs (Windows `%LOCALAPPDATA%`, macOS `~/Applications`)
      // differ, so the page offers what is actually present on this machine.
      candidates: detectBridges(),
      platform: process.platform,
    }
  }

  /**
   * Obtain a connected client, respawning when NyaTerm rewrote its discovery
   * document (new port/token/generation), which the running bridge cannot
   * follow.
   *
   * The document is re-read and validated on every call so a rotation is noticed
   * at once. The attempt is memoized: tools run concurrently (the Harness
   * schedules parallel-safe calls together), and without this two first calls
   * would each see `client === undefined`, each spawn a bridge, and silently
   * leak the process that lost the assignment to `client`.
   */
  const connect = async () => {
    const store = readStore()
    const savedBridge = typeof store.bridgeExecutable === 'string' ? store.bridgeExecutable : ''
    const { discoveryFile, bridge } = resolveTransport(cfg, ctx, savedBridge)
    if (discoveryFile === undefined || bridge === undefined) {
      throw new Error(transportFailure(cfg, ctx, savedBridge))
    }
    // A saved path can be hand-edited in allowlist.json, so it gets the same
    // checks as the settings form: never spawn a missing, non-executable, or
    // misleadingly named file just because a JSON field names it.
    const inspection = inspectBridge(bridge)
    if (inspection.problem !== undefined) {
      throw new Error(`NyaTerm MCP bridge "${bridge}" is unusable: ${inspection.problem}. Fix it in Settings → NyaTerm 白名单 → MCP 程序位置.`)
    }
    const document = readDiscovery(discoveryFile) // throws before any bridge inherits the path
    // The bridge path is part of the identity too: changing "MCP 程序位置" in the
    // settings page must respawn the helper even when the endpoint itself did not
    // move, otherwise the old process would keep serving.
    const identity = `${document.host}:${document.port}#${document.generation}|${bridge}`
    if (client !== undefined && clientIdentity === identity) return client
    if (connecting !== undefined) return connecting
    connecting = (async () => {
      if (client !== undefined) {
        client.dispose()
        client = undefined
      }
      const fresh = new NyaTermMcpClient(bridge, discoveryFile)
      client = fresh
      clientIdentity = identity
      try {
        await fresh.listTools()
      } catch (error) {
        fresh.dispose()
        if (client === fresh) {
          client = undefined
          clientIdentity = undefined
        }
        throw error
      }
      return fresh
    })().finally(() => {
      connecting = undefined
    })
    return connecting
  }

  const releaseClient = () => {
    client?.dispose()
    client = undefined
    clientIdentity = undefined
  }

  ctx.effect(() => releaseClient)

  /** Call a NyaTerm tool, resetting the cached connection if it went stale. */
  const callNyaTerm = async (tool, args) => {
    try {
      const active = await connect()
      return await active.callTool(tool, args)
    } catch (error) {
      releaseClient()
      throw error
    }
  }

  /** Fetch the connection list and index it three ways for allowlist checks. */
  const fetchConnections = async () => {
    // A denied or broken connection_list must not read as "no saved
    // connections": that would turn an allowlist failure into a data answer.
    const { structured, text } = await callNyaTermStrict('connection_list', {})
    const connections = Array.isArray(structured?.connections)
      ? structured.connections
      : JSON.parse(text.length > 0 ? text : '{"connections":[]}').connections ?? []
    const byId = new Map()
    for (const connection of connections) byId.set(String(connection.id), connection)
    return { connections, byId }
  }

  /**
   * Sessions this plugin opened, mapped to the connection it opened them for.
   *
   * Kept as a fast path even though NyaTerm 2.0.x also reports
   * `sourceConnectionId`: the plugin may run against an older bridge, and the
   * in-memory mapping is authoritative for the tab it just opened.
   */
  const openedSessions = new Map()

  /** Remember the connection behind a session this plugin opened itself. */
  const rememberSession = (sessionId, connectionId) => {
    if (sessionId === undefined || sessionId === null || connectionId === undefined || connectionId === null) return
    openedSessions.set(String(sessionId), String(connectionId))
  }

  /**
   * Resolve the connection behind a session.
   *
   * Order: the exact mapping `nt_open` recorded, then NyaTerm's own
   * `sourceConnectionId` (present since 2.0.x, and the only exact answer for a
   * tab the user opened by hand), then a unique match on the session's `name`
   * for older bridges that omit the field. A name shared by several connections
   * is ambiguous and resolves to nothing, so an unverifiable session is denied
   * rather than guessed at.
   *
   * @returns the connection, or undefined when it cannot be established.
   */
  const resolveSession = async (sessionId, connections, byId) => {
    const opened = openedSessions.get(String(sessionId))
    if (opened !== undefined) return byId.get(opened) ?? { id: opened, name: opened, groupPath: [] }
    const { structured } = await callNyaTermStrict('session_get', { sessionId })
    const sourceId = structured?.sourceConnectionId
    if (typeof sourceId === 'string' && sourceId.length > 0) {
      // A session whose connection was deleted still yields the id, which is what
      // the allowlist matches on; name/groupPath stay unknown until it exists.
      return byId.get(sourceId) ?? { id: sourceId, name: String(structured?.name ?? sourceId), groupPath: [] }
    }
    const name = structured?.name
    if (typeof name !== 'string' || name.length === 0) return undefined
    const matches = connections.filter((connection) => connection.name === name)
    return matches.length === 1 ? matches[0] : undefined
  }

  /** True when one connection id satisfies the entry's groups/hosts/ids. */
  /** Match one group list against a connection's group path. */
  const groupMatches = (connection, list) => {
    if (!Array.isArray(list) || list.length === 0) return false
    const groups = Array.isArray(connection.groupPath) ? connection.groupPath : []
    for (const wanted of list) {
      if (groups.includes(wanted)) return true
      // Accept the full path too, so "A / B" or "A/B" both work.
      if (groups.join(' / ') === wanted || groups.join('/') === wanted) return true
    }
    return false
  }

  /**
   * Decide how one rule covers a connection: 'rw' (drive it), 'ro' (read only),
   * or null (not covered).
   *
   * The most specific grant wins — connection id, then host name, then group —
   * so marking a whole group read-only and one server in it read-write means
   * exactly that server. At the same specificity read-only wins, the safe
   * reading of a contradictory rule.
   */
  const admitTarget = (entry, connection) => {
    if (connection === undefined) return null
    const id = String(connection.id)
    const name = String(connection.name ?? '')
    if (entry.observeConnections.includes(id)) return 'ro'
    if (entry.connections.includes(id)) return 'rw'
    if (entry.observeHosts.includes(name)) return 'ro'
    if (entry.hosts.includes(name)) return 'rw'
    if (groupMatches(connection, entry.observeGroups)) return 'ro'
    if (groupMatches(connection, entry.groups)) return 'rw'
    return null
  }

  /** `admitTarget` with the whole-workspace read-only switch applied. */
  const admissionFor = (entry, connection) => {
    const mode = admitTarget(entry, connection)
    if (mode === null) return null
    return entry.observe ? 'ro' : mode
  }

  /**
   * What a gated operation actually does to the target.
   *
   * `session_open` only attaches: NyaTerm logs in and shows the terminal, which
   * is observation, and it is what makes a read-only grant useful (watch a
   * device without being able to type into it). Execution, interruption and
   * every SFTP mutation change the remote side.
   */
  const WRITE_OPERATIONS = new Set([
    'terminal_execute', 'terminal_start', 'terminal_stop',
    'sftp_write', 'sftp_mkdir', 'sftp_rename', 'sftp_delete', 'sftp_chmod',
  ])
  const operationWeight = (operation) => (WRITE_OPERATIONS.has(operation) ? 'write' : 'observe')

  /**
   * Authorize one gated operation. Returns the resolved connection on success
   * and throws a model-readable denial otherwise.
   */
  const authorize = async (exec, connection, operation) => {
    if (!cfg.enforceAllowlist) return { connection, mode: 'rw' }
    const cwd = sessionCwd(exec)
    const store = readStore()
    const entry = resolveEntry(cfg, store, cwd)
    const weight = operationWeight(operation)
    const label = connection === undefined
      ? 'the requested target'
      : `${connection.name ?? connection.id}${Array.isArray(connection.groupPath) && connection.groupPath.length > 0 ? ` [${connection.groupPath.join(' / ')}]` : ''}`
    if (entry.unconfigured) {
      // An unlisted workspace with defaultObserveOnly is read-only, so reads are
      // exactly what it allows — denying them would contradict the setting.
      if (cfg.defaultObserveOnly) {
        if (weight !== 'write') return { connection, mode: 'ro' }
        throw new Error(`NyaTerm ${operation} is not permitted here: workspace "${cwd ?? '(unknown)'}" is not listed in ${storeFile} (defaultObserveOnly is on, so this workspace may only observe). Add this workspace to the allowlist to permit it.`)
      }
      throw new Error(`NyaTerm ${operation} is denied: workspace "${cwd ?? '(unknown)'}" is not listed in the allowlist (${storeFile}). Add it under "workspaces" to permit it.`)
    }
    const mode = admissionFor(entry, connection)
    if (mode === null) {
      throw new Error(`NyaTerm ${operation} is denied: ${label} is outside the allowlist for workspace "${cwd ?? '(unknown)'}" (${describeEntry(entry)}). Call nt_workspace to see what this workspace permits.`)
    }
    if (mode === 'ro' && weight === 'write') {
      throw new Error(`NyaTerm ${operation} is denied: ${label} is read-only in the allowlist for workspace "${cwd ?? '(unknown)'}" (${describeEntry(entry)}). A read-only target may be opened and its output read, but no command may run on it. Call nt_workspace to see the read-only targets.`)
    }
    return { connection, mode }
  }

  /**
   * Resolve the connection a session belongs to, then authorize it.
   *
   * Fail-closed by design: when the connection cannot be established the
   * allowlist cannot be applied, so the call is refused with an explanation
   * rather than allowed against an unchecked target.
   */
  const authorizeSession = async (exec, sessionId, operation) => {
    if (!cfg.enforceAllowlist) return undefined
    const { connections, byId } = await fetchConnections()
    const connection = await resolveSession(sessionId, connections, byId)
    if (connection === undefined) {
      throw new Error(`NyaTerm ${operation} is denied: the connection behind session ${sessionId} could not be resolved, so the allowlist cannot be checked. NyaTerm reports the owning connection as \`sourceConnectionId\`; a session is verifiable when nt_open opened it or when NyaTerm reports that id. Call nt_sessions, then open the session with nt_open.`)
    }
    return authorize(exec, connection, operation)
  }

  // -------------------------------------------------------------------------
  // Result paging and owned ids
  //
  // `terminal_poll`, `terminal_stop` and `tool_output_read` accept only an opaque
  // id and report neither the session nor the connection behind it. The only way
  // to keep the allowlist enforceable is to remember which allowlisted
  // connection each id the plugin minted belongs to, and to refuse every id it
  // did not mint. The maps die with the plugin process, so a job from a previous
  // run is deliberately not resumed: its target could no longer be proven.
  // -------------------------------------------------------------------------

  /** One `tool_output_read` chunk is capped by NyaTerm. */
  const OUTPUT_CHUNK_BYTES = 65536
  /** Unwrapping a large result stops here rather than buffering without bound. */
  const OUTPUT_UNWRAP_BYTES = 512 * 1024
  /** A directory listing larger than this is too big to be useful as a tool result. */
  const FS_LIST_UNWRAP_BYTES = 1024 * 1024
  const OWNED_ID_LIMIT = 256

  const jobState = new Map()
  const outputState = new Map()

  /** Remember a job this plugin started, and whose allowlisted target it runs on. */
  const rememberJob = (jobId, record) => {
    if (typeof jobId !== 'string' || jobId.length === 0) return
    jobState.set(jobId, record)
    if (jobState.size > OWNED_ID_LIMIT) jobState.delete(jobState.keys().next().value)
  }

  /** Remember a large result this plugin handed to the model. */
  const rememberOutput = (outputId, record) => {
    if (typeof outputId !== 'string' || outputId.length === 0) return
    outputState.set(outputId, record)
    if (outputState.size > OWNED_ID_LIMIT) outputState.delete(outputState.keys().next().value)
  }

  /**
   * Call a NyaTerm tool and turn MCP tool-level failures into errors.
   *
   * NyaTerm reports permission denials, write conflicts and execution failures
   * as `isError: true` with `{code, message}` — not as JSON-RPC errors. Ignoring
   * the flag turns a denial into a successful-looking tool result, so every call
   * that acts on the target goes through this.
   */
  const callNyaTermStrict = async (tool, args) => {
    const result = await callNyaTerm(tool, args)
    if (result.isError === true) {
      const code = typeof result.structured?.code === 'string' ? result.structured.code : undefined
      const message = typeof result.structured?.message === 'string' ? result.structured.message : result.text
      throw new Error(`NyaTerm ${tool} failed${code === undefined ? '' : ` (${code})`}: ${message.length > 0 ? message : 'no detail returned'}`)
    }
    return result
  }

  /**
   * Read a wrapped result from NyaTerm in chunks until it ends or `limit` is
   * reached.
   *
   * Offsets are byte offsets chosen by NyaTerm, so they are reused verbatim
   * instead of being recomputed from the decoded string (which would drift on
   * multi-byte characters).
   */
  const readWholeOutput = async (outputId, limit = OUTPUT_UNWRAP_BYTES) => {
    let offset = 0
    let text = ''
    let total
    let complete = false
    let resume = 0
    for (;;) {
      const { structured } = await callNyaTermStrict('tool_output_read', {
        outputId,
        offset,
        maxBytes: OUTPUT_CHUNK_BYTES,
      })
      const data = typeof structured?.data === 'string' ? structured.data : ''
      if (typeof structured?.totalBytes === 'number') total = structured.totalBytes
      text += data
      complete = structured?.eof === true
      const next = structured?.nextOffset
      resume = typeof next === 'number' ? next : offset + data.length
      // Offsets are byte offsets, so the budget is compared in the same units
      // instead of in UTF-16 code units of the decoded text.
      if (complete || data.length === 0 || resume >= limit) break
      if (typeof next !== 'number' || next <= offset) break
      offset = next
    }
    return { text, total, complete, resume }
  }

  /**
   * Turn a NyaTerm result into its real payload.
   *
   * A result NyaTerm considered too large arrives as
   * `{outputId, preview, totalBytes, truncated}`; the payload behind it is the
   * original result's JSON text, so chunks are concatenated and parsed. Parsing
   * fails when `limit` cut it short, in which case the caller gets the raw text
   * plus the cursor to continue from with `nt_output_read`.
   */
  const unwrapResult = async (result, limit = OUTPUT_UNWRAP_BYTES) => {
    if (!isOutputWrapper(result.structured)) {
      return { structured: result.structured, text: result.text, complete: true, wrapper: false }
    }
    const { text, total, complete, resume } = await readWholeOutput(result.structured.outputId, limit)
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
    return {
      structured: parsed,
      text,
      total,
      complete,
      resume,
      wrapper: true,
      outputId: result.structured.outputId,
    }
  }

  /** Re-check the allowlist for a job this plugin started. */
  const authorizeJob = async (exec, jobId, operation) => {
    const record = jobState.get(String(jobId))
    if (!cfg.enforceAllowlist) return record
    if (record === undefined) {
      throw new Error(`NyaTerm ${operation} is denied: job "${jobId}" was not started by this plugin session, so the connection behind it cannot be checked against the allowlist. Start it with nt_job_start (jobs are not resumed across plugin restarts).`)
    }
    const { byId } = await fetchConnections()
    const connection = record.connectionId === undefined ? undefined : byId.get(String(record.connectionId))
    if (connection === undefined) {
      throw new Error(`NyaTerm ${operation} is denied: the connection behind job "${jobId}" is no longer in NyaTerm's saved connection list, so the allowlist cannot be verified.`)
    }
    await authorize(exec, connection, operation)
    return jobState.get(String(jobId))
  }

  /** Re-check the allowlist for a large result this plugin handed out. */
  const authorizeOutput = async (exec, outputId, operation) => {
    const record = outputState.get(String(outputId))
    if (!cfg.enforceAllowlist) return record
    if (record === undefined) {
      throw new Error(`NyaTerm ${operation} is denied: output "${outputId}" was not produced through this plugin session, so its target cannot be checked against the allowlist. Ask for the content again with the tool that produced it.`)
    }
    const { byId } = await fetchConnections()
    const connection = record.connectionId === undefined ? undefined : byId.get(String(record.connectionId))
    if (connection === undefined) {
      throw new Error(`NyaTerm ${operation} is denied: the connection behind output "${outputId}" is no longer in NyaTerm's saved connection list, so the allowlist cannot be verified.`)
    }
    await authorize(exec, connection, operation)
    return record
  }

  /**
   * Split SFTP arguments into one NyaTerm target plus the connection it names.
   *
   * NyaTerm's `FileTargetArgs` accepts either `sessionId` or
   * `target: {type: 'connection', connectionId}` and never both, so the tools
   * expose those as two optional parameters and build the wire shape here.
   */
  const resolveFileTarget = async (exec, args, operation) => {
    const sessionId = typeof args.sessionId === 'string' && args.sessionId.length > 0 ? args.sessionId : undefined
    const connectionId = typeof args.connectionId === 'string' && args.connectionId.length > 0 ? args.connectionId : undefined
    if (sessionId !== undefined && connectionId !== undefined) {
      throw new Error(`Pass only one of sessionId and connectionId for ${operation}: they name different targets and NyaTerm refuses both at once.`)
    }
    if (sessionId !== undefined) {
      const authorized = await authorizeSession(exec, sessionId, operation)
      return { targetArgs: { sessionId }, connection: authorized?.connection }
    }
    if (connectionId !== undefined) {
      const { byId } = await fetchConnections()
      const connection = byId.get(connectionId)
      if (connection === undefined) {
        throw new Error(`Unknown connectionId "${connectionId}". Call nt_connections for the saved ids (ids of deleted or renamed connections go stale).`)
      }
      if (String(connection.type ?? '') !== 'ssh') {
        throw new Error(`connectionId "${connectionId}" is a ${String(connection.type ?? 'non-SSH')} connection; NyaTerm only reaches SFTP over SSH. Open it with nt_open and pass its sessionId instead.`)
      }
      const authorized = await authorize(exec, connection, operation)
      return { targetArgs: { target: { type: 'connection', connectionId: String(connection.id) } }, connection: authorized?.connection ?? connection }
    }
    throw new Error(`Pass sessionId (an open NyaTerm session) or connectionId (a saved connection) for ${operation}: NyaTerm needs one to know which remote host to act on. Call nt_sessions or nt_connections.`)
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  /**
   * The single seam every tool goes through: reject an unusable wire schema
   * before it can reach the registry (and therefore the model).
   */
  const register = (definition) => {
    if (definition.output === undefined || typeof definition.output?.render !== 'function') {
      throw new Error(`nyaterm-bridge: tool "${definition.name}" must declare output { schema, render }`)
    }
    assertWireParameters(definition.name, definition.parameters)
    return ctx.tools.register(definition)
  }

  /** nt_connections — list NyaTerm saved connections with their group paths. */
  register({
    name: 'nt_connections',
    description: 'List the connections saved in NyaTerm, with their group path. Use it to find the connectionId to open, and to see which groups exist. Read-only.',
    parameters: NO_ARGS,
    output: textOutput((value) => value),
    async execute() {
      const { connections } = await fetchConnections()
      if (connections.length === 0) return 'NyaTerm has no saved connections.'
      const lines = connections.map(formatConnection)
      return `NyaTerm connections (${connections.length}):\n${lines.join('\n')}`
    },
  })

  /** nt_workspace — show the allowlist decision for the calling workspace. */
  register({
    name: 'nt_workspace',
    description: 'Explain the NyaTerm allowlist for the current workspace: which group paths, host names, and connection ids are permitted, and whether this workspace is restricted to observation. Call it when a NyaTerm call is denied. Read-only.',
    parameters: NO_ARGS,
    output: textOutput((value) => value),
    async execute(_args, exec) {
      const cwd = sessionCwd(exec)
      const store = readStore()
      const entry = resolveEntry(cfg, store, cwd)
      const lines = [
        `workspace: ${cwd ?? '(no session cwd)'}`,
        `allowlist file: ${storeFile}`,
        `enforcement: ${cfg.enforceAllowlist ? 'on' : 'off'}`,
        `decision: ${entry.unconfigured ? (cfg.defaultObserveOnly ? 'unlisted -> observe only' : 'unlisted -> denied') : describeEntry(entry)}`,
        `read-write groups: ${entry.groups.length > 0 ? entry.groups.join(', ') : '(none)'}`,
        `read-only groups: ${entry.observeGroups.length > 0 ? entry.observeGroups.join(', ') : '(none)'}`,
        `read-write hosts: ${entry.hosts.length > 0 ? entry.hosts.join(', ') : '(none)'}`,
        `read-only hosts: ${entry.observeHosts.length > 0 ? entry.observeHosts.join(', ') : '(none)'}`,
        `read-write connection ids: ${entry.connections.length > 0 ? entry.connections.join(', ') : '(none)'}`,
        `read-only connection ids: ${entry.observeConnections.length > 0 ? entry.observeConnections.join(', ') : '(none)'}`,
        `whole workspace: ${entry.observe ? 'read-only (every target below is read-only)' : 'read-write where granted'}`,
      ]
      try {
        const { connections } = await fetchConnections()
        const admitted = connections
          .map((connection) => ({ connection, mode: admissionFor(entry, connection) }))
          .filter((row) => row.mode !== null)
        lines.push(`reachable now: ${admitted.length} of ${connections.length} (${admitted.filter((row) => row.mode === 'rw').length} read-write)`)
        lines.push('legend: an unmarked target may be opened AND executed; [read-only] may be opened and read, but no command may run on it')
        for (const row of admitted) lines.push(`${formatConnection(row.connection)}${row.mode === 'ro' ? '  [read-only]' : ''}`)
      } catch (error) {
        lines.push(`connection list unavailable: ${String(error?.message ?? error)}`)
      }
      return lines.join('\n')
    },
  })

  /** nt_sessions — list the NyaTerm sessions visible to this MCP scope. */
  register({
    name: 'nt_sessions',
    description: 'List the NyaTerm terminal sessions currently scoped to the MCP connection, with the active and default session ids, the saved connection behind each session (sourceConnectionId), and each session\'s terminal state. Use it to find a sessionId for nt_exec, nt_output or the nt_fs_* tools. Read-only.',
    parameters: NO_ARGS,
    output: textOutput((value) => value),
    async execute() {
      const { structured, text } = await callNyaTermStrict('get_environment', {})
      const payload = structured ?? (text.length > 0 ? JSON.parse(text) : {})
      const sessions = Array.isArray(payload?.sessions) ? payload.sessions : []
      const lines = [`active session: ${payload?.activeSessionId ?? '(none)'}`, `default session: ${payload?.defaultSessionId ?? '(none)'}`]
      if (sessions.length === 0) lines.push('(no scoped sessions)')
      for (const session of sessions) {
        const id = session.id ?? session.sessionId ?? '(unknown)'
        const label = session.name ?? session.label ?? '(unnamed)'
        const type = session.type ?? session.protocol ?? 'ssh'
        const state = session.terminalState ?? (session.connected === false ? 'disconnected' : 'ready')
        // The saved connection is what the allowlist matches on; showing it lets
        // the model pick a session whose target it knows is permitted, and lets
        // it tell two same-named tabs apart.
        const source = session.sourceConnectionId ?? '(unreported)'
        const job = session.terminalJobId === undefined ? '' : `, job=${session.terminalJobId}`
        lines.push(`- ${label}  (sessionId=${id}, type=${type}, state=${state}, connection=${source}${job})`)
      }
      return lines.join('\n')
    },
  })

  /** nt_open — open a real, visible NyaTerm tab for an allowlisted connection. */
  register({
    name: 'nt_open',
    description: 'Open a terminal session in NyaTerm from a saved connection and return its sessionId for nt_exec. The connection must be inside the current workspace allowlist; a read-only target may still be opened for observation — only executing on it is blocked. Pass mode="reuse_or_create" to attach to an existing tab for that connection instead of always opening a new one, and idempotencyKey to make a retried open safe.',
    parameters: objectSchema({
      connectionId: { type: 'string', required: true, description: 'Exact connection id from nt_connections.' },
      mode: {
        type: 'string',
        enum: ['create', 'reuse_or_create'],
        description: 'Defaults to "create" (always a new tab). "reuse_or_create" attaches to an existing session for the connection when one exists.',
      },
      idempotencyKey: { type: 'string', description: 'Optional key that makes a retried open return the same result instead of opening a second tab.' },
    }),
    output: textOutput((value) => value),
    async execute(args, exec) {
      const { byId } = await fetchConnections()
      const connection = byId.get(String(args.connectionId))
      if (connection === undefined) {
        throw new Error(`Unknown connectionId "${args.connectionId}". Call nt_connections for the saved ids (ids of deleted or renamed connections go stale).`)
      }
      await authorize(exec, connection, 'session_open')
      const { structured } = await callNyaTermStrict('session_open', {
        connectionId: connection.id,
        ...(args.mode === undefined ? {} : { mode: args.mode }),
        ...(args.idempotencyKey === undefined ? {} : { idempotencyKey: args.idempotencyKey }),
      })
      const sessionId = structured?.sessionId ?? structured?.session?.sessionId
      if (sessionId === undefined) {
        throw new Error(`NyaTerm session_open reported success for "${connection.name}" but returned no sessionId. Raw: ${JSON.stringify(structured)?.slice(0, 500) ?? '(none)'}`)
      }
      // The in-memory mapping is the authoritative one for the tab just opened;
      // NyaTerm's sourceConnectionId covers every other tab.
      rememberSession(sessionId, connection.id)
      return `Opened "${connection.name}" in NyaTerm.\nsessionId: ${sessionId}\nPass this sessionId to nt_exec, nt_job_start or the nt_fs_* tools.`
    },
  })

  /** nt_exec — run a command inside an allowlisted NyaTerm session. */
  register({
    name: 'nt_exec',
    description: 'Execute a command in an existing NyaTerm session and return its captured output. The command is typed into the session that already exists, so its working directory, exported variables and other shell state persist between calls — do not assume a fresh login, and re-establish anything you depend on. Commands run non-interactively: never start something that waits on stdin (password prompt, pager, package manager without -y, ssh without -o BatchMode=yes) — it blocks until the timeout, and a full-screen program already running in the tab makes the call time out with no output. For anything long-running, or when the tab may be busy, prefer nt_job_start with a connectionId (independent ssh_exec channel, longer timeout, pollable and interruptible). Do not run irreversible operations (format, erase config, reboot, rm -rf) unless the user explicitly asked for them; NyaTerm applies its own approval policy. A target marked read-only in the workspace allowlist is refused here — open it and read its output instead. Pass sessionId from nt_open or nt_sessions. A CLI network device (H3C/Huawei Comware, Cisco IOS) has no shell: send its CLI commands, and because paged output hangs until the timeout, put `screen-length disable` (Comware) on its own line first — or `terminal length 0` on IOS — in the SAME command, e.g. "screen-length disable\\ndisplay interface brief".',
    parameters: objectSchema({
      command: { type: 'string', required: true, description: 'Shell command to type into the session.' },
      sessionId: { type: 'string', description: 'Target NyaTerm session id. Omit to use the default session.' },
      timeoutMs: { type: 'integer', description: 'Optional timeout in milliseconds for the command (NyaTerm caps each call at 300000).' },
      idempotencyKey: { type: 'string', description: 'Optional key so a retried call does not run the command twice.' },
    }),
    output: textOutput((value) => value),
    async execute(args, exec) {
      const sessionId = typeof args.sessionId === 'string' && args.sessionId.length > 0 ? args.sessionId : undefined
      const run = async (target) => {
        const result = await callNyaTermStrict('terminal_execute', {
          command: args.command,
          ...(target === undefined ? {} : { sessionId: target }),
          ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
          ...(args.idempotencyKey === undefined ? {} : { idempotencyKey: args.idempotencyKey }),
        })
        const unwrapped = await unwrapResult(result)
        if (unwrapped.wrapper && unwrapped.structured === undefined) {
          return `${stripTerminalControls(unwrapped.text)}\n[NyaTerm: the result was too large to read in full]`
        }
        return describeExecResult(unwrapped.structured, unwrapped.text)
      }
      if (sessionId === undefined) {
        if (!cfg.enforceAllowlist) return run(undefined)
        const store = readStore()
        const entry = resolveEntry(cfg, store, sessionCwd(exec))
        if (entry.unconfigured) {
          throw new Error(`NyaTerm terminal_execute is denied: workspace "${sessionCwd(exec) ?? '(unknown)'}" is not listed in the allowlist (${storeFile}), and no sessionId was given to check. Add the workspace, or pass an allowlisted sessionId.`)
        }
        throw new Error('A sessionId is required in an allowlisted workspace: without one, the target connection cannot be checked against the allowlist. Call nt_sessions or nt_open first.')
      }
      await authorizeSession(exec, sessionId, 'terminal_execute')
      return run(sessionId)
    },
  })

  /** nt_job_start — start a long-running command as a NyaTerm job. */
  register({
    name: 'nt_job_start',
    description: 'Start a command as an asynchronous NyaTerm job and return a jobId. Unlike nt_exec, the call returns immediately and the job keeps running while you poll it with nt_job_poll and interrupt it with nt_job_stop. With connectionId the command runs on NyaTerm\'s independent ssh_exec channel (no tab needed, timeout up to 86400000 ms, and a busy tab cannot break it). With sessionId it runs inside that existing session (inline_pty). Use idempotencyKey so a retry does not start the command twice. The target connection must pass the workspace allowlist; a read-only target may start no job.',
    parameters: objectSchema({
      command: { type: 'string', required: true, description: 'Command to run. It does not inherit an interactive shell\'s cwd or environment on the ssh_exec channel.' },
      connectionId: { type: 'string', description: 'Saved connection to run on (ssh_exec, independent channel). Pass this or sessionId, not both.' },
      sessionId: { type: 'string', description: 'Open session to run inside (inline_pty). Pass this or connectionId, not both.' },
      timeoutMs: { type: 'integer', description: 'Optional job timeout in milliseconds (NyaTerm allows 1000–86400000).' },
      idempotencyKey: { type: 'string', description: 'Optional key that makes a retried start return the same job instead of starting another.' },
    }),
    output: textOutput((value) => value),
    async execute(args, exec) {
      const connectionId = typeof args.connectionId === 'string' && args.connectionId.length > 0 ? args.connectionId : undefined
      const sessionId = typeof args.sessionId === 'string' && args.sessionId.length > 0 ? args.sessionId : undefined
      if (connectionId !== undefined && sessionId !== undefined) {
        throw new Error('Pass only one of connectionId and sessionId to nt_job_start: they are different targets and NyaTerm refuses both at once.')
      }
      if (connectionId === undefined && sessionId === undefined && cfg.enforceAllowlist) {
        // Without a target the plugin cannot prove which connection runs the
        // job, so an enforcing workspace refuses; NyaTerm's own "default
        // session" fallback is only reachable when the allowlist is off.
        throw new Error('Pass connectionId (saved connection, ssh_exec) or sessionId (open session, inline_pty) to nt_job_start. One is required so the target can be checked against the allowlist.')
      }
      let connection
      let payload = {}
      if (connectionId !== undefined) {
        const { byId } = await fetchConnections()
        connection = byId.get(connectionId)
        if (connection === undefined) {
          throw new Error(`Unknown connectionId "${connectionId}". Call nt_connections for the saved ids (ids of deleted or renamed connections go stale).`)
        }
        if (String(connection.type ?? '') !== 'ssh') {
          throw new Error(`connectionId "${connectionId}" is a ${String(connection.type ?? 'non-SSH')} connection, and NyaTerm only accepts a connection target over ssh_exec. Open it with nt_open and pass its sessionId instead.`)
        }
        const authorized = await authorize(exec, connection, 'terminal_start')
        connection = authorized.connection ?? connection
        payload = { target: { type: 'connection', connectionId: String(connection.id) }, backend: 'ssh_exec' }
      } else if (sessionId !== undefined) {
        const authorized = await authorizeSession(exec, sessionId, 'terminal_start')
        connection = authorized?.connection
        payload = { target: { type: 'session', sessionId: String(sessionId) }, backend: 'inline_pty' }
      }
      // With the allowlist off, an omitted target is passed straight through and
      // NyaTerm starts the job in its active/default session.
      const { structured } = await callNyaTermStrict('terminal_start', {
        command: args.command,
        ...payload,
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
        ...(args.idempotencyKey === undefined ? {} : { idempotencyKey: args.idempotencyKey }),
      })
      const jobId = structured?.jobId
      if (typeof jobId !== 'string' || jobId.length === 0) {
        throw new Error(`NyaTerm terminal_start returned no jobId (raw: ${JSON.stringify(structured)?.slice(0, 300) ?? '(none)'}).`)
      }
      const record = {
        connectionId: connection?.id === undefined ? undefined : String(connection.id),
        sessionId: typeof structured?.sessionId === 'string' ? structured.sessionId : sessionId,
        backend: structured?.backend ?? payload.backend,
        offset: 0,
      }
      rememberJob(jobId, record)
      return `Started job ${jobId} (backend=${record.backend}, status=${structured?.status ?? 'unknown'}).\nPoll it with nt_job_poll jobId=${jobId}; interrupt it with nt_job_stop.`
    },
  })

  /** nt_job_poll — read a job's incremental output and state. */
  register({
    name: 'nt_job_poll',
    description: 'Read the incremental output and execution state of a job started by nt_job_start. Each call returns output produced since the previous poll (the plugin tracks the offset) plus status, processState and exitCode; eof only means this is the current output tail, not that the command finished — check status. Read-only.',
    parameters: objectSchema({
      jobId: { type: 'string', required: true, description: 'jobId returned by nt_job_start.' },
      offset: { type: 'integer', description: 'Optional byte offset to read from instead of the one this plugin last returned.' },
      maxBytes: { type: 'integer', description: 'Optional chunk size in bytes (NyaTerm caps it at 65536).' },
    }),
    output: textOutput((value) => value),
    async execute(args, exec) {
      const jobId = String(args.jobId)
      const record = await authorizeJob(exec, jobId, 'terminal_poll')
      const offset = args.offset === undefined ? (record?.offset ?? 0) : args.offset
      const { structured } = await callNyaTermStrict('terminal_poll', {
        jobId,
        offset,
        ...(args.maxBytes === undefined ? {} : { maxBytes: args.maxBytes }),
      })
      const next = typeof structured?.nextOffset === 'number' ? structured.nextOffset : offset
      if (record !== undefined) record.offset = next
      const output = typeof structured?.output === 'string' ? stripTerminalControls(structured.output) : ''
      const status = structured?.status ?? 'unknown'
      const state = structured?.processState ?? 'unknown'
      const exit = structured?.exitCode === undefined || structured?.exitCode === null ? '-' : structured.exitCode
      const lines = [`job ${jobId}: status=${status} process=${state} exitCode=${exit} offset=${offset}->${next} totalBytes=${formatBytes(structured?.totalBytes)}`]
      if (structured?.sourceTruncated === true) lines.push('(NyaTerm truncated this chunk)')
      if (structured?.droppedBeforeOffset === true) lines.push('(earlier output was dropped by NyaTerm before this offset)')
      lines.push(output.length > 0 ? output : '(no new output since the last poll)')
      return lines.join('\n')
    },
  })

  /** nt_job_stop — interrupt a running job. */
  register({
    name: 'nt_job_stop',
    description: 'Request one interrupt of a job started by nt_job_start. "accepted" or "sent" does not prove the remote command has exited — poll the job afterwards to confirm. A job running in an inline terminal may need manual recovery in NyaTerm. Write operation against the job\'s target.',
    parameters: objectSchema({
      jobId: { type: 'string', required: true, description: 'jobId returned by nt_job_start.' },
    }),
    output: textOutput((value) => value),
    async execute(args, exec) {
      const jobId = String(args.jobId)
      await authorizeJob(exec, jobId, 'terminal_stop')
      const { structured } = await callNyaTermStrict('terminal_stop', { jobId })
      const lines = [
        `Stop requested for job ${jobId}: status=${structured?.status ?? 'unknown'}, stopState=${structured?.stopState ?? 'unknown'}, processState=${structured?.processState ?? 'unknown'}.`,
        'This does not prove the command exited. Poll with nt_job_poll until status is completed, failed, cancelled or timed_out.',
      ]
      return lines.join('\n')
    },
  })

  /** nt_output — read terminal output that no tool call has already captured. */
  register({
    name: 'nt_output',
    description: 'Read terminal output from a NyaTerm session that no tool call has already captured — for example output from commands the user typed in that tab, or from a job left running there. Terminal control sequences are stripped. nt_exec already returns its own command\'s output, so this is normally empty right after nt_exec. When the session\'s recent buffer is larger than NyaTerm returns inline, this tool reads the page and, if it exceeds its own budget, hands back an outputId for nt_output_read. Read-only.',
    parameters: objectSchema({
      sessionId: { type: 'string', required: true, description: 'Target NyaTerm session id.' },
      lines: { type: 'integer', description: 'How many trailing lines to read (NyaTerm accepts 1–500). Omit for the whole recent buffer.' },
    }),
    output: textOutput((value) => value),
    async execute(args, exec) {
      const sessionId = String(args.sessionId)
      const authorized = await authorizeSession(exec, sessionId, 'terminal_recent_output')
      const result = await callNyaTermStrict('terminal_recent_output', {
        sessionId,
        ...(args.lines === undefined ? {} : { lines: args.lines }),
      })
      const unwrapped = await unwrapResult(result)
      const value = typeof unwrapped.structured?.output === 'string' ? unwrapped.structured.output : unwrapped.text
      const output = stripTerminalControls(value)
      if (unwrapped.wrapper && !unwrapped.complete && unwrapped.outputId !== undefined) {
        // Keep the rest reachable, but only through the allowlist check.
        if (cfg.enforceAllowlist) rememberOutput(unwrapped.outputId, { connectionId: authorized?.connection?.id })
        return `${output}\n[NyaTerm: output truncated (${formatBytes(unwrapped.total)} total); continue with nt_output_read outputId=${unwrapped.outputId} offset=${unwrapped.resume}]`
      }
      // The output contract is a string, and `JSON.stringify(undefined)` is
      // `undefined` — which would fail output validation instead of reporting
      // an empty read. An empty read is also worth naming: NyaTerm returns
      // `{output: ""}` rather than an error, and a bare empty result reads as a
      // broken tool.
      if (output.trim().length > 0) return output
      return `(no uncaptured output for session ${args.sessionId}: NyaTerm reports nothing new since the last read. A command run through nt_exec returns its own output; this call only sees output that no tool call captured.)`
    },
  })

  /** nt_output_read — page through a large result NyaTerm wrapped. */
  register({
    name: 'nt_output_read',
    description: 'Read another chunk of a large NyaTerm result that this plugin handed back as an outputId. NyaTerm replaces oversized results with a page marker; nt_output and the nt_fs_* tools read what they need and return an outputId only when more remains. data is the raw result text sliced at byte offsets chosen by NyaTerm. Read-only.',
    parameters: objectSchema({
      outputId: { type: 'string', required: true, description: 'outputId printed by a previous result.' },
      offset: { type: 'integer', required: true, description: 'Byte offset to start at (use the offset printed by the previous call).' },
      maxBytes: { type: 'integer', description: 'Chunk size in bytes (NyaTerm caps it at 65536).' },
    }),
    output: textOutput((value) => value),
    async execute(args, exec) {
      await authorizeOutput(exec, String(args.outputId), 'output_read')
      const { structured } = await callNyaTermStrict('tool_output_read', {
        outputId: String(args.outputId),
        offset: args.offset,
        ...(args.maxBytes === undefined ? {} : { maxBytes: args.maxBytes }),
      })
      const data = typeof structured?.data === 'string' ? structured.data : ''
      const next = typeof structured?.nextOffset === 'number' ? structured.nextOffset : args.offset + data.length
      const eof = structured?.eof === true
      const hint = eof
        ? 'end of this result'
        : `continue with offset=${next}`
      return `${data}\n[NyaTerm: offset ${args.offset}->${next} of ${formatBytes(structured?.totalBytes)}; ${hint}]`
    },
  })

  // -------------------------------------------------------------------------
  // SFTP: remote file operations on an allowlisted target
  //
  // Every tool takes either `sessionId` (an open, already-authorized session) or
  // `connectionId` (a saved connection, which NyaTerm reaches over an
  // independent ssh_exec channel and therefore needs no open tab).
  // -------------------------------------------------------------------------

  /** nt_fs_home — remote home directory. */
  register({
    name: 'nt_fs_home',
    description: 'Return the remote home directory of a NyaTerm target — an open session (sessionId) or a saved SSH connection (connectionId). Read-only.',
    parameters: objectSchema({
      sessionId: { type: 'string', description: 'Open NyaTerm session id. Pass this or connectionId.' },
      connectionId: { type: 'string', description: 'Saved SSH connection id. Pass this or sessionId.' },
    }),
    output: textOutput((value) => value),
    async execute(args, exec) {
      const { targetArgs } = await resolveFileTarget(exec, args, 'sftp_read')
      const { structured } = await callNyaTermStrict('sftp_home', targetArgs)
      return `Remote home: ${structured?.path ?? '(unknown)'}`
    },
  })

  /** nt_fs_list — list a remote directory. */
  register({
    name: 'nt_fs_list',
    description: 'List a remote directory over SFTP on an allowlisted target. Entries carry type, permissions, owner, group, size and mtime. Very large directories are read up to a 1 MiB budget; use a narrower path if a listing is truncated. Read-only.',
    parameters: objectSchema({
      path: { type: 'string', required: true, description: 'Remote directory path, e.g. /etc/nginx.' },
      sessionId: { type: 'string', description: 'Open NyaTerm session id. Pass this or connectionId.' },
      connectionId: { type: 'string', description: 'Saved SSH connection id. Pass this or sessionId.' },
      limit: { type: 'integer', description: 'Maximum entries to render (default 200, max 1000).' },
    }),
    output: textOutput((value) => value),
    async execute(args, exec) {
      const { targetArgs } = await resolveFileTarget(exec, args, 'sftp_read')
      const result = await callNyaTermStrict('sftp_list', { path: String(args.path), ...targetArgs })
      const unwrapped = await unwrapResult(result, FS_LIST_UNWRAP_BYTES)
      const items = Array.isArray(unwrapped.structured)
        ? unwrapped.structured
        : Array.isArray(unwrapped.structured?.items) ? unwrapped.structured.items : undefined
      if (items === undefined) {
        throw new Error(`NyaTerm sftp_list returned a listing this plugin could not read${unwrapped.total === undefined ? '' : ` (${formatBytes(unwrapped.total)})`}. List a narrower path.`)
      }
      const limit = Math.min(Math.max(Number.isInteger(args.limit) ? args.limit : 200, 1), 1000)
      const shown = items.slice(0, limit)
      const header = items.length > shown.length
        ? `${args.path} (${items.length} entries, first ${shown.length} shown):`
        : `${args.path} (${items.length} entries):`
      return [header, ...shown.map((entry, index) => formatFsEntry(entry, index + 1))].join('\n')
    },
  })

  /** nt_fs_stat — remote path metadata. */
  register({
    name: 'nt_fs_stat',
    description: 'Read metadata of one remote path over SFTP: whether it is a directory or symlink, size, permissions, owner/group, mtime and atime. Read-only.',
    parameters: objectSchema({
      path: { type: 'string', required: true, description: 'Remote path to stat.' },
      sessionId: { type: 'string', description: 'Open NyaTerm session id. Pass this or connectionId.' },
      connectionId: { type: 'string', description: 'Saved SSH connection id. Pass this or sessionId.' },
    }),
    output: textOutput((value) => value),
    async execute(args, exec) {
      const { targetArgs } = await resolveFileTarget(exec, args, 'sftp_read')
      const { structured } = await callNyaTermStrict('sftp_stat', { path: String(args.path), ...targetArgs })
      const kind = structured?.is_dir === true ? 'directory' : structured?.is_symlink === true ? 'symlink' : 'file'
      const lines = [
        `${args.path}: ${kind}, ${formatBytes(structured?.size)}, ${structured?.permissions ?? '?'} ${structured?.owner ?? '?'}/${structured?.group ?? '?'}`,
        `mtime ${formatMtime(structured?.mtime)}, atime ${formatMtime(structured?.atime)}`,
      ]
      if (structured?.symlink_target !== undefined && structured.symlink_target !== null) lines.push(`symlink target: ${structured.symlink_target}`)
      return lines.join('\n')
    },
  })

  /** nt_fs_read — read a remote text file. */
  register({
    name: 'nt_fs_read',
    description: 'Read a remote UTF-8 text file over SFTP. NyaTerm refuses a file larger than maxBytes instead of truncating it, so raise maxBytes (up to 65536) or read it in shell with head/tail for bigger files. The result ends with a metadata line for the file\'s size, hash and mtime — pass those to nt_fs_write as expectedSize/expectedHash/expectedMtime to avoid overwriting a file that changed meanwhile. Read-only.',
    parameters: objectSchema({
      path: { type: 'string', required: true, description: 'Remote file path.' },
      maxBytes: { type: 'integer', description: 'Maximum file size to accept, in bytes (default and cap 65536).' },
      sessionId: { type: 'string', description: 'Open NyaTerm session id. Pass this or connectionId.' },
      connectionId: { type: 'string', description: 'Saved SSH connection id. Pass this or sessionId.' },
    }),
    output: textOutput((value) => value),
    async execute(args, exec) {
      if (args.maxBytes !== undefined && (args.maxBytes < 1 || args.maxBytes > 65536)) {
        throw new Error('maxBytes must be between 1 and 65536: NyaTerm reads a remote text file in one piece and refuses to truncate it.')
      }
      const { targetArgs } = await resolveFileTarget(exec, args, 'sftp_read')
      const result = await callNyaTermStrict('sftp_read_text', {
        path: String(args.path),
        ...(args.maxBytes === undefined ? {} : { maxBytes: args.maxBytes }),
        ...targetArgs,
      })
      const unwrapped = await unwrapResult(result)
      const content = typeof unwrapped.structured?.content === 'string' ? unwrapped.structured.content : unwrapped.text
      const meta = unwrapped.structured
      const footer = meta === undefined
        ? '[NyaTerm metadata unavailable]'
        : `[NyaTerm metadata, not part of the file: ${formatBytes(meta.size)}, mtime ${formatMtime(meta.mtime)}, contentHash=${meta.contentHash ?? '?'}]`
      return `${content.length > 0 ? content : '(empty file)'}\n${footer}`
    },
  })

  /** nt_fs_write — write a remote text file with optional conflict protection. */
  register({
    name: 'nt_fs_write',
    description: 'Write a remote UTF-8 text file over SFTP (max 1 MiB). Pass expectedHash, expectedMtime or expectedSize to make the write conditional: NyaTerm refuses it when the file changed meanwhile, which prevents clobbering concurrent edits. force=true overwrites unconditionally. NyaTerm keeps a backup when it has to replace an existing file and reports its path. Write operation.',
    parameters: objectSchema({
      path: { type: 'string', required: true, description: 'Remote file path.' },
      content: { type: 'string', required: true, description: 'Full new file content (NyaTerm caps it at 1 MiB).' },
      expectedHash: { type: 'string', description: 'Optional SHA-256 hex of the file as you last read it.' },
      expectedMtime: { type: 'integer', description: 'Optional mtime (epoch seconds) the file had when you read it.' },
      expectedSize: { type: 'integer', description: 'Optional size in bytes the file had when you read it.' },
      force: { type: 'boolean', description: 'Overwrite even if the file exists and the guards do not match.' },
      sessionId: { type: 'string', description: 'Open NyaTerm session id. Pass this or connectionId.' },
      connectionId: { type: 'string', description: 'Saved SSH connection id. Pass this or sessionId.' },
    }),
    output: textOutput((value) => value),
    async execute(args, exec) {
      const { targetArgs } = await resolveFileTarget(exec, args, 'sftp_write')
      const { structured } = await callNyaTermStrict('sftp_write_text', {
        path: String(args.path),
        content: String(args.content),
        ...(args.expectedHash === undefined ? {} : { expectedHash: args.expectedHash }),
        ...(args.expectedMtime === undefined ? {} : { expectedMtime: args.expectedMtime }),
        ...(args.expectedSize === undefined ? {} : { expectedSize: args.expectedSize }),
        ...(args.force === undefined ? {} : { force: args.force }),
        ...targetArgs,
      })
      const backup = typeof structured?.backupPath === 'string' && structured.backupPath.length > 0 ? `, backup ${structured.backupPath}` : ''
      return `Wrote ${args.path}: ${structured?.status ?? 'saved'}, ${formatBytes(structured?.size)}, mtime ${formatMtime(structured?.mtime)}${backup}.`
    },
  })

  /** nt_fs_mkdir — create a remote directory. */
  register({
    name: 'nt_fs_mkdir',
    description: 'Create a remote directory over SFTP, optionally with an explicit mode such as "0755". Write operation.',
    parameters: objectSchema({
      path: { type: 'string', required: true, description: 'Remote directory path to create.' },
      mode: { type: 'string', description: 'Optional octal mode, e.g. "0755".' },
      sessionId: { type: 'string', description: 'Open NyaTerm session id. Pass this or connectionId.' },
      connectionId: { type: 'string', description: 'Saved SSH connection id. Pass this or sessionId.' },
    }),
    output: textOutput((value) => value),
    async execute(args, exec) {
      const { targetArgs } = await resolveFileTarget(exec, args, 'sftp_mkdir')
      const { structured } = await callNyaTermStrict('sftp_mkdir', {
        path: String(args.path),
        ...(args.mode === undefined ? {} : { mode: args.mode }),
        ...targetArgs,
      })
      return structured?.created === false ? `${args.path} already existed.` : `Created ${args.path}.`
    },
  })

  /** nt_fs_rename — rename or move a remote path. */
  register({
    name: 'nt_fs_rename',
    description: 'Rename or move a remote path over SFTP. Write operation.',
    parameters: objectSchema({
      oldPath: { type: 'string', required: true, description: 'Existing remote path.' },
      newPath: { type: 'string', required: true, description: 'New remote path.' },
      sessionId: { type: 'string', description: 'Open NyaTerm session id. Pass this or connectionId.' },
      connectionId: { type: 'string', description: 'Saved SSH connection id. Pass this or sessionId.' },
    }),
    output: textOutput((value) => value),
    async execute(args, exec) {
      const { targetArgs } = await resolveFileTarget(exec, args, 'sftp_rename')
      const { structured } = await callNyaTermStrict('sftp_rename', {
        oldPath: String(args.oldPath),
        newPath: String(args.newPath),
        ...targetArgs,
      })
      return structured?.renamed === false ? `Renamed nothing: ${args.oldPath} -> ${args.newPath}.` : `Renamed ${args.oldPath} -> ${args.newPath}.`
    },
  })

  /** nt_fs_delete — delete a remote path. */
  register({
    name: 'nt_fs_delete',
    description: 'Delete a remote file or directory over SFTP using NyaTerm\'s delete semantics. Deletion is irreversible, so confirm=true is required and the workspace allowlist must grant write access. Write operation.',
    parameters: objectSchema({
      path: { type: 'string', required: true, description: 'Remote path to delete.' },
      confirm: { type: 'boolean', required: true, description: 'Must be true. Deletion cannot be undone.' },
      sessionId: { type: 'string', description: 'Open NyaTerm session id. Pass this or connectionId.' },
      connectionId: { type: 'string', description: 'Saved SSH connection id. Pass this or sessionId.' },
    }),
    output: textOutput((value) => value),
    async execute(args, exec) {
      if (args.confirm !== true) {
        throw new Error('nt_fs_delete requires confirm=true: deletion is irreversible. Re-call with confirm=true only when the user asked for this exact deletion.')
      }
      const { targetArgs } = await resolveFileTarget(exec, args, 'sftp_delete')
      const { structured } = await callNyaTermStrict('sftp_delete', { path: String(args.path), ...targetArgs })
      return structured?.deleted === false ? `Nothing was deleted at ${args.path}.` : `Deleted ${args.path}.`
    },
  })

  /** nt_fs_chmod — change remote permissions. */
  register({
    name: 'nt_fs_chmod',
    description: 'Change permissions of a remote path over SFTP. Write operation.',
    parameters: objectSchema({
      path: { type: 'string', required: true, description: 'Remote path.' },
      mode: { type: 'string', required: true, description: 'New octal mode, e.g. "0644".' },
      sessionId: { type: 'string', description: 'Open NyaTerm session id. Pass this or connectionId.' },
      connectionId: { type: 'string', description: 'Saved SSH connection id. Pass this or sessionId.' },
    }),
    output: textOutput((value) => value),
    async execute(args, exec) {
      const { targetArgs } = await resolveFileTarget(exec, args, 'sftp_chmod')
      const { structured } = await callNyaTermStrict('sftp_chmod', { path: String(args.path), mode: String(args.mode), ...targetArgs })
      return structured?.changed === false ? `Permissions of ${args.path} were unchanged.` : `Changed permissions of ${args.path} to ${args.mode}.`
    },
  })

  /** nt_status — diagnose the bridge, the discovery document, and the scope. */
  register({
    name: 'nt_status',
    description: 'Diagnose the NyaTerm bridge: bridge path, discovery document, MCP permission mode, and the tools NyaTerm advertises. Call it when any nt_* tool fails. Read-only.',
    parameters: NO_ARGS,
    output: textOutput((value) => value),
    async execute() {
      const store = readStore()
      const savedBridge = typeof store.bridgeExecutable === 'string' ? store.bridgeExecutable : ''
      const { discoveryFile, bridge, source } = resolveTransport(cfg, ctx, savedBridge)
      const lines = [
        `bridge: ${bridge ?? '(not found)'}`,
        `bridge source: ${BRIDGE_SOURCES[source] ?? '(none)'}`,
        `discovery: ${discoveryFile ?? '(not found)'}`,
        `allowlist file: ${storeFile}`,
        `allowlist editor: Settings → NyaTerm 白名单${editorUrl() === undefined ? ' (no web server in this profile; edit the JSON file)' : ''}`,
      ]
      if (bridge !== undefined) {
        const inspected = inspectBridge(bridge)
        if (inspected.problem !== undefined) {
          lines.push(`bridge check: ${inspected.problem} — fix it in Settings → NyaTerm 白名单 → MCP 程序位置`)
        }
      }
      if (discoveryFile === undefined || bridge === undefined) {
        lines.push(`status: unavailable — ${transportFailure(cfg, ctx, savedBridge)}`)
        return lines.join('\n')
      }
      try {
        const document = readDiscovery(discoveryFile)
        lines.push(`endpoint: ${document.host}:${document.port}`)
        const mode = document.permissionMode
        lines.push(`permission mode: ${String(mode ?? '(unreported)')}`)
        // Observed on NyaTerm 2.0.x: the session reports
        // terminalExecution "send_only", the command is typed into the existing
        // tab, and shell state (cwd, exported variables) persists between calls.
        // Whether NyaTerm's audit records the insertion is NyaTerm's call; this
        // plugin no longer claims the command is hidden from the tab.
        if (mode === 'auto' || mode === 'full_access') {
          lines.push('command visibility: NyaTerm runs MCP commands inside the target session (each call is audited). On 2.0.x the session is send_only: the command goes into the existing tab and its cwd/env persist between calls.')
        } else if (mode === 'observer') {
          lines.push('command visibility: "observer" denies command execution to MCP clients — only reads work.')
        } else if (mode === 'confirm') {
          lines.push('command visibility: NyaTerm asks you to approve each command before it runs.')
        }
      } catch (error) {
        lines.push(`discovery unreadable: ${String(error?.message ?? error)}`)
      }
      try {
        const active = await connect()
        const tools = await active.listTools()
        const server = active.serverInfo()
        lines.push(`bridge version: ${server?.name ?? 'nyaterm-mcp'} ${server?.version ?? '(unknown)'}`)
        lines.push(`tools: ${tools.map((tool) => tool.name).join(', ')}`)
        const names = new Set(tools.map((tool) => tool.name))
        const required = ['connection_list', 'get_environment', 'session_open', 'session_get', 'terminal_execute', 'terminal_recent_output']
        const missingRequired = required.filter((name) => !names.has(name))
        if (missingRequired.length > 0) {
          lines.push(`bridge check: NyaTerm no longer advertises ${missingRequired.join(', ')} — this plugin cannot work against that build`)
        }
        // Advertised capabilities differ between NyaTerm releases; say which
        // nt_* tools will fail instead of letting the model discover it.
        const optional = ['terminal_start', 'terminal_poll', 'terminal_stop', 'sftp_home', 'sftp_list', 'sftp_stat', 'sftp_read_text', 'sftp_write_text', 'sftp_mkdir', 'sftp_rename', 'sftp_delete', 'sftp_chmod', 'tool_output_read']
        const missingOptional = optional.filter((name) => !names.has(name))
        if (missingOptional.length > 0) {
          lines.push(`optional tools unavailable on this bridge (nt_job_*, nt_fs_*, nt_output_read need them; upgrade NyaTerm): ${missingOptional.join(', ')}`)
        }
        lines.push('status: connected')
      } catch (error) {
        lines.push(`status: connection failed — ${String(error?.message ?? error)}`)
      }
      return lines.join('\n')
    },
  })

  // -------------------------------------------------------------------------
  // Backstop guard: monotonic denial for the same rules, plus observe-only
  // workspaces that must not call unrelated tools.
  // -------------------------------------------------------------------------

  /** nt_* tools that change the remote side; the guard can deny these on its own. */
  const NT_WRITE_TOOLS = new Set([
    'nt_exec', 'nt_job_start', 'nt_job_stop',
    'nt_fs_write', 'nt_fs_mkdir', 'nt_fs_rename', 'nt_fs_delete', 'nt_fs_chmod',
  ])

  ctx.tools.guard((exec) => {
    const toolName = String(exec?.name ?? '')
    if (!toolName.startsWith('nt_')) {
      if (!cfg.enforceAllowlist || !cfg.allowOtherTools) return undefined
      const cwd = sessionCwd(exec)
      const store = readStore()
      const entry = resolveEntry(cfg, store, cwd)
      if (entry.unconfigured && !cfg.defaultObserveOnly) return undefined
      if (!entry.observe) return undefined
      if (OBSERVE_READ_ONLY.has(toolName) || cfg.observeTools.includes(toolName)) return undefined
      return `Tool "${toolName}" is not permitted in observe-only workspace "${cwd ?? '(unknown)'}". This workspace may only read and observe NyaTerm sessions.`
    }
    if (!cfg.enforceAllowlist) return undefined
    // Information and read-only tools: the body applies the allowlist (and a
    // read-only target is exactly what they are for), so a guard denial here
    // would contradict the grant.
    if (toolName === 'nt_connections' || toolName === 'nt_sessions' || toolName === 'nt_status'
      || toolName === 'nt_workspace' || toolName === 'nt_output' || toolName === 'nt_output_read') {
      return undefined
    }
    const cwd = sessionCwd(exec)
    const store = readStore()
    const entry = resolveEntry(cfg, store, cwd)
    if (entry.unconfigured && !cfg.defaultObserveOnly) {
      return `NyaTerm ${toolName} is denied: workspace "${cwd ?? '(unknown)'}" is not listed in the allowlist (${storeFile}).`
    }
    // An observe-only workspace makes EVERY target read-only, so execution,
    // interruption and SFTP writes can never be authorized there — the one
    // denial this synchronous guard can prove on its own.
    if (!entry.unconfigured && entry.observe && NT_WRITE_TOOLS.has(toolName)) {
      return `NyaTerm ${toolName} is denied: workspace "${cwd ?? '(unknown)'}" is read-only. Sessions and files may be read, but nothing may be executed, started, stopped or written.`
    }
    if (toolName === 'nt_open') {
      const id = String(exec?.arguments?.connectionId ?? '')
      // The tool body resolves groups and read-only modes; the guard can only
      // check explicit ids, so anything group-based is left to the body.
      if (entry.connections.length > 0 && id.length > 0 && !entry.connections.includes(id)
        && entry.groups.length === 0 && entry.hosts.length === 0) {
        return `NyaTerm session_open is denied: connection "${id}" is outside the allowlist for workspace "${cwd ?? '(unknown)'}".`
      }
    }
    return undefined
  })

  // -------------------------------------------------------------------------
  // Editor page: the allowlist is a file, so give it a form
  //
  // Mounted on the Harness web server (same origin as the GUI, no extra process)
  // instead of a client UI plugin: client bundles must be built against the
  // client runtime, while this route is plain node http and every rule still
  // lands in the same hot-reloaded JSON the tools read.
  // -------------------------------------------------------------------------
  /** Lazy: the port is only known once the server listens, and it may not exist yet. */
  const editorUrl = () => {
    const server = ctx.get?.('webServer')
    return server === undefined ? undefined : `http://127.0.0.1:${server.port}/nyaterm/allowlist`
  }
  /** Register the editor routes on one concrete web server. */
  const registerEditor = (webServer) => {

    /** Reject untrusted/unauthenticated requests: this route edits permissions. */
    const rejected = (req, res) => {
      const connection = ctx.get?.('connection')
      const rejection = connection?.requestRejection?.(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return true
      }
      if (connection?.requestRejection !== undefined) return false
      // No connection service (headless profile): apply the same fence by hand.
      const host = String(req.headers.host ?? '')
      const loopback = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/u.test(host)
      let sameOrigin = true
      const origin = req.headers.origin
      if (origin !== undefined) {
        try {
          sameOrigin = new URL(origin).host === host
        } catch {
          sameOrigin = false
        }
      }
      if (loopback && sameOrigin && req.headers['sec-fetch-site'] !== 'cross-site') return false
      res.statusCode = 403
      res.end()
      return true
    }

    const sendJson = (res, status, payload) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(payload))
    }

    const methodNotAllowed = (res, allow) => {
      res.statusCode = 405
      res.setHeader('allow', allow)
      res.end()
    }

    /** Collect a bounded UTF-8 body; undefined past the ceiling. */
    const readBody = (req) => new Promise((resolve) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        // Node's http request emits Buffers, but normalize anyway: a string chunk
        // would otherwise reach Buffer.concat and throw instead of reporting 413.
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += bytes.length
        if (size > STORE_LIMITS.bytes) {
          resolve(undefined)
          req.destroy()
          return
        }
        chunks.push(bytes)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolve(undefined))
    })

    /** Everything the editor needs: the rules, the policy, and NyaTerm's real groups. */
    const buildState = async () => {
      let groups = []
      let connections = []
      let nyaTermError = null
      try {
        const fetched = await fetchConnections()
        connections = fetched.connections.map((entry) => ({
          id: String(entry.id),
          name: String(entry.name ?? ''),
          type: String(entry.type ?? ''),
          groupPath: Array.isArray(entry.groupPath) ? entry.groupPath.map(String) : [],
        }))
        groups = [...new Set(connections.map((entry) => entry.groupPath.join(' / ')).filter((value) => value.length > 0))].sort()
      } catch (error) {
        nyaTermError = String(error?.message ?? error)
      }
      // The editor offers this list instead of making the user type a path.
      // `workspaceRegistry.list()` is the durable DSH workspace order
      // (synchronous, no persistence read); the service is optional, so a
      // profile without workspaces simply gets an empty picker plus the
      // custom-path field.
      let workspaceCandidates = []
      try {
        const registry = ctx.get?.('workspaceRegistry')
        if (registry !== undefined && typeof registry.list === 'function') {
          workspaceCandidates = registry.list().map((workspace) => ({
            path: String(workspace.path),
            title: String(workspace.title ?? ''),
          }))
        }
      } catch (error) {
        ctx.logger?.warn?.(`nyaterm-bridge: workspace list unavailable (${String(error?.message ?? error)})`)
      }
      const raw = loadStore(storeFile)
      return {
        storeFile,
        storeDir,
        policy: {
          enforceAllowlist: cfg.enforceAllowlist,
          defaultObserveOnly: cfg.defaultObserveOnly,
          allowOtherTools: cfg.allowOtherTools,
          observeTools: cfg.observeTools,
        },
        workspaces: raw.workspaces,
        bridge: describeBridge(raw.bridgeExecutable),
        workspaceCandidates,
        groups,
        connections,
        nyaTermError,
      }
    }

    const saveStore = async (req, res) => {
      const body = await readBody(req)
      if (body === undefined) {
        sendJson(res, 413, { error: `request body larger than ${STORE_LIMITS.bytes} bytes` })
        return
      }
      let parsed
      try {
        parsed = JSON.parse(body)
      } catch {
        sendJson(res, 400, { error: 'request body is not JSON' })
        return
      }
      if (parsed === null || typeof parsed !== 'object') {
        sendJson(res, 400, { error: 'request body must be a JSON object' })
        return
      }
      const bridgeInput = sanitizeBridgePath(Object.hasOwn(parsed, 'bridgeExecutable') ? parsed.bridgeExecutable : undefined)
      const { workspaces, problems } = sanitizeWorkspaces(parsed.workspaces)
      const allProblems = [...bridgeInput.problems, ...problems]
      if (allProblems.length > 0) {
        sendJson(res, 400, { error: 'the settings were not saved', problems: allProblems })
        return
      }
      const raw = loadStore(storeFile) // keeps `_comment` and any other top-level keys
      raw.workspaces = workspaces
      const bridgeChanged = bridgeInput.value !== undefined
        && bridgeInput.value !== (typeof raw.bridgeExecutable === 'string' ? raw.bridgeExecutable : '')
      if (bridgeInput.value !== undefined) {
        if (bridgeInput.value.length === 0) delete raw.bridgeExecutable
        else raw.bridgeExecutable = bridgeInput.value
      }
      writeStoreAtomic(storeFile, raw)
      // The client is keyed on endpoint + bridge path, so a new path respawns on
      // the next call; dropping it here also reconnects immediately after a
      // bridge that had failed, without waiting for a rotation.
      if (bridgeChanged) releaseClient()
      const savedBridge = typeof raw.bridgeExecutable === 'string' ? raw.bridgeExecutable : ''
      ctx.logger?.info?.(`nyaterm-bridge: settings saved from the editor (${Object.keys(workspaces).length} workspace rules, bridge ${savedBridge.length > 0 ? savedBridge : 'auto-detect'})`)
      sendJson(res, 200, { ok: true, workspaces, bridgeExecutable: savedBridge, bridge: describeBridge(savedBridge) })
    }

    const handleEditor = async (req, res) => {
      if (rejected(req, res)) return
      const { pathname } = new URL(String(req.url ?? '/'), 'http://127.0.0.1')
      if (pathname === '/nyaterm/api/allowlist') {
        if (req.method === 'GET') {
          sendJson(res, 200, await buildState())
          return
        }
        if (req.method === 'PUT' || req.method === 'POST') {
          await saveStore(req, res)
          return
        }
        methodNotAllowed(res, 'GET, PUT')
        return
      }
      // The UI is the client settings page (Settings → NyaTerm 白名单); this
      // server only carries its data. A standalone HTML editor used to live
      // here and was dropped: it could not express the per-target read-only
      // lists, so saving from it would have silently erased them.
      sendJson(res, 404, { error: `unknown nyaterm-bridge route ${pathname}`, ui: '/nyaterm/api/allowlist is the API; the page is Settings → NyaTerm 白名单' })
    }

    ctx.effect(
      () => webServer.register({ kind: 'prefix', path: '/nyaterm', handler: handleEditor }),
      'nyaterm-bridge: allowlist editor route',
    )
  }

  // `webServer` is NOT active when this plugin applies — the plugin loads on
  // `tools`, while the web server row activates later — so a one-shot
  // ctx.get('webServer') here is always undefined and registering eagerly would
  // silently leave no route at all (404 on the page). Inject reactively instead;
  // cordis runs the callback when the service is available.
  //
  // Guarded because a plugin that throws during apply takes the whole row down:
  // on a host without cordis's inject (or in a bare unit-test context) the tools
  // still work and only the editor route is missing.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.logger?.info?.(`nyaterm-bridge: allowlist route at http://127.0.0.1:${webCtx.webServer.port}/nyaterm/allowlist`)
      registerEditor(webCtx.webServer)
    })
  } else {
    const server = ctx.get?.('webServer')
    if (server !== undefined) registerEditor(server)
  }

  ctx.logger?.info?.(`nyaterm-bridge: nt_* tools registered (allowlist ${storeFile})`)
}
