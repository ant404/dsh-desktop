// zip-dist.cjs — pack dist/win-unpacked (the folder-portable build) into
// dist/DSH Desktop-<version>-portable-win32-x64.zip, with the app folder
// renamed to "DSH Desktop" inside the archive. Uses the bsdtar shipped with
// Windows 10/11 (fast, handles 30k+ files).
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const UNPACKED = path.join(DIST, 'win-unpacked');
const APP_FOLDER = 'DSH Desktop';
const RENAMED = path.join(DIST, APP_FOLDER);

function main() {
  if (!fs.existsSync(path.join(UNPACKED, 'DSH Desktop.exe'))) {
    console.error('zip-dist: dist/win-unpacked/DSH Desktop.exe not found — run the build first.');
    process.exit(1);
  }
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const outZip = path.join(DIST, `DSH Desktop-${version}-portable-win32-x64.zip`);
  fs.rmSync(outZip, { force: true });

  // Rename the folder so the archive has a clean top-level name.
  fs.rmSync(RENAMED, { recursive: true, force: true });
  fs.renameSync(UNPACKED, RENAMED);

  try {
    const result = spawnSync(
      'tar.exe',
      ['-a', '-c', '-f', outZip, '-C', DIST, APP_FOLDER],
      { stdio: 'inherit' }
    );
    if (result.status !== 0) {
      throw new Error(`tar exited ${result.status}`);
    }
    console.log(`zip-dist: ${outZip}`);
  } finally {
    // Restore the electron-builder layout regardless of zip success.
    fs.renameSync(RENAMED, UNPACKED);
  }
}

main();
