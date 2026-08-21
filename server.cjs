// server.cjs — spawns, health-checks and stops the `dsh web` server for the
// desktop shell. Plain CommonJS so it runs under Electron's main process AND
// under a bare `node` for offline tests.
//
// Runtime strategy:
//   * In a packaged build the whole `@deepseek-ai/dsh` install (CLI + nested
//     node_modules + built web frontend) is shipped unpacked under
//     <resources>/dsh-runtime.
//   * The server is spawned as a *separate* child process so a crash in dsh
//     never takes the window host down. Packaged, the child is
//     `electron.exe` re-invoked with ELECTRON_RUN_AS_NODE=1 — Electron ships
//     its own Node, so no system Node is required on the target machine.
'use strict';

const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const DSH_BIN_REL = path.join('lib', 'bin.js');

/**
 * Whether the chosen dsh runtime's `web` command supports `--no-open` (which
 * suppresses opening the default browser). rc.7+/latest define it; older
 * bundles (e.g. rc.6) do not — and passing an undefined commander option
 * there makes `dsh web` fail to start, so only append it when supported.
 * @param {string|null} runtime runtime dir (path to a dir with lib/bin.js)
 * @returns {boolean}
 */
function runtimeSupportsNoOpen(runtime) {
  try {
    const startup = path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'lib', 'startup.js');
    if (!fs.existsSync(startup)) return false;
    return fs.readFileSync(startup, 'utf8').includes('--no-open');
  } catch {
    return false;
  }
}

/** Resolve the directory holding the dsh CLI package (`lib/bin.js` inside). */
function resolveRuntimeDir(override) {
  if (override && fs.existsSync(path.join(override, DSH_BIN_REL))) return override;
  // Packaged: <resources>/bundle/dsh-runtime
  if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
    const p = path.join(process.resourcesPath, 'bundle', 'dsh-runtime');
    if (fs.existsSync(path.join(p, DSH_BIN_REL))) return p;
  }
  // Dev: <project>/resources/bundle/dsh-runtime
  const dev = path.join(__dirname, 'resources', 'bundle', 'dsh-runtime');
  if (fs.existsSync(path.join(dev, DSH_BIN_REL))) return dev;
  return null;
}

/**
 * The bundled stock Node runtime (<resources>/bundle/node-runtime/node.exe),
 * or null when it was not prepared. dsh's `node-addon-require-builtin` addon
 * crashes under Electron's patched Node, so a real node.exe is required for
 * profiles with out-of-tree plugins.
 */
function resolveNodeRuntimeDir() {
  if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
    const p = path.join(process.resourcesPath, 'bundle', 'node-runtime');
    if (fs.existsSync(path.join(p, 'node.exe'))) return p;
  }
  const dev = path.join(__dirname, 'resources', 'bundle', 'node-runtime');
  if (fs.existsSync(path.join(dev, 'node.exe'))) return dev;
  return null;
}

/**
 * Which executable acts as Node, and any env it needs.
 * Prefers an explicit nodeRuntimeDir, then the bundled node.exe; falls back
 * to Electron-as-Node, then to the current process's own executable.
 */
function resolveNodeBinary(nodeRuntimeDir, nativeCacheDir) {
  const nodeRuntime = nodeRuntimeDir || resolveNodeRuntimeDir();
  if (nodeRuntime) {
    const envExtra = {};
    const cacheDir = nativeCacheDir || path.join(nodeRuntime, 'native-cache');
    if (cacheDir && fs.existsSync(cacheDir)) envExtra.NARB_NATIVE_CACHE_DIR = cacheDir;
    return { bin: path.join(nodeRuntime, 'node.exe'), envExtra };
  }
  if (process.versions && process.versions.electron) {
    return { bin: process.execPath, envExtra: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  return { bin: process.execPath, envExtra: {} };
}

/** GET <url> and report whether it answered 200 within timeoutMs. */
async function httpUp(url, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'manual' });
    return res.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** TCP connect probe: is something listening on host:port? */
function isPortBusy(port, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(value);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

/** Ask the OS for a currently-free TCP port (released before use). */
function findFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, host, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Ensure a dsh web server is reachable and return a handle to manage it.
 *
 * Behaviour:
 *   1. If `http://host:preferredPort/` already answers 200, attach to it
 *      (startedByUs=false) — a previously running background `dsh web` is
 *      reused instead of double-started.
 *   2. If the preferred port is occupied by something else, ask the OS for a
 *      free port and spawn there.
 *   3. Otherwise spawn on the preferred port.
 *
 * @returns {Promise<{url:string, port:number, child:import('node:child_process').ChildProcess|null, startedByUs:boolean, stop:()=>Promise<void>}>}
 */
async function startDshServer(options = {}) {
  const {
    host = '127.0.0.1',
    preferredPort = 3080,
    runtimeDir = null,
    dshHome = null,
    workspace = null,
    logFile = null,
    stdioMode = 'pipe', // 'pipe' | 'ignore' | 'inherit'  ('ignore' avoids named pipes, for sandboxed tests)
    waitTimeoutMs = 120000,
    nodeRuntimeDir = null,
    nativeCacheDir = null,
    patchFile = null,
    log = console.log,
  } = options;

  const runtime = resolveRuntimeDir(runtimeDir);
  if (!runtime) {
    throw new Error(
      'dsh runtime not found. Run `npm run prepare:runtime` first (or set DSH_DESKTOP_RUNTIME).'
    );
  }

  const baseUrl = `http://${host}:${preferredPort}/`;
  if (await httpUp(baseUrl)) {
    log(`[dsh-desktop] dsh web already serving at ${baseUrl} — attaching`);
    return {
      url: `http://${host}:${preferredPort}`,
      port: preferredPort,
      child: null,
      startedByUs: false,
      stop: async () => {},
    };
  }

  let port = preferredPort;
  if (await isPortBusy(port, host)) {
    port = await findFreePort(host);
    log(`[dsh-desktop] port ${preferredPort} is busy with another app; using ${port}`);
  }

  const { bin, envExtra } = resolveNodeBinary(nodeRuntimeDir, nativeCacheDir);
  const binPath = path.join(runtime, DSH_BIN_REL);
  // `--patch` is a launcher (web subcommand) option; --host/--port pass
  // through to the web app unchanged. When the runtime supports it pass
  // `--no-open` so dsh web does NOT open the default browser: the desktop
  // shell already shows the UI in its own Electron window, and dsh's web
  // command defaults to popping a browser tab on every launch.
  const args = [
    binPath,
    'web',
    ...(patchFile ? ['--patch', patchFile] : []),
    '--host', host,
    '--port', String(port),
    ...(runtimeSupportsNoOpen(runtime) ? ['--no-open'] : []),
  ];
  const env = { ...process.env, ...envExtra };
  if (dshHome) env.DSH_HOME = dshHome;

  const cwd = workspace && fs.existsSync(workspace) ? workspace : process.cwd();

  const stdio =
    stdioMode === 'inherit'
      ? ['ignore', 'inherit', 'inherit']
      : stdioMode === 'ignore'
        ? ['ignore', 'ignore', 'ignore']
        : ['ignore', 'pipe', 'pipe'];

  const child = spawn(bin, args, { env, cwd, stdio, windowsHide: true });

  let outStream = null;
  if (stdioMode === 'pipe' && logFile) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      outStream = fs.createWriteStream(logFile, { flags: 'a' });
      child.stdout.pipe(outStream);
      child.stderr.pipe(outStream);
    } catch {
      outStream = null;
    }
  }

  const url = `http://${host}:${port}`;
  const deadline = Date.now() + waitTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`dsh web exited early (code ${child.exitCode}) — see the server log`);
    }
    if (await httpUp(`${url}/`, 2000)) {
      log(`[dsh-desktop] dsh web is up at ${url}`);
      let stopped = false;
      const stop = () =>
        new Promise((resolve) => {
          if (stopped) return resolve();
          stopped = true;
          if (child.exitCode !== null) return resolve();
          const force = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
            resolve();
          }, 5000);
          child.once('exit', () => {
            clearTimeout(force);
            resolve();
          });
          try {
            child.kill('SIGTERM');
          } catch {
            clearTimeout(force);
            resolve();
          }
        });
      return { url, port, child, startedByUs: true, stop };
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  try { child.kill('SIGKILL'); } catch { /* ignore */ }
  throw new Error(`dsh web did not come up within ${waitTimeoutMs}ms`);
}

module.exports = {
  DSH_BIN_REL,
  findFreePort,
  httpUp,
  isPortBusy,
  resolveNodeBinary,
  resolveNodeRuntimeDir,
  resolveRuntimeDir,
  startDshServer,
};
