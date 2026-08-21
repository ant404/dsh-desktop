// render-icon.cjs — capture build/icon-src.html into build/icon.png with a
// preserved alpha channel, using the project's own Electron (Chromium) so the
// white whale on a transparent background comes out exactly as authored.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'build', 'icon-src.html');
const OUT = path.join(ROOT, 'build', 'icon.png');
const SIZE = 512;

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: SIZE,
      height: SIZE,
      show: false,
      frame: false,
      transparent: true,
      webPreferences: { offscreen: true, backgroundThrottling: false },
    });
    await win.loadFile(SRC);
    // Give Chromium a frame to paint.
    await new Promise((r) => setTimeout(r, 500));
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
    fs.writeFileSync(OUT, image.toPNG());
    console.log(`render-icon: wrote ${OUT} (${image.getSize().width}x${image.getSize().height}, ${fs.statSync(OUT).size} bytes)`);
  } catch (error) {
    console.error('render-icon: FAIL —', error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
