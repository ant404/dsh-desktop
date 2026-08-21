// test-server.cjs — offline smoke test for server.cjs. Boots the bundled dsh
// web server with a throwaway DSH_HOME under the project (no network, no
// touching the real ~/.dsh), health-checks it, then stops it.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { startDshServer } = require('../server.cjs');

const ROOT = path.resolve(__dirname, '..');
const TEST_HOME = path.join(ROOT, '.test-home');
// DSH_TEST_HOME points at a real Harness home (e.g. C:\Users\you\.dsh) to
// exercise the user's actual profile with out-of-tree plugins.
const DSH_HOME = process.env.DSH_TEST_HOME || path.join(TEST_HOME, 'dsh');
const WORKSPACE = path.join(TEST_HOME, 'ws');
const PORT = Number(process.env.DSH_TEST_PORT) || 3199;

async function main() {
  fs.mkdirSync(DSH_HOME, { recursive: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });

  console.log('test-server: starting dsh web …');
  const startedAt = Date.now();
  const handle = await startDshServer({
    preferredPort: PORT,
    dshHome: DSH_HOME,
    workspace: WORKSPACE,
    stdioMode: 'ignore', // sandbox-safe: no named pipes
    waitTimeoutMs: 120000,
  });
  console.log(`test-server: UP in ${Date.now() - startedAt} ms at ${handle.url} (startedByUs=${handle.startedByUs})`);

  const res = await fetch(`${handle.url}/`);
  const html = await res.text();
  const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '(no title)';
  console.log(`test-server: GET / -> ${res.status}, ${html.length} bytes, <title>${title}</title>`);
  if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);

  const t0 = Date.now();
  await handle.stop();
  console.log(`test-server: stopped in ${Date.now() - t0} ms`);

  const upAfter = await fetch(`${handle.url}/`).then((r) => r.status).catch(() => 0);
  console.log(`test-server: after stop, / answers ${upAfter === 0 ? 'nothing (good)' : upAfter}`);
  if (upAfter !== 0) throw new Error('server still answering after stop');
  console.log('test-server: PASS');
}

main().catch((error) => {
  console.error('test-server: FAIL —', error.message);
  process.exit(1);
});
