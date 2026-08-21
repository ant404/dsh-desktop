// Host half of the dsh-desktop plugin. Runs inside the dsh web server process
// (the desktop shell's child), so it has real fs + child_process: it serves
// version info, applies engine updates and restarts the client directly, no
// IPC needed.
//
// Three routes on the web server:
//   GET  /dsh-desktop/info       → { appVersion, runtimeVersion, nodeVersion, dataDir, runtimeDir, updatedRuntime }
//   POST /dsh-desktop/update     → { action: 'check' } | { action: 'apply' }
//   POST /dsh-desktop/restart    → write <dataDir>/restart.request; the Electron
//                                  shell (patched main.js) watches that file and
//                                  calls app.relaunch()+app.quit() itself.
//
// The update installs the latest @deepseek-ai/dsh into <dataDir>/runtime/
// (npm install --prefix, full dependency tree, native prebuilds allowed),
// swaps it in atomically and re-copies this plugin into the new runtime.
// The server cannot restart itself, so the card tells the user to restart the
// app; the next launch boots the updated runtime.
'use strict'

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-desktop'

const PKG = '@deepseek-ai/dsh'
const REGISTRY_DIST_TAGS = `https://registry.npmjs.org/-/package/${PKG}/dist-tags`
const PKG_SEGMENTS = PKG.split('/')

/** The dsh runtime root: <runtime>/node_modules/dsh-desktop → <runtime>. */
const RUNTIME_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function readVersion(dir) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function parseVersion(v) {
  const [core, pre] = String(v).split('-')
  const nums = (core || '0.0.0').split('.').map((n) => Number(n) || 0)
  let preParts = null
  if (pre) preParts = pre.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p))
  return { nums, preParts }
}

function compareVersions(lhs, rhs) {
  const a = parseVersion(lhs)
  const b = parseVersion(rhs)
  for (let i = 0; i < 3; i++) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] - b.nums[i]
  }
  if (a.preParts === null && b.preParts === null) return 0
  if (a.preParts === null) return 1
  if (b.preParts === null) return -1
  for (let i = 0; i < Math.max(a.preParts.length, b.preParts.length); i++) {
    const x = a.preParts[i]
    const y = b.preParts[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y
    } else {
      const xs = String(x)
      const ys = String(y)
      if (xs !== ys) return xs < ys ? -1 : 1
    }
  }
  return 0
}

const isNewer = (lhs, rhs) => compareVersions(lhs, rhs) > 0

/**
 * Resolve the update target from the registry dist-tags: prefer `latest`,
 * then compare `next` (pre-release) and return whichever is newer.
 * @param {number} [timeoutMs]
 * @returns {Promise<string>}
 */
async function fetchLatestVersion(timeoutMs = 15000) {
  const res = await fetch(REGISTRY_DIST_TAGS, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`registry responded ${res.status}`)
  const json = await res.json()
  if (!json || typeof json.latest !== 'string') throw new Error('registry returned no latest version')
  const latest = json.latest
  const next = typeof json.next === 'string' ? json.next : null
  if (next && isNewer(next, latest)) return next
  return latest
}

/**
 * Probe whether npm can actually resolve the concrete version using the same
 * resolution path as the install (pacote + the `--prefer-offline` cache).
 * A dist-tag can point at a version whose object is published but which is
 * still missing from the packument npm sees, so `npm install` fails with
 * ETARGET even though the version endpoint answers 200. Running `npm view`
 * with the same flags reproduces that failure during the check phase.
 * @param {string} version
 * @returns {Promise<boolean>}
 */
async function probeNpmVersion(version) {
  try {
    const result = await runNpm([
      'view', `${PKG}@${version}`, 'version',
      '--no-audit', '--no-fund', '--prefer-offline',
    ])
    if (result.code !== 0 && /ETARGET|No matching version found|E404|No match found for version/i.test(result.stderr)) return false
  } catch {
    /* npm missing etc: do not block check; apply will surface the real error */
  }
  return true
}

/** Locate npm's CLI entry (npm-cli.js) via the npm.cmd shim on PATH. */
function resolveNpmCli() {
  const pathEntries = (process.env.PATH || '').split(';')
  for (const entry of pathEntries) {
    const dir = entry.trim()
    if (!dir) continue
    try {
      const cmd = join(dir, 'npm.cmd')
      if (existsSync(cmd)) {
        const cli = join(dirname(cmd), 'node_modules', 'npm', 'bin', 'npm-cli.js')
        if (existsSync(cli)) return cli
      }
    } catch {
      /* keep probing */
    }
  }
  return null
}

/** Run an npm command; resolves { code, stderr }.
 * Invoked as `node npm-cli.js <args>` — no cmd.exe, so paths with spaces and
 * special characters survive untouched (Node quotes argv correctly without a
 * shell; cmd's /s /c quote-stripping used to mangle them). */
function runNpm(args) {
  return new Promise((resolvePromise, reject) => {
    const npmCli = resolveNpmCli()
    if (!npmCli) {
      reject(new Error('npm not found on PATH (npm.cmd + npm-cli.js missing)'))
      return
    }
    const child = spawn(process.execPath, [npmCli, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => resolvePromise({ code, stderr }))
  })
}

/**
 * Install the latest dsh into <dataDir>/runtime/dsh-runtime and re-copy this
 * plugin into the fresh runtime.
 * @param {string} dataDir
 * @param {(phase: string) => void} [onPhase] - progress callback
 * @returns {Promise<{version: string}>}
 */
async function applyUpdate(dataDir, onPhase, config = {}) {
  const latest = await fetchLatestVersion()
  onPhase?.('installing')
  const runtimeRoot = join(dataDir, 'runtime')
  const work = join(runtimeRoot, 'work')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })

  const result = await runNpm([
    'install',
    '--prefix', work,
    '--no-audit', '--no-fund',
    '--prefer-offline',
    '--dangerously-allow-all-scripts',
    `${PKG}@${latest}`,
  ])
  if (result.code !== 0) {
    const stderr = result.stderr.slice(0, 400)
    if (/ETARGET|No matching version found/i.test(stderr)) {
      throw new Error(`${latest} 已发布但 npm 索引尚未同步，暂不可更新，请稍后重试（原始错误：${stderr}）`)
    }
    throw new Error(`npm install failed (code ${result.code}): ${stderr}`)
  }

  const installed = join(work, 'node_modules', ...PKG_SEGMENTS)
  if (!existsSync(join(installed, 'lib', 'bin.js'))) {
    throw new Error('installed package is missing lib/bin.js')
  }

  // Merge the hoisted dependency tree + the package's own files into the new
  // runtime dir, atomically.
  onPhase?.('swapping')
  const dest = join(runtimeRoot, 'dsh-runtime')
  const tmp = join(runtimeRoot, `.dsh-runtime-${Date.now()}`)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  cpSync(join(work, 'node_modules'), join(tmp, 'node_modules'), { recursive: true, verbatimSymlinks: true })
  for (const entry of readdirSync(installed)) {
    if (entry === 'node_modules') continue
    cpSync(join(installed, entry), join(tmp, entry), { recursive: true, verbatimSymlinks: true })
  }
  // Re-inject this plugin into the updated runtime so the settings card and
  // routes survive the swap. Prefer the app's SHIPPED copy (always current
  // with the app build) over the running copy (which may be a stale injected
  // one without the latest card/namespace fixes).
  const pluginSource = config.pluginDir && existsSync(join(config.pluginDir, 'index.js')) ? config.pluginDir : PLUGIN_DIR
  cpSync(pluginSource, join(tmp, 'node_modules', 'dsh-desktop'), { recursive: true, verbatimSymlinks: true })

  // Preserve the last-known-good runtime as the rollback fallback: before a
  // fresh version replaces it, keep the current one as `dsh-runtime.previous`
  // so a broken update can be undone by swapping the two folders.
  if (existsSync(dest)) {
    const prev = join(runtimeRoot, 'dsh-runtime.previous')
    rmSync(prev, { recursive: true, force: true })
    renameSync(dest, prev)
  }
  renameSync(tmp, dest)
  rmSync(work, { recursive: true, force: true })
  return { version: latest }
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

function isTrustedRequest(req) {
  const host = req.headers?.host
  if (typeof host !== 'string' || host === '') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!(hostUrl.hostname === '127.0.0.1' || hostUrl.hostname === '::1' || hostUrl.hostname === 'localhost')) return false
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers?.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > limit) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function registerRoutes(ctx, config) {
  ctx.webServer.register({
    name: 'dsh-desktop-info',
    kind: 'exact',
    path: '/dsh-desktop/info',
    handler: async (req, res) => {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (!isTrustedRequest(req)) {
        send(403, { error: 'request refused: loopback only' })
        return
      }
      const updatedRuntime = join(config.dataDir || '', 'runtime', 'dsh-runtime')
      send(200, {
        appVersion: config.appVersion || 'unknown',
        runtimeVersion: config.runtimeVersion || readVersion(RUNTIME_DIR),
        nodeVersion: process.versions.node,
        dataDir: config.dataDir || '',
        dataDirLabel: config.dataDirLabel || config.dataDir || '',
        runtimeDir: RUNTIME_DIR,
        updatedRuntime: existsSync(join(updatedRuntime, 'lib', 'bin.js')),
      })
    },
  })

  ctx.webServer.register({
    name: 'dsh-desktop-update',
    kind: 'exact',
    path: '/dsh-desktop/update',
    handler: async (req, res) => {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (!isTrustedRequest(req)) {
        send(403, { error: 'request refused: loopback only' })
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      let action = 'check'
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        action = body?.action === 'apply' ? 'apply' : 'check'
      } catch {
        /* default to check */
      }
      try {
        const current = readVersion(RUNTIME_DIR)
        if (action === 'apply') {
          if (updateState.busy) {
            send(409, { busy: true, phase: updateState.phase, error: 'another update is already running' })
            return
          }
          updateState.busy = true
          updateState.phase = 'installing'
          updateState.error = ''
          updateState.version = ''
          updateState.startedAt = Date.now()
          try {
            const { version } = await applyUpdate(config.dataDir || '', (phase) => {
              updateState.phase = phase
            }, config)
            updateState.version = version
            updateState.phase = 'done'
            send(200, { updated: true, version, restart: true })
          } catch (error) {
            updateState.phase = 'error'
            updateState.error = String(error?.message ?? error)
            send(409, { error: updateState.error })
          } finally {
            updateState.busy = false
          }
        } else {
          const latest = await fetchLatestVersion()
          const updateAvailable = isNewer(latest, current)
          if (updateAvailable && !(await probeNpmVersion(latest))) {
            send(200, {
              current,
              latest,
              updateAvailable: false,
              uninstallable: true,
              reason: `${latest} 已发布但 npm 索引尚未同步，暂不可更新，请稍后重试`,
            })
            return
          }
          send(200, { current, latest, updateAvailable })
        }
      } catch (error) {
        send(409, { error: String(error?.message ?? error) })
      }
    },
  })

  // Server-side update status: survives page refreshes (the in-flight apply
  // keeps running server-side; the card polls this to restore the state).
  ctx.webServer.register({
    name: 'dsh-desktop-update-status',
    kind: 'exact',
    path: '/dsh-desktop/update/status',
    handler: async (req, res) => {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (!isTrustedRequest(req)) {
        send(403, { error: 'request refused: loopback only' })
        return
      }
      send(200, {
        busy: updateState.busy,
        phase: updateState.phase,
        version: updateState.version,
        error: updateState.error,
        startedAt: updateState.startedAt,
      })
    },
  })

  // Restart the desktop client — the card's 重启客户端 button. Writes
  // <dataDir>/restart.request; the Electron shell (patched main.js) polls that
  // file and performs app.relaunch()+app.quit() itself — a clean self-managed
  // restart. Only meaningful inside DSH Desktop (loopback + POST + dataDir),
  // otherwise 409.
  ctx.webServer.register({
    name: 'dsh-desktop-restart',
    kind: 'exact',
    path: '/dsh-desktop/restart',
    handler: async (req, res) => {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (!isTrustedRequest(req)) {
        send(403, { error: 'request refused: loopback only' })
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      try {
        await readBody(req)
      } catch {
        /* body is irrelevant */
      }
      const dataDir = config.dataDir || ''
      if (!dataDir) {
        send(409, { error: 'restart unavailable: not running inside DSH Desktop' })
        return
      }
      try {
        writeFileSync(join(dataDir, 'restart.request'), JSON.stringify({ t: Date.now(), pid: process.pid }))
        send(200, { restarting: true })
      } catch (error) {
        send(409, { error: String(error?.message ?? error) })
      }
    },
  })
}

// Server-side update state, queryable via GET /dsh-desktop/update/status so a
// page refresh (or a second card) re-syncs with the in-flight apply.
const updateState = { busy: false, phase: '', version: '', error: '', startedAt: 0 }

export function apply(ctx, config = {}) {
  // A served settings namespace is what makes the settings tab dispatch this
  // plugin's card on rc.7 (cards whose key is not among the host's served
  // namespaces are silently hidden). The card itself uses its own routes, so
  // the schema is empty — registering the namespace is all that is needed.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (sctx) => {
      try {
        sctx.settings.register('dsh-desktop', z.object({}), { base: {} })
      } catch (error) {
        console.error(`[dsh-desktop] settings namespace skipped: ${error}`)
      }
    })
    // webServer is optional (no web profile → no routes); ride a scoped inject.
    ctx.inject(['webServer'], (scope) => {
      try {
        registerRoutes(scope, config)
      } catch (error) {
        console.error(`[dsh-desktop] routes skipped: ${error}`)
      }
    })
  }
}

// Exported for the plain-node test suite (the same pattern modlens uses).
export const __update = { applyUpdate, fetchLatestVersion, isNewer, readVersion }
