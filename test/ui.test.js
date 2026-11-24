// The local browser interface: it must only answer the page that has the token, only on
// our own address, never take writes from other sites, and run checks end to end.

import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDir } from './helpers/tmp.js';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startDemo } from '../demo/server.js';
import { startUi } from '../src/ui/server.js';

let demo;
let ui;
let outDir;
const MAP = fileURLToPath(new URL('../demo/redirect-map.csv', import.meta.url));

before(async () => {
  demo = await startDemo();
  outDir = await tempDir('rmc-ui-out-');
  ui = await startUi({ open: false, outDir, maxBody: 2 * 1024 * 1024, defaults: { map: MAP, base: demo.newOrigin, sitemaps: [`${demo.oldOrigin}/sitemap.xml`] } });
});
after(async () => {
  await ui.close();
  await demo.close();
});

/** Raw HTTP so we can set Host/Origin headers that fetch() wouldn't let us forge. */
function raw(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: ui.port, path, method, headers: { host: `127.0.0.1:${ui.port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (err) => (err.code === 'EPIPE' || err.code === 'ECONNRESET' ? null : reject(err)));
    if (body) req.write(body);
    req.end();
  });
}
const t = () => ui.token;
const get = (path, headers = {}) => raw(path, { headers: { 'x-rmc-token': t(), ...headers } });
const b64 = (text) => Buffer.from(text).toString('base64');
const post = (path, data, headers = {}) =>
  raw(path, {
    method: 'POST',
    body: JSON.stringify(data ?? {}),
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${ui.port}`, 'x-rmc-token': t(), ...headers },
  });

/** Collect server-sent events until one of the given types arrives. */
function waitForEvent(types, timeoutMs = 60_000) {
  const since = Date.now();
  return new Promise((resolve, reject) => {
    let events = [];
    const timer = setTimeout(() => reject(new Error(`no ${types} event; got ${events.map((e) => e.type)}`)), timeoutMs);
    const req = request({ host: '127.0.0.1', port: ui.port, path: `/api/events?t=${t()}`, headers: { host: `127.0.0.1:${ui.port}` } }, (res) => {
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const line = block.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const event = JSON.parse(line.slice(6));
          // The stream first replays the previous check; only count the one we start now.
          if (event.type === 'start') events = event.at >= since ? [event] : [];
          else if (events.length) events.push(event);
          if (types.includes(event.type) && events.length) {
            clearTimeout(timer);
            req.destroy();
            resolve(events);
          }
        }
      });
    });
    req.on('error', () => {});
    req.end();
  });
}

test('the page holds no data; the API needs the token; strict CSP', async () => {
  const page = await raw('/');
  assert.equal(page.status, 200);
  assert.ok(!page.body.includes(MAP) && !page.body.includes('redirect-map.csv'), 'no defaults or paths in the page');
  const csp = page.headers['content-security-policy'];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-[A-Za-z0-9+/=]+'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  for (const path of ['/api/defaults', '/api/results', '/api/download/report.csv']) {
    assert.equal((await raw(path)).status, 403, path);
    assert.equal((await raw(`${path}?t=${t()}`)).status, 403, `${path}: the token only works in a header`);
  }
  assert.equal((await raw('/api/events?t=wrong')).status, 403);
  const defaults = JSON.parse((await get('/api/defaults')).body);
  assert.equal(defaults.map, 'redirect-map.csv'); // a file name, never the path
  assert.ok(!JSON.stringify(defaults).includes(tmpdir()) && !JSON.stringify(defaults).includes('/home/'));
});

test('a foreign Host header is refused (DNS rebinding)', async () => {
  assert.equal((await raw(`/?t=${t()}`, { headers: { host: 'evil.example' } })).status, 403);
  assert.equal((await raw(`/?t=${t()}`, { headers: { host: `evil.example:${ui.port}` } })).status, 403);
});

test('writes need the token header, our Origin and JSON (no cross-site requests)', async () => {
  assert.equal((await post('/api/cancel', {}, { 'x-rmc-token': '' })).status, 403);
  assert.equal((await post('/api/cancel', {}, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await post('/api/cancel', {}, { origin: `https://localhost:${ui.port}` })).status, 403);
  assert.equal((await post('/api/cancel', {}, { origin: 'null' })).status, 403);
  assert.equal((await post('/api/cancel', {}, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await raw('/api/cancel', { method: 'PUT' })).status, 405);
});

test('the page can never make the server read a local path', async () => {
  const res = await post('/api/run', { sitemaps: ['/etc/passwd'] });
  assert.equal(res.status, 400);
  assert.match(res.body, /must be an http\(s\) URL/);
  const res2 = await post('/api/run', { sitemaps: ['file:///etc/passwd'] });
  assert.equal(res2.status, 400);
  const res3 = await post('/api/run', { base: 'file:///etc', useDefaultMap: true });
  assert.equal(res3.status, 400);
  assert.equal((await post('/api/run', { oldFiles: 5 })).status, 400);
  assert.equal((await post('/api/run', [])).status, 400);
});

test('uploads are size-capped', async () => {
  const res = await post('/api/run', { mapFile: { name: 'big.csv', data: Buffer.alloc(3 * 1024 * 1024, 65).toString('base64') } });
  assert.equal(res.status, 413);
});

test('a full check through the page: upload, progress, results, downloads, save', async () => {
  const map = await readFile(MAP);
  const listening = waitForEvent(['done', 'error']);
  const res = await post('/api/run', {
    sitemaps: [`${demo.oldOrigin}/sitemap.xml`],
    mapFile: { name: 'redirect-map.csv', data: map.toString('base64') },
    base: demo.newOrigin,
    newSitemaps: `${demo.newOrigin}/sitemap.xml`,
    delay: '0',
  });
  assert.equal(res.status, 202, res.body);
  const events = await listening;
  assert.equal(events.at(-1).type, 'done');
  assert.ok(events.some((e) => e.type === 'phase' && e.name === 'crawl'));
  assert.ok(events.filter((e) => e.type === 'url').length >= 19);
  const results = JSON.parse((await get('/api/results')).body);
  assert.equal(results.summary.urlsChecked, 19);
  assert.ok(results.problems.some((p) => p.type === 'content-mismatch' && p.suggestions.length));
  const csv = await get('/api/download/report.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers['content-disposition'], /attachment/);
  assert.equal(csv.headers['x-content-type-options'], 'nosniff');
  const html = await get('/api/download/report.html');
  assert.match(html.headers['content-security-policy'], /default-src 'none'.*sandbox/);
  assert.equal((await get('/api/download/..%2F..%2Fetc%2Fpasswd')).status, 404);
  assert.equal((await get('/api/download/constructor')).status, 404);
  const saved = JSON.parse((await post('/api/save')).body);
  assert.equal(saved.path, outDir);
  assert.match(await readFile(join(outDir, 'report.csv'), 'utf8'), /^severity,issue/);
  // A second save asks before replacing.
  const again = await post('/api/save');
  assert.equal(again.status, 200);
  assert.deepEqual(JSON.parse(again.body), { ok: false, exists: true, path: outDir });
  assert.equal((await post('/api/save', { overwrite: true })).status, 200);
});

test('one check at a time; cancel stops a running check', async () => {
  const listening = waitForEvent(['cancelled', 'done', 'error']);
  const first = await post('/api/run', { useDefaultMap: true, base: demo.newOrigin, delay: '1500', concurrency: '1' });
  assert.equal(first.status, 202, first.body);
  const second = await post('/api/run', { useDefaultMap: true, base: demo.newOrigin });
  assert.equal(second.status, 409);
  await new Promise((r) => setTimeout(r, 300));
  await post('/api/cancel');
  const events = await listening;
  assert.equal(events.at(-1).type, 'cancelled');
});

test('the browser script never uses innerHTML', async () => {
  const client = await readFile(new URL('../src/ui/client.js', import.meta.url), 'utf8');
  assert.doesNotMatch(client.replace(/\/\/.*$/gm, ''), /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test('two simultaneous starts: exactly one runs', async () => {
  const listening = waitForEvent(['cancelled', 'done', 'error']);
  const body = { useDefaultMap: true, base: demo.newOrigin, delay: '1000', concurrency: '1' };
  const [a, b] = await Promise.all([post('/api/run', body), post('/api/run', body)]);
  assert.deepEqual([a.status, b.status].sort(), [202, 409]);
  await post('/api/cancel');
  const events = await listening;
  assert.equal(events.at(-1).type, 'cancelled');
  assert.equal(events.filter((e) => e.type === 'start').length, 1);
});

test('a dropped sitemap index can only reach files dropped with it', async () => {
  // A file outside the upload, which the index must not be able to read.
  const outside = await tempDir('rmc-ui-secret-');
  const secret = join(outside, 'secret.xml');
  await writeFile(secret, `<urlset><url><loc>${demo.oldOrigin}/SECRET</loc></url></urlset>`);
  const index = (child) => b64(`<sitemapindex><sitemap><loc>${child}</loc></sitemap></sitemapindex>`);

  for (const child of [secret, '../../../../../../../../' + secret.replace(/^\//, '')]) {
    const listening = waitForEvent(['done', 'error', 'cancelled']);
    assert.equal((await post('/api/run', { oldFiles: [{ name: 'index.xml', data: index(child) }], delay: '0' })).status, 202);
    const events = await listening;
    assert.equal(events.at(-1).type, 'error');
    assert.match(events.at(-1).message, /outside the files you picked/);
    assert.ok(!events.at(-1).message.includes(tmpdir()), 'no temp paths in messages');
  }

  // Dropped together, under their own names, the index finds its child.
  const child = b64(`<urlset><url><loc>${demo.oldOrigin}/about</loc></url></urlset>`);
  const listening = waitForEvent(['done', 'error', 'cancelled']);
  const res = await post('/api/run', {
    oldFiles: [{ name: 'sitemap-index.xml', data: index('pages.xml') }, { name: 'pages.xml', data: child }],
    base: demo.newOrigin,
    delay: '0',
  });
  assert.equal(res.status, 202);
  const events = await listening;
  assert.equal(events.at(-1).type, 'done', JSON.stringify(events.at(-1)));
  assert.equal(events.at(-1).summary.urlsChecked, 1);
});

test('uploads with path-like names stay in the upload folder', async () => {
  const listening = waitForEvent(['done', 'error', 'cancelled']);
  const res = await post('/api/run', { mapFile: { name: '../../../../tmp/evil.csv', data: b64(`old,new\n${demo.oldOrigin}/about,${demo.newOrigin}/about\n`) }, delay: '0' });
  assert.equal(res.status, 202);
  await listening;
  assert.ok(!(await readdir(tmpdir())).includes('evil.csv'));
});

test('a cancel stops a slow crawl at once', async () => {
  const listening = waitForEvent(['cancelled', 'done', 'error']);
  await post('/api/run', { useDefaultMap: true, base: demo.newOrigin, delay: '20000', concurrency: '1' });
  await new Promise((r) => setTimeout(r, 300));
  const started = Date.now();
  await post('/api/cancel');
  const events = await listening;
  assert.equal(events.at(-1).type, 'cancelled');
  assert.ok(Date.now() - started < 2000, `cancel took ${Date.now() - started} ms`);
});

test('flags from the command line reach the page as values and file names only', async () => {
  const other = await startUi({
    open: false,
    defaults: { map: MAP, oldBase: 'https://old.example', delay: '5000', newUrlLists: ['/home/someone/new.txt'], noContent: true },
  });
  try {
    const res = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: other.port, path: '/api/defaults', headers: { host: `127.0.0.1:${other.port}`, 'x-rmc-token': other.token } }, (r) => {
        let body = '';
        r.on('data', (c) => (body += c));
        r.on('end', () => resolve(JSON.parse(body)));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(res.oldBase, 'https://old.example');
    assert.equal(res.numbers.delay, '5000');
    assert.deepEqual(res.localNew, ['new.txt']);
    assert.equal(res.noContent, true);
    assert.ok(!JSON.stringify(res).includes('/home/someone'));
  } finally {
    await other.close();
  }
});

test('page wording: flags become form labels, URLs are left alone', async () => {
  const { forPage } = await import('../src/ui/server.js');
  assert.equal(forPage('See /old/summer-sale--limit and https://x.example/a--base'), 'See /old/summer-sale--limit and https://x.example/a--base');
  assert.equal(forPage('If you own the site, re-run with --ignore-robots.'), 'If you own the site, tick “Ignore robots.txt”.');
  assert.equal(forPage('Re-run, or pass --allow-partial-sitemaps to check the rest'), 'Re-run, or tick “If a child sitemap fails, check the rest” to check the rest');
  assert.equal(forPage('rewritten onto --base (staging)'), 'rewritten onto “Staging URL” (staging)');
});
