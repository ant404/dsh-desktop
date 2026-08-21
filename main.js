// main.js — Electron main process: starts (or attaches to) the dsh web
// server and hosts the DeepSeek Harness UI in a native window.
'use strict';

const { app, BrowserWindow, dialog, Menu, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveRuntimeDir, startDshServer } = require('./server.cjs');

const APP_NAME = 'DSH Desktop';
const PREFERRED_PORT = 3080;

// Proper Windows identity: groups taskbar buttons and ties the window/taskbar
// icons to this app id (recommended for every Electron Windows app).
app.setAppUserModelId('ai.deepseek.dsh.desktop');

// ---------------------------------------------------------------------------
// data root — everything the app owns (config, logs, updated runtime, window
// state) lives NEXT TO THE EXE when the folder is writable, so the whole app
// is truly portable; otherwise it falls back to %APPDATA%. The Harness data
// itself (sessions/settings/plugins under ~/.dsh = DSH_HOME) is untouched.
// ---------------------------------------------------------------------------

/** The exe's own directory (null in dev mode, where cwd-based paths differ). */
function resolveExeDir() {
  return (
    process.env.PORTABLE_EXECUTABLE_DIR ||
    (process.defaultApp
      ? null
      : process.resourcesPath
        ? path.resolve(process.resourcesPath, '..')
        : path.dirname(process.execPath)) ||
    null
  );
}

function computeDataRoot() {
  // Explicit override (tests / power users): DSH_DESKTOP_DATA_DIR, or the
  // legacy DSH_DESKTOP_USER_DATA alias.
  if (process.env.DSH_DESKTOP_DATA_DIR) return process.env.DSH_DESKTOP_DATA_DIR;
  if (process.env.DSH_DESKTOP_USER_DATA) return process.env.DSH_DESKTOP_USER_DATA;
  const exeDir = resolveExeDir();
  if (!exeDir) return null;
  const candidate = path.join(exeDir, 'data');
  try {
    fs.mkdirSync(candidate, { recursive: true });
    const probe = path.join(candidate, '.write-test');
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    return candidate;
  } catch {
    return null; // exe dir not writable → fall back to %APPDATA%
  }
}

const DATA_ROOT = computeDataRoot();
if (DATA_ROOT) {
  // Chromium window state (caches, localStorage, single-instance lock) goes
  // under <data>/chromium; config/logs/runtime stay directly under <data>.
  app.setPath('userData', path.join(DATA_ROOT, 'chromium'));
}

/** Base directory for everything the app itself owns. */
function appDataDir() {
  return DATA_ROOT || app.getPath('userData');
}

// Minimal file logger — console output of GUI apps is unreliable, so the main
// process mirrors its own messages into <appData>/logs/main.log.
const MAIN_LOG = path.join(appDataDir(), 'logs', 'main.log');
function mainLog(message) {
  try {
    fs.mkdirSync(path.dirname(MAIN_LOG), { recursive: true });
    fs.appendFileSync(MAIN_LOG, `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* ignore */
  }
  console.log(message);
}

let mainWindow = null;
let serverHandle = null; // { url, port, child, startedByUs, stop }
let quitting = false;

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

function configPath() {
  return path.join(appDataDir(), 'config.json');
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

/** Write a default config.json on first run so users can discover/edit it. */
function ensureConfigFile() {
  try {
    if (fs.existsSync(configPath())) return;
    fs.mkdirSync(appDataDir(), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify({ port: PREFERRED_PORT, workspace: null }, null, 2) + '\n');
  } catch {
    /* non-fatal */
  }
}

function defaultWorkspace() {
  const dir = path.join(os.homedir(), 'Documents', 'DSH-Workspace');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** --port N and --workspace <dir> on the command line beat config.json. */
function argvOverrides() {
  const out = {};
  const argv = process.argv;
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === '--port') out.port = Number(argv[i + 1]);
    if (argv[i] === '--workspace') out.workspace = argv[i + 1];
  }
  return out;
}

function resolveLaunchOptions() {
  const config = readConfig();
  const over = argvOverrides();
  const port = over.port || Number(config.port) || PREFERRED_PORT;
  const host = '127.0.0.1'; // dsh refuses 0.0.0.0 anyway; loopback only
  const workspace = over.workspace || config.workspace || defaultWorkspace();
  fs.mkdirSync(workspace, { recursive: true });
  return { port, host, workspace };
}

/**
 * Runtime preference: an updated copy under userData wins over the bundled
 * one, so the "检查更新" flow can swap the Harness engine without rebuilding
 * the app (the portable build cannot write into its own temp extraction).
 * @returns {{runtimeDir: string|null, nativeCacheDir: string|null, nodeRuntimeDir: string|null}}
 */
function effectiveRuntime() {
  const userRuntime = path.join(appDataDir(), 'runtime');
  const userDsh = path.join(userRuntime, 'dsh-runtime');
  if (fs.existsSync(path.join(userDsh, 'lib', 'bin.js'))) {
    return {
      runtimeDir: userDsh,
      nativeCacheDir: path.join(userRuntime, 'native-cache'),
      nodeRuntimeDir: null, // keep the bundled node.exe
    };
  }
  return { runtimeDir: null, nativeCacheDir: null, nodeRuntimeDir: null };
}

/** Version of the dsh runtime this launch will actually run (userData copy wins). */
function runtimeVersionInUse() {
  try {
    const eff = effectiveRuntime();
    const dir = process.env.DSH_DESKTOP_RUNTIME || eff.runtimeDir || resolveRuntimeDir();
    if (!dir) return 'unknown';
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The app's own shipped plugin dir (resources/bundle/dsh-runtime/node_modules/
 * dsh-desktop). Engine updates re-inject the plugin into the fresh runtime;
 * injecting from the SHIPPED copy (always current with this app build) rather
 * than from the running copy (possibly a stale injected one) keeps the card
 * and the settings namespace alive across updates.
 */
function bundlePluginDir() {
  try {
    if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
      const p = path.join(process.resourcesPath, 'bundle', 'dsh-runtime', 'node_modules', 'dsh-desktop');
      if (fs.existsSync(path.join(p, 'index.js'))) return p;
    }
  } catch {
    /* fall through */
  }
  return '';
}

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: APP_NAME,
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#0b1220',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  // Fallback: never leave the window invisible. ready-to-show can stall (e.g.
  // right after the companion plugin's restart), which left users staring at a
  // running-but-windowless/black app. Show regardless after a short grace.
  const revealTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  }, 2000);
  mainWindow.on('closed', () => {
    clearTimeout(revealTimer);
    mainWindow = null;
  });

  // Keep the UI inside the app: external links open in the default browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    let current = '';
    try {
      current = mainWindow.webContents.getURL();
    } catch {
      /* ignore */
    }
    let sameOrigin = false;
    try {
      sameOrigin = new URL(url).origin === new URL(current).origin;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, validatedURL) => {
    if (quitting) return;
    console.error(`[dsh-desktop] did-fail-load ${code} ${desc} ${validatedURL}`);
  });

  mainWindow.loadURL(url);
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

async function boot() {
  const opts = resolveLaunchOptions();
  const eff = effectiveRuntime();
  const runtimeDir = process.env.DSH_DESKTOP_RUNTIME || eff.runtimeDir || resolveRuntimeDir() || null;
  ensureProfilePluginLink(runtimeDir);
  mainLog(`[main] boot: port=${opts.port} workspace=${opts.workspace} runtime=${runtimeDir || 'auto'}`);
  serverHandle = await startDshServer({ ...serverOptions(opts) });
  mainLog(`[main] server ready at ${serverHandle.url} (startedByUs=${serverHandle.startedByUs})`);
  wireCrashRestart(serverHandle, opts);
  createWindow(serverHandle.url);
}

function serverOptions(opts) {
  const eff = effectiveRuntime();
  return {
    host: opts.host,
    preferredPort: opts.port,
    workspace: opts.workspace,
    runtimeDir: process.env.DSH_DESKTOP_RUNTIME || eff.runtimeDir || null,
    nativeCacheDir: eff.nativeCacheDir,
    nodeRuntimeDir: eff.nodeRuntimeDir,
    patchFile: ensureOverlayFile(),
    logFile: path.join(appDataDir(), 'logs', 'dsh-server.log'),
    log: mainLog,
  };
}

/** Report an unexpected server death and offer a restart. */
function wireCrashRestart(handle, opts) {
  if (!handle.child) return;
  handle.child.on('exit', (code, signal) => {
    if (quitting || !serverHandle || !serverHandle.startedByUs) return;
    serverHandle.startedByUs = false;
    const messageOpts = {
      type: 'error',
      title: APP_NAME,
      message: 'DSH 服务意外退出',
      detail: `dsh web 进程已退出（code=${code}${signal ? `, signal=${signal}` : ''}）。你可以重启服务，或退出应用。`,
      buttons: ['重启服务', '退出应用'],
      defaultId: 0,
      cancelId: 1,
    };
    const prompt = mainWindow
      ? dialog.showMessageBox(mainWindow, messageOpts)
      : dialog.showMessageBox(messageOpts);
    prompt.then(async ({ response }) => {
      if (response === 0) {
        try {
          const h = await startDshServer(serverOptions(opts));
          serverHandle = h;
          wireCrashRestart(h, opts);
          if (mainWindow) mainWindow.loadURL(h.url);
        } catch (error) {
          dialog.showErrorBox(APP_NAME, `无法重启 DSH 服务：${error.message}`);
          app.quit();
        }
      } else {
        app.quit();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// companion plugin overlay
// ---------------------------------------------------------------------------

/**
 * Write the per-spawn --patch overlay that mounts the dsh-desktop plugin
 * (settings card + version/update routes) into the web profile. Overlays are
 * invocation-scoped, so the shared ~/.dsh profile is never modified.
 */
function ensureOverlayFile() {
  try {
    const overlayPath = path.join(appDataDir(), 'dsh-desktop.patch.yml');
    fs.mkdirSync(appDataDir(), { recursive: true });
    // Display label for the data directory: relative to the exe when it lives
    // under the exe dir (the default folder-portable layout → "data"),
    // otherwise the absolute path (e.g. %APPDATA% fallback).
    const exeDir = resolveExeDir();
    let dataDirLabel = appDataDir();
    if (exeDir) {
      const rel = path.relative(exeDir, appDataDir());
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) dataDirLabel = rel;
    }
    const yaml =
      '# DSH Desktop companion plugin (per-spawn overlay; the shared ~/.dsh profile is untouched).\n' +
      '- insert:\n' +
      '    - id: dsh-desktop\n' +
      '      name: dsh-desktop\n' +
      '      config:\n' +
      `        dataDir: ${JSON.stringify(appDataDir())}\n` +
      `        dataDirLabel: ${JSON.stringify(dataDirLabel)}\n` +
      `        appVersion: ${JSON.stringify(app.getVersion())}\n` +
      `        runtimeVersion: ${JSON.stringify(runtimeVersionInUse())}\n` +
      `        pluginDir: ${JSON.stringify(bundlePluginDir())}\n`;
    fs.writeFileSync(overlayPath, yaml);
    return overlayPath;
  } catch (error) {
    mainLog(`[main] overlay write failed: ${error.message}`);
    return null;
  }
}

/**
 * Junction the companion plugin into the web profile's node_modules so the
 * loader (whose bare-specifier resolution anchors at the profile dir) can find
 * the host half; the runtime copy covers client-bundle discovery. The browser
 * web version never mounts the overlay row, so the link is inert there. The
 * link is recreated each spawn and removed on quit.
 */
function ensureProfilePluginLink(runtimeDir) {
  try {
    if (!runtimeDir) return null;
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const nm = path.join(home, 'profiles', 'web', 'node_modules');
    const link = path.join(nm, 'dsh-desktop');
    const target = path.join(runtimeDir, 'node_modules', 'dsh-desktop');
    if (!fs.existsSync(target)) return null;
    fs.mkdirSync(nm, { recursive: true });
    try {
      const st = fs.lstatSync(link);
      if (st.isSymbolicLink()) {
        // A junction points at the previous runtime location (e.g. the app
        // folder was moved or the runtime was updated): re-point it, otherwise
        // the plugin keeps loading from the old (possibly deleted) path.
        if (path.resolve(fs.readlinkSync(link)) === path.resolve(target)) return link;
        removeJunction(link);
      } else if (st.isDirectory()) {
        // A real directory (e.g. from an earlier scheme) — replace it.
        removeJunction(link);
      }
    } catch {
      /* no existing link */
    }
    fs.symlinkSync(target, link, 'junction');
    return link;
  } catch (error) {
    mainLog(`[main] profile plugin link failed: ${error.message}`);
    return null;
  }
}

/**
 * Remove a stale junction/directory best-effort: fs.rmSync(force) swallows
 * errors silently, so a lock (another dsh instance watching the profile) left
 * the link behind and the following symlinkSync threw EEXIST. Try rm, then
 * rmdir; report when both fail (the old link then stays and the plugin keeps
 * loading from its old target — same code, only the displayed version suffers).
 */
function removeJunction(link) {
  try {
    fs.rmSync(link, { force: true });
    return;
  } catch {
    /* fall through */
  }
  try {
    fs.rmdirSync(link);
    return;
  } catch {
    /* fall through */
  }
  try {
    fs.unlinkSync(link);
    return;
  } catch (error) {
    mainLog(`[main] could not remove stale plugin link ${link}: ${error.message}`);
  }
}

function removeProfilePluginLink() {
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const link = path.join(home, 'profiles', 'web', 'node_modules', 'dsh-desktop');
    // fs.rm on a junction removes the link itself, never the target.
    fs.rmSync(link, { force: true });
  } catch {
    /* ignore */
  }
}

// Single instance: a second launch just focuses the existing window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('before-quit', () => {
    quitting = true;
    removeProfilePluginLink();
  });

  app.on('will-quit', () => {
    if (serverHandle && serverHandle.startedByUs && serverHandle.child && serverHandle.child.exitCode === null) {
      try {
        serverHandle.child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  });

  app.on('window-all-closed', () => {
    if (serverHandle && serverHandle.startedByUs) {
      serverHandle.stop().finally(() => app.quit());
    } else {
      app.quit();
    }
  });

  app.whenReady().then(async () => {
    ensureConfigFile();
    ensureOverlayFile();
    // No application menu / menu bar: version info and updates live in the
    // web UI's 设置 (the dsh-desktop settings card).
    Menu.setApplicationMenu(null);
    try {
      await boot();
      // Companion-plugin restart bridge: the card's 重启客户端 action writes
      // <dataDir>/restart.request; arm the watcher only after the web server
      // is up so the request can actually be delivered.
      armRestartWatcher();
    } catch (error) {
      console.error('[dsh-desktop] boot failed:', error);
      dialog.showErrorBox(APP_NAME, `无法启动 DSH 服务：${error.message}\n\n请查看日志：${path.join(appDataDir(), 'logs', 'dsh-server.log')}`);
      app.exit(1);
    }
  });
}

// ---------------------------------------------------------------------------
// companion-plugin restart bridge
// ---------------------------------------------------------------------------

let restartWatchTimer = null;

/**
 * Watch for <dataDir>/restart.request written by the dsh-desktop companion
 * plugin (POST /dsh-desktop/restart) and relaunch the app with Electron's own
 * app.relaunch() + app.quit() — a clean, self-managed restart that never
 * fights the single-instance lock or leaves a half-dead window. The request
 * file is removed before quitting so a stale file can't trigger a later
 * unexpected restart.
 */
function armRestartWatcher() {
  if (restartWatchTimer) return;
  restartWatchTimer = setInterval(() => {
    try {
      const req = path.join(appDataDir(), 'restart.request');
      if (!fs.existsSync(req)) return;
      let mtime = 0;
      try {
        mtime = fs.statSync(req).mtimeMs;
      } catch {
        /* unreadable → treat as stale */
      }
      // Ignore requests older than 15s (e.g. leftovers from a killed session).
      if (Date.now() - mtime > 15000) {
        fs.rmSync(req, { force: true });
        return;
      }
      fs.rmSync(req, { force: true });
      mainLog('[main] restart requested by companion plugin — relaunching');
      app.relaunch();
      app.quit();
    } catch {
      /* keep polling */
    }
  }, 1000);
}
