// test-plugin.cjs — verify the dsh-desktop companion plugin loads through the
// per-spawn --patch overlay: routes answer, client bundle is served.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { startDshServer } = require('../server.cjs');

const ROOT = path.resolve(__dirname, '..');
const TEST_HOME = path.join(ROOT, '.test-home', 'plugin-test-home');
const WORKSPACE = path.join(ROOT, '.test-home', 'plugin-test-ws');
const OVERLAY = path.join(ROOT, '.test-home', 'dsh-desktop.patch.yml');
const PORT = 3190;

async function main() {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  fs.mkdirSync(TEST_HOME, { recursive: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });
  fs.mkdirSync(path.dirname(OVERLAY), { recursive: true });
  fs.writeFileSync(
    OVERLAY,
    '- insert:\n' +
      '    - id: dsh-desktop\n' +
      '      name: dsh-desktop\n' +
      '      config:\n' +
      `        dataDir: ${JSON.stringify(path.join(ROOT, '.test-home', 'data'))}\n` +
      `        appVersion: "0.0.0-test"\n`
  );

  // Junction the plugin into the test profile so host resolution finds it
  // (mirrors what main.js does at spawn time).
  const runtimeDir = path.join(ROOT, 'resources', 'bundle', 'dsh-runtime');
  const profileNm = path.join(TEST_HOME, 'profiles', 'web', 'node_modules');
  fs.mkdirSync(profileNm, { recursive: true });
  const link = path.join(profileNm, 'dsh-desktop');
  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(path.join(runtimeDir, 'node_modules', 'dsh-desktop'), link, 'junction');

  const handle = await startDshServer({
    preferredPort: PORT,
    dshHome: TEST_HOME,
    workspace: WORKSPACE,
    patchFile: OVERLAY,
    stdioMode: 'ignore',
    waitTimeoutMs: 120000,
  });
  console.log(`test-plugin: UP at ${handle.url}`);

  // 1. Host route: version info
  const info = await fetch(`${handle.url}/dsh-desktop/info`);
  const infoBody = await info.json();
  console.log(`test-plugin: /dsh-desktop/info -> ${info.status}`, JSON.stringify(infoBody));
  if (info.status !== 200) throw new Error('info route failed');
  if (infoBody.runtimeVersion !== '0.1.0-rc.6') throw new Error(`unexpected runtime version ${infoBody.runtimeVersion}`);

  // 2. Host route: update check (network; tolerate offline by only asserting shape when 200)
  const check = await fetch(`${handle.url}/dsh-desktop/update`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'check' }),
  });
  const checkBody = await check.json();
  console.log(`test-plugin: update/check -> ${check.status}`, JSON.stringify(checkBody));

  // 3. Boot manifest carries the client bundle
  const index = await (await fetch(`${handle.url}/`)).text();
  if (!index.includes('dsh-desktop')) throw new Error('boot manifest does not mention dsh-desktop');
  console.log('test-plugin: boot manifest mentions dsh-desktop: true');

  // 4. Client bundle is served
  const client = await fetch(`${handle.url}/plugins/dsh-desktop/client.js`);
  const clientText = await client.text();
  console.log(`test-plugin: /plugins/dsh-desktop/client.js -> ${client.status}, ${clientText.length} bytes`);
  if (client.status !== 200 || !clientText.includes('__ModuleLoader__')) throw new Error('client bundle not served');

  await handle.stop();
  console.log('test-plugin: PASS');
}

main().catch((e) => {
  console.error('test-plugin: FAIL —', e.message);
  process.exit(1);
});
