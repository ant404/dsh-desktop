// prepare-runtime.cjs — copies the installed `@deepseek-ai/dsh` package
// (CLI + nested node_modules + built web frontend) into
// resources/dsh-runtime so the desktop app ships its own server runtime and
// needs no system Node, npm or network at run time.
//
// The source is located by probing the usual global-install locations on
// Windows (nvm version dir, C:\nodejs symlink, npm's %APPDATA%\npm) and may
// be overridden with the DSH_SOURCE environment variable.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN_REL = path.join('lib', 'bin.js');
const ROOT = path.resolve(__dirname, '..');
// The bundle dir nests the dsh package and the node runtime one level deeper:
// electron-builder's copy filter unconditionally drops a *top-level*
// node_modules entry, so the package must sit under a wrapper directory.
const BUNDLE = path.join(ROOT, 'resources', 'bundle');
const DEST = path.join(BUNDLE, 'dsh-runtime');
const NODE_RUNTIME = path.join(BUNDLE, 'node-runtime');

function candidateRoots() {
  const roots = [];
  if (process.env.DSH_SOURCE) roots.push(process.env.DSH_SOURCE);
  // nvm installs: %APPDATA%\nvm\<version>\node_modules (highest version wins)
  const nvmDir = process.env.NVM_HOME || path.join(process.env.APPDATA || '', 'nvm');
  try {
    const versions = fs
      .readdirSync(nvmDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((n) => /^v?\d+\.\d+\.\d+$/.test(n))
      .sort((a, b) => {
        const va = a.replace(/^v/, '').split('.').map(Number);
        const vb = b.replace(/^v/, '').split('.').map(Number);
        for (let i = 0; i < 3; i++) {
          if (va[i] !== vb[i]) return vb[i] - va[i];
        }
        return 0;
      });
    for (const v of versions) roots.push(path.join(nvmDir, v, 'node_modules', '@deepseek-ai', 'dsh'));
  } catch {
    /* nvm dir missing */
  }
  // Classic npm global root and the common C:\nodejs symlink target
  roots.push(path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
  roots.push('C:\\nodejs\\node_modules\\@deepseek-ai\\dsh');
  roots.push(path.join(process.env.LOCALAPPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
  return roots;
}

function findSource() {
  for (const root of candidateRoots()) {
    try {
      if (fs.existsSync(path.join(root, BIN_REL))) return root;
    } catch {
      /* keep probing */
    }
  }
  return null;
}

function main() {
  const src = findSource();
  if (!src) {
    console.error(
      'prepare-runtime: could not locate the @deepseek-ai/dsh install.\n' +
        'Install it globally first (`npm i -g @deepseek-ai/dsh`) or set DSH_SOURCE to the package dir.'
    );
    process.exit(1);
  }

  console.log(`prepare-runtime: source  ${src}`);
  console.log(`prepare-runtime: dest    ${DEST}`);

  fs.mkdirSync(path.dirname(DEST), { recursive: true });
  // Remove a stale copy so removed files do not linger.
  fs.rmSync(DEST, { recursive: true, force: true });
  fs.cpSync(src, DEST, { recursive: true, verbatimSymlinks: true });
  fs.writeFileSync(
    path.join(DEST, 'SOURCE.txt'),
    `Prepared from: ${src}\nPrepared at:   ${new Date().toISOString()}\nNode used:     ${process.version}\n`
  );

  const size = fs
    .readdirSync(DEST, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .reduce((sum, e) => sum + fs.statSync(path.join(e.parentPath || e.path, e.name)).size, 0);

  console.log(`prepare-runtime: done (${(size / 1048576).toFixed(1)} MiB, bin at ${path.join(DEST, BIN_REL)})`);

  // --- 1b. dsh-desktop companion plugin (settings card + update routes) -----
  // Copied into the runtime's node_modules so the web profile can resolve it
  // in-box via the per-spawn --patch overlay (never touches the shared
  // ~/.dsh profile). The updater re-injects it after runtime updates.
  const pluginSrc = path.join(ROOT, 'resources', 'plugin-src', 'dsh-desktop');
  const pluginDst = path.join(DEST, 'node_modules', 'dsh-desktop');
  fs.rmSync(pluginDst, { recursive: true, force: true });
  if (fs.existsSync(pluginSrc)) {
    fs.cpSync(pluginSrc, pluginDst, { recursive: true });
    console.log(`prepare-runtime: plugin      ${pluginDst}`);
  } else {
    console.warn('prepare-runtime: WARNING dsh-desktop plugin source missing — settings card will not exist');
  }

  // --- 2. Node runtime (a real node.exe, not Electron's node) --------------
  // Electron's bundled Node cannot run dsh's `node-addon-require-builtin`
  // native addon (it crashes), so the app ships a stock node.exe. The current
  // `node` running this script is copied verbatim.
  fs.mkdirSync(NODE_RUNTIME, { recursive: true });
  const nodeSource = process.execPath;
  fs.copyFileSync(nodeSource, path.join(NODE_RUNTIME, 'node.exe'));

  // The addon keeps its prebuilt binary in a per-machine cache; ship that too
  // and point at it via NARB_NATIVE_CACHE_DIR so the app is self-contained.
  const nativeCacheSrc = path.join(
    process.env.LOCALAPPDATA || '',
    'node-addon-native-custom-loader',
    'native-cache'
  );
  const nativeCacheDst = path.join(NODE_RUNTIME, 'native-cache');
  fs.rmSync(nativeCacheDst, { recursive: true, force: true });
  if (fs.existsSync(nativeCacheSrc)) {
    fs.cpSync(nativeCacheSrc, nativeCacheDst, { recursive: true });
    console.log(`prepare-runtime: native cache  ${nativeCacheDst}`);
  } else {
    console.warn('prepare-runtime: WARNING native cache not found — out-of-tree plugins may fail to resolve');
  }
  console.log(`prepare-runtime: node runtime   ${path.join(NODE_RUNTIME, 'node.exe')} (${process.version})`);
}

main();
