// One test (at least) per finding from the QA review: each would have failed before the fix.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tempDir } from './helpers/tmp.js';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { collectTargets, evaluate, runCheck } from '../src/check.js';
import { decodeHtml, extractPageInfo } from '../src/content.js';
import { Fetcher, isPrivateAddress } from '../src/http.js';
import { loadSitemapUrls, loadText, parseRedirectMap, parseSitemap } from '../src/inputs.js';
import { compilePattern, matches, robotsAllows } from '../src/robots.js';
import { fixContext, recommendFix } from '../src/fixes.js';
import { parseRobots } from '../src/robots.js';
import { isRootLike, variantDifferences } from '../src/url.js';
import { writeReports } from '../src/write.js';

const BIN = fileURLToPath(new URL('../bin/redirect-map-check.js', import.meta.url));
const FAST = { delayMs: 0, retryBaseMs: 10, userAgent: 'redirect-map-check-test' };

/** A tiny server: routes maps a path to (req, res) or to [status, headers, body]. */
async function serve(routes, fallback = [404, { 'content-type': 'text/html' }, '<title>Not found</title>']) {
  const log = [];
  const server = createServer((req, res) => {
    log.push({ path: req.url, at: Date.now() });
    const route = routes[req.url] ?? fallback;
    if (typeof route === 'function') return route(req, res);
    const [status, headers, body] = route;
    res.writeHead(status, headers);
    res.end(body ?? '');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, log, close: () => new Promise((r) => server.close(r)) };
}

/** CPU milliseconds used by fn: unlike wall time, stable when other processes share the cores. */
function cpuMs(fn) {
  const start = process.cpuUsage();
  fn();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000;
}

const html = (title, h1 = title) => [200, { 'content-type': 'text/html; charset=utf-8' }, `<title>${title}</title><h1>${h1}</h1>`];
const redirect = (status, location) => [status, { location }];
const tmp = () => tempDir('rmc-hard-');
const types = (r) => r.issues.map((i) => i.type).sort();
const run = (args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args, '--no-color'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => resolve({ code, out }));
  });

// ---- C1: URLs we couldn't check are never clean ----

test('C1: staging robots.txt "Disallow: /" makes every URL an unchecked error and exits 1', async () => {
  const site = await serve({ '/robots.txt': [200, { 'content-type': 'text/plain' }, 'User-agent: *\nDisallow: /\n'] });
  const dir = await tmp();
  const map = join(dir, 'map.csv');
  await writeFile(map, 'old,new\nhttps://www.shop.example/a,https://www.shop.example/new-a\nhttps://www.shop.example/b,https://www.shop.example/new-b\n');
  const { code, out } = await run(['--map', map, '--base', site.origin, '--delay', '0', '--no-content', '--out', join(dir, 'out')]);
  await site.close();
  assert.equal(code, 1);
  assert.match(out, /2 with errors/);
  assert.match(out, /0 clean/);
  const report = await readFile(join(dir, 'out', 'report.html'), 'utf8');
  assert.match(report, /2 of 2 URLs could not be checked/);
  assert.doesNotMatch(report, /redirect cleanly/);
});

test('C1: staging down (connection refused) is a fetch error, not clean', async () => {
  const site = await serve({});
  const origin = site.origin;
  await site.close(); // nothing listens there now
  const dir = await tmp();
  const map = join(dir, 'map.csv');
  await writeFile(map, 'old,new\n/a,/b\n');
  const result = await runCheck({ ...FAST, map, base: origin, content: false, retries: 0 });
  assert.deepEqual(types(result.results[0]), ['fetch-error']);
  assert.match(result.results[0].issues[0].fix, /robots\.txt .*Make sure the host is up/);
  assert.equal(result.summary.clean, 0);
});

test('C1: robots.txt answering 503 makes URLs unchecked (RFC 9309), with a robots-specific fix', async () => {
  const site = await serve({ '/robots.txt': [503, {}, 'down'] });
  const dir = await tmp();
  const map = join(dir, 'map.csv');
  await writeFile(map, 'old,new\n/a,/b\n');
  const result = await runCheck({ ...FAST, map, base: site.origin, content: false, retries: 0 });
  await site.close();
  assert.deepEqual(types(result.results[0]), ['unchecked']);
  assert.match(result.results[0].issues[0].fix, /answered HTTP 503.*Fix robots\.txt/);
});

test('C1: a redirect into another site that blocks us keeps the issues seen before it', async () => {
  const other = await serve({ '/robots.txt': [200, {}, 'User-agent: *\nDisallow: /\n'] });
  const site = await serve({ '/old': redirect(302, `${other.origin}/elsewhere`) });
  const dir = await tmp();
  const map = join(dir, 'map.csv');
  await writeFile(map, `old,new\n/old,/new\n`);
  const result = await runCheck({ ...FAST, map, base: site.origin, content: false, allowPrivateNetwork: true });
  await Promise.all([site.close(), other.close()]);
  assert.deepEqual(types(result.results[0]), ['target-not-checked', 'temporary-redirect', 'wrong-target']);
});

// ---- H1: odd Location values never crash the run ----

test('H1: javascript:, mailto:, data: and file: redirects are reported; the run carries on', async () => {
  const site = await serve({
    '/js': redirect(301, 'javascript:alert(1)'),
    '/mail': redirect(301, 'mailto:a@example.com'),
    '/data': redirect(301, 'data:text/html,<title>x</title>'),
    '/file': redirect(301, 'file:///etc/passwd'),
    '/bad': redirect(301, 'http://[::1'),
    '/ok': redirect(301, '/fine'),
    '/fine': html('Fine'),
  });
  const dir = await tmp();
  const map = join(dir, 'map.csv');
  await writeFile(map, 'old,new\n/js,/fine\n/mail,/fine\n/data,/fine\n/file,/fine\n/bad,/fine\n/ok,/fine\n');
  const result = await runCheck({ ...FAST, map, base: site.origin, content: false });
  await site.close();
  const by = Object.fromEntries(result.results.map((r) => [r.key, types(r)]));
  for (const k of ['/js', '/mail', '/data', '/file']) assert.deepEqual(by[k], ['non-http-redirect'], k);
  assert.deepEqual(by['/bad'], ['fetch-error']);
  assert.deepEqual(by['/ok'], []);
  assert.ok(!site.log.some((l) => l.path.includes('passwd')));
});

// ---- H2: --snapshot is never overwritten ----

test('H2: a run with --snapshot leaves old-pages.json alone', async () => {
  const dir = await tmp();
  const snapshot = join(dir, 'old-pages.json');
  const original = JSON.stringify({ version: 1, pages: { 'a.example/x': { url: 'https://a.example/x', title: 'X', h1: 'X' }, 'a.example/y': { url: 'https://a.example/y', title: 'Y', h1: 'Y' } } });
  await writeFile(snapshot, original);
  const site = await serve({ '/x': html('X') });
  const map = join(dir, 'map.csv');
  await writeFile(map, `old,new\n${site.origin}/x,${site.origin}/x\n`);
  const result = await runCheck({ ...FAST, map, snapshot });
  await site.close();
  await writeReports(result, dir);
  assert.equal(await readFile(snapshot, 'utf8'), original);
});

test('H2: an unreadable snapshot names the file', async () => {
  const dir = await tmp();
  const snapshot = join(dir, 'broken.json');
  await writeFile(snapshot, '{ nope');
  const map = join(dir, 'map.csv');
  await writeFile(map, 'old,new\nhttps://a.example/x,https://a.example/y\n');
  await assert.rejects(runCheck({ ...FAST, map, snapshot, content: true, respectRobots: false }), /Could not read the snapshot .*broken\.json/);
});

// ---- H3, H5, L8, L10: sitemaps ----

test('H3: image, video and news entries in a sitemap are not pages', () => {
  const xml = `<urlset xmlns:image="i" xmlns:video="v"><url><loc>https://s.example/product</loc>
    <image:image><image:loc>https://cdn.example/p.jpg</image:loc></image:image>
    <video:video><video:content_loc>https://cdn.example/v.mp4</video:content_loc><video:player_loc>https://cdn.example/p</video:player_loc></video:video>
  </url><url><loc>https://s.example/other</loc></url></urlset>`;
  assert.deepEqual(parseSitemap(xml).locs, ['https://s.example/product', 'https://s.example/other']);
});

test('H5: a gzip bomb stops at 50 MB instead of eating memory', async () => {
  const dir = await tmp();
  const bomb = join(dir, 'bomb.xml.gz');
  await writeFile(bomb, gzipSync(Buffer.alloc(60 * 1024 * 1024, 0x20)));
  const before = process.memoryUsage().rss;
  await assert.rejects(loadText(bomb), /larger than 50 MB/);
  assert.ok(process.memoryUsage().rss - before < 300 * 1024 * 1024);
});

test('L8/N1: a local index resolves children next to it; a broken child stops the run unless allowed, then fails it', async () => {
  const dir = await tmp();
  await writeFile(join(dir, 'pages.xml'), '<urlset><url><loc>https://s.example/a</loc></url></urlset>');
  await writeFile(join(dir, 'index.xml'), '<sitemapindex><sitemap><loc>pages.xml</loc></sitemap><sitemap><loc>missing.xml</loc></sitemap></sitemapindex>');
  await assert.rejects(loadSitemapUrls(join(dir, 'index.xml'), null, {}), /child sitemap .*could not be read.*--allow-partial-sitemaps/);
  const failures = [];
  assert.deepEqual(await loadSitemapUrls(join(dir, 'index.xml'), null, { allowPartial: true, failures }), ['https://s.example/a']);
  assert.equal(failures.length, 1);
});

test('N1: with --allow-partial-sitemaps an unread child sitemap is an error; the headline never says "cleanly"', async () => {
  const site = await serve({
    '/robots.txt': [200, {}, ''],
    '/index.xml': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<sitemapindex><sitemap><loc>http://${req.headers.host}/s1.xml</loc></sitemap><sitemap><loc>http://${req.headers.host}/s2.xml</loc></sitemap></sitemapindex>`);
    },
    '/s1.xml': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<urlset><url><loc>http://${req.headers.host}/fine</loc></url></urlset>`);
    },
    '/s2.xml': [503, {}, 'down'],
    '/fine': html('Fine'),
  });
  const dir = await tmp();
  const strict = await run(['--sitemap', `${site.origin}/index.xml`, '--delay', '0', '--retries', '0', '--no-content', '--out', join(dir, 'a')]);
  assert.equal(strict.code, 2);
  assert.match(strict.out, /child sitemap .*s2\.xml/);
  const partial = await run(['--sitemap', `${site.origin}/index.xml`, '--delay', '0', '--retries', '0', '--no-content', '--allow-partial-sitemaps', '--out', join(dir, 'b')]);
  await site.close();
  assert.equal(partial.code, 1);
  assert.match(partial.out, /1 sitemap could not be read/);
  const report = await readFile(join(dir, 'b', 'report.html'), 'utf8');
  assert.match(report, /sitemap could not be read/);
  assert.doesNotMatch(report, /redirect cleanly/);
  assert.match(await readFile(join(dir, 'b', 'report.csv'), 'utf8'), /sitemap-unread/);
});

test('L10: no URLs at all says so', async () => {
  const dir = await tmp();
  const sm = join(dir, 'empty.xml');
  await writeFile(sm, '<urlset></urlset>');
  await assert.rejects(runCheck({ ...FAST, sitemaps: [sm] }), /No URLs found/);
});

// ---- H4, L7: the map ----

test('H4: header names with "URL", reversed order and a Notes column first', () => {
  const pairs = (text) => parseRedirectMap(text).entries.map((e) => [e.old, e.new]);
  assert.deepEqual(pairs('Destination URL;Source URL\n/new;/old'), [['/old', '/new']]);
  assert.deepEqual(pairs('Target URL,Source URL\n/new,/old'), [['/old', '/new']]);
  assert.deepEqual(pairs('Notes,Source URL,Destination URL\nhi,/old,/new'), [['/old', '/new']]);
  assert.deepEqual(pairs('Redirect from,Redirect to\n/old,/new'), [['/old', '/new']]);
  assert.deepEqual(pairs('Old URLs,New URLs\n/old,/new'), [['/old', '/new']]);
  assert.throws(() => parseRedirectMap('foo,bar\n/a,/b'), /doesn't say which column is old/);
  assert.throws(() => parseRedirectMap('old,new\n/a,\n/b,'), /None of the 2 rows/);
});

test('L7: an unclosed quote is an error with its line; UTF-16 files are read', async () => {
  assert.throws(() => parseRedirectMap('old,new\n/a,/b\n"/c,/d\n/e,/f'), /quote opened on line 3/);
  const dir = await tmp();
  const file = join(dir, 'utf16.tsv');
  await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('old\tnew\r\n/a\t/b\r\n', 'utf16le')]));
  assert.deepEqual(parseRedirectMap(await loadText(file)).entries.map((e) => [e.old, e.new]), [['/a', '/b']]);
});

// ---- M1, M2, L12: hostile robots.txt and HTML are fast ----

test('M1: pathological robots.txt wildcards match in linear time', () => {
  const pattern = compilePattern(`/${'a*'.repeat(30)}b`);
  const a = cpuMs(() => {
    for (let i = 0; i < 200; i += 1) matches(pattern, `/${'a'.repeat(2000)}`);
  });
  assert.ok(a < 1000, `${a} ms CPU`);
  const many = `User-agent: *\n${Array.from({ length: 5000 }, (_, i) => `Disallow: /p${i}/`).join('\n')}`;
  const b = cpuMs(() => {
    for (let i = 0; i < 200; i += 1) robotsAllows(many, 'redirect-map-check', `/x${i}`);
  });
  assert.ok(b < 5000, `${b} ms CPU`);
});

test('M2: malformed HTML is parsed in linear time', () => {
  const ms = cpuMs(() => {
    extractPageInfo(`<h1>${'<'.repeat(2_000_000)}`);
    extractPageInfo(`<title>${'<a'.repeat(1_000_000)}`);
    extractPageInfo('<!--'.repeat(500_000));
    extractPageInfo('<script>'.repeat(250_000));
  });
  assert.ok(ms < 2000, `${ms} ms CPU`);
});

test('L12: robots user-agent groups match our product token exactly', () => {
  assert.equal(robotsAllows('User-agent: map\nDisallow: /\n', 'redirect-map-check', '/x'), true);
  assert.equal(robotsAllows('User-agent: Redirect-Map-Check/2.0\nDisallow: /\n', 'redirect-map-check', '/x'), false);
});

// ---- M3: every hop goes through the per-host delay ----

test('M3: followed redirects respect the per-host delay', async () => {
  const site = await serve({
    '/robots.txt': [200, {}, ''],
    '/a': redirect(301, '/b'),
    '/b': redirect(301, '/c'),
    '/c': html('C'),
  });
  const fetcher = new Fetcher({ userAgent: 't', productToken: 't', delayMs: 120 });
  await fetcher.trustHost(site.origin);
  // Read the start time the scheduler records for each request (server arrival times
  // include connection setup, and timers drift under load).
  const starts = [];
  const turn = fetcher.turn.bind(fetcher);
  fetcher.turn = async (url) => {
    await turn(url);
    starts.push(fetcher.site(url).lastStart);
  };
  await fetcher.follow(`${site.origin}/a`, { wantBody: true, checkRobots: true });
  fetcher.close();
  await site.close();
  assert.equal(starts.length, 4); // robots.txt, /a, /b, /c
  for (let i = 1; i < starts.length; i += 1) assert.ok(starts[i] - starts[i - 1] >= 120, `gap ${starts[i] - starts[i - 1]} ms`);
});

// ---- M4, M6: hosts ----

test('M4: an external target is not rewritten onto --base and stays a full URL in the fix', async () => {
  const site = await serve({ '/robots.txt': [200, {}, ''], '/walnut': redirect(301, '/shop/walnut') });
  const dir = await tmp();
  const map = join(dir, 'map.csv');
  await writeFile(map, 'old,new\nhttps://www.shop.example/walnut,https://elsewhere.example/walnut\nhttps://www.shop.example/a,https://www.shop.example/b\n');
  const result = await runCheck({ ...FAST, map, base: site.origin, content: false, retries: 0 });
  await site.close();
  const walnut = result.results.find((r) => r.key === '/walnut');
  assert.equal(walnut.expectedUrl, 'https://elsewhere.example/walnut');
  const fix = walnut.issues.find((i) => i.type === 'wrong-target').fix;
  assert.match(fix, /https:\/\/elsewhere\.example\/walnut/);
});

test('M6: a domain change does not create a false map chain', async () => {
  const dir = await tmp();
  const map = join(dir, 'map.csv');
  await writeFile(map, 'old,new\nhttps://a.example/team,https://b.example/about\nhttps://a.example/about,https://b.example/about-us\n');
  const { targets } = await collectTargets({ map }, null, []);
  assert.deepEqual(targets.flatMap((t) => t.mapIssues.map((i) => i.type)), []);
});

// ---- M5: loops and self-targets inside the map ----

test('M5: a cycle in the map is an error; a self-target is a notice; duplicates are noticed', async () => {
  const dir = await tmp();
  const map = join(dir, 'map.csv');
  await writeFile(map, 'old,new\n/loop-a,/loop-b\n/loop-b,/loop-a\n/faq,/faq\n/x,/y\n/x,/y\n/y,/z\n');
  const { targets } = await collectTargets({ map, oldBase: 'https://s.example' }, null, []);
  const by = Object.fromEntries(targets.map((t) => [t.key, t.mapIssues.map((i) => i.type).sort()]));
  assert.deepEqual(by['/loop-a'], ['map-loop']);
  assert.deepEqual(by['/loop-b'], ['map-loop']);
  assert.deepEqual(by['/faq'], ['map-self-target']);
  assert.deepEqual(by['/x'], ['map-chain', 'map-duplicate']);
});

test('M5: a row that keeps its URL (/,/) does not turn rows pointing at it into chains', async () => {
  const dir = await tmp();
  const map = join(dir, 'map.csv');
  await writeFile(map, 'old,new\n/,/\n/products/chair,/\n/faq,/faq\n/help,/faq\n');
  const { targets } = await collectTargets({ map, oldBase: 'https://s.example' }, null, []);
  const by = Object.fromEntries(targets.map((t) => [t.key, t.mapIssues.map((i) => i.type).sort()]));
  assert.deepEqual(by['/'], ['map-self-target']);
  assert.deepEqual(by['/products/chair'], []);
  assert.deepEqual(by['/help'], []);
});

// ---- M7, M8: one problem, one issue; variants aren't wrong targets ----

test('M7/M8: a mapped URL with no rule is only "not redirected"; http/www/case variants are a warning', () => {
  const base = (over) => ({
    oldUrl: 'https://s.example/a',
    requestUrl: 'https://s.example/a',
    expectedUrl: 'https://s.example/b',
    inSitemap: true,
    mapIssues: [],
    chain: { hops: [], finalUrl: null, finalStatus: null, page: null },
    ...over,
  });
  const noRule = base({ chain: { hops: [{ url: 'https://s.example/a', status: 404 }], finalUrl: 'https://s.example/a', finalStatus: 404 } });
  assert.deepEqual(evaluate(noRule, { minSimilarity: 0.25 }).map((i) => i.type), ['not-redirected']);
  const variant = base({
    expectedUrl: 'http://s.example/About',
    chain: {
      hops: [
        { url: 'https://s.example/a', status: 301 },
        { url: 'https://www.s.example/about', status: 200 },
      ],
      finalUrl: 'https://www.s.example/about',
      finalStatus: 200,
    },
  });
  assert.deepEqual(evaluate(variant, { minSimilarity: 0.25 }).map((i) => i.type), ['target-variant']);
  assert.deepEqual(variantDifferences('http://s.example/About', 'https://www.s.example/about'), ['scheme', 'www', 'case']);
});

// ---- M9: private network ----

test('M9: a redirect into another local port or a private address is refused', async () => {
  const internal = await serve({ '/admin': html('INTERNAL ADMIN') });
  const site = await serve({
    '/robots.txt': [200, {}, ''],
    '/to-internal': redirect(301, `${internal.origin}/admin`),
    '/to-metadata': redirect(301, 'http://169.254.169.254/latest/meta-data/'),
  });
  const dir = await tmp();
  const map = join(dir, 'map.csv');
  await writeFile(map, 'old,new\n/to-internal,/new\n/to-metadata,/new\n');
  const result = await runCheck({ ...FAST, map, base: site.origin, content: false });
  await Promise.all([site.close(), internal.close()]);
  for (const r of result.results) assert.ok(types(r).includes('private-address'), `${r.key}: ${types(r)}`);
  assert.equal(internal.log.length, 0);
  assert.equal(isPrivateAddress('::ffff:10.0.0.1'), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
});

test('M9: --allow-private-network lets it through (remote inputs are not trusted on their own)', async () => {
  const internal = await serve({ '/robots.txt': [200, {}, ''], '/admin': html('Admin') });
  const site = await serve({ '/robots.txt': [200, {}, ''], '/to-internal': redirect(301, `${internal.origin}/admin`) });
  // A map served over HTTP: its entries are not "named by you", so their hosts aren't trusted.
  const mapServer = await serve({ '/map.csv': [200, { 'content-type': 'text/csv' }, `old,new\n${site.origin}/to-internal,${internal.origin}/admin\n`] });
  const map = `${mapServer.origin}/map.csv`;
  const blocked = await runCheck({ ...FAST, map, oldBase: site.origin, content: false });
  const allowed = await runCheck({ ...FAST, map, oldBase: site.origin, content: false, allowPrivateNetwork: true });
  await Promise.all([site.close(), internal.close(), mapServer.close()]);
  assert.deepEqual(types(blocked.results[0]), ['private-address']);
  assert.deepEqual(types(allowed.results[0]), []);
});

// ---- M10: scale ----

test('M10: 800 old URLs against 800 new pages finishes quickly', async () => {
  const routes = { '/robots.txt': [200, {}, ''] };
  const words = ['oak', 'pine', 'walnut', 'teak', 'ash', 'birch', 'maple', 'cedar'];
  const items = ['table', 'chair', 'desk', 'shelf', 'bench', 'bed', 'sofa', 'lamp', 'stool', 'rug'];
  const lines = ['old,new'];
  const newUrls = [];
  for (let i = 0; i < 800; i += 1) {
    const name = `${words[i % 8]}-${items[(i >> 3) % 10]}-${i}`;
    routes[`/old/${name}`] = redirect(301, `/new/${name}`);
    routes[`/new/${name}`] = html(`${name.replace(/-/g, ' ')} | Shop`);
    routes[`/catalogue/${name}`] = html(`${name.replace(/-/g, ' ')} | Shop`);
    lines.push(`/old/${name},/new/${name}-gone`);
    newUrls.push(`/catalogue/${name}`);
  }
  const site = await serve(routes);
  const dir = await tmp();
  const map = join(dir, 'map.csv');
  const list = join(dir, 'new.txt');
  await writeFile(map, lines.join('\n'));
  await writeFile(list, newUrls.join('\n'));
  // CPU time, not wall time: stable when other processes compete for the cores.
  const cpu0 = process.cpuUsage();
  const result = await runCheck({ ...FAST, map, base: site.origin, newUrlLists: [list], concurrency: 8, respectRobots: false });
  await site.close();
  const cpu = process.cpuUsage(cpu0);
  const ms = (cpu.user + cpu.system) / 1000;
  assert.equal(result.results.length, 800);
  assert.ok(ms < 6000, `${Math.round(ms)} ms CPU`);
});

// ---- L1: Retry-After beyond the cap ----

test('L1: a 429 asking for an hour is reported, not retried after 30 s', async () => {
  const site = await serve({ '/robots.txt': [200, {}, ''], '/a': [429, { 'retry-after': '3600' }, 'slow down'] });
  const dir = await tmp();
  const map = join(dir, 'map.csv');
  await writeFile(map, 'old,new\n/a,/b\n');
  const t0 = Date.now();
  const result = await runCheck({ ...FAST, map, base: site.origin, content: false });
  await site.close();
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(site.log.filter((l) => l.path === '/a').length, 1);
  assert.deepEqual(types(result.results[0]), ['rate-limited']);
  assert.match(result.results[0].issues[0].fix, /--delay/);
  assert.ok(result.notes.some((n) => /429/.test(n)));
});

// ---- L2, L6, nits ----

test('L2: only real language codes count as a homepage', () => {
  assert.equal(isRootLike('https://s.example/tv'), false);
  assert.equal(isRootLike('https://s.example/ai/'), false);
  assert.equal(isRootLike('https://s.example/de-at/'), true);
  assert.equal(isRootLike('https://s.example/ro'), true);
});

test('L6: <meta charset> is honoured when the header has none', () => {
  const body = Buffer.concat([Buffer.from('<meta charset="windows-1252"><title>Caf'), Buffer.from([0xe9]), Buffer.from('</title>')]);
  assert.equal(extractPageInfo(decodeHtml(body, 'text/html')).title, 'Café');
});

test('L9: an unusable --out fails before any crawling', async () => {
  const dir = await tmp();
  const file = join(dir, 'a-file');
  await writeFile(file, 'x');
  const map = join(dir, 'map.csv');
  await writeFile(map, 'old,new\nhttps://unreachable.invalid/a,https://unreachable.invalid/b\n');
  const t0 = Date.now();
  const { code, out } = await run(['--map', map, '--out', file]);
  assert.equal(code, 2);
  assert.match(out, /can't write reports/);
  assert.ok(Date.now() - t0 < 3000);
});

test('nits: hop limit wording, delimiter in example rows', async () => {
  const site = await serve({
    '/robots.txt': [200, {}, ''],
    '/h0': redirect(301, '/h1'),
    '/h1': redirect(301, '/h2'),
    '/h2': redirect(301, '/h3'),
    '/h3': html('End'),
    '/g': redirect(301, '/landing'),
    '/landing': html('Landing'),
  });
  const dir = await tmp();
  const list = join(dir, 'old.txt');
  await writeFile(list, `${site.origin}/h0\n${site.origin}/g\n`);
  const map = join(dir, 'map.csv');
  await writeFile(map, `old;new\n${site.origin}/unrelated;${site.origin}/landing\n`);
  const result = await runCheck({ ...FAST, urlLists: [list], map, maxHops: 2, content: false });
  await site.close();
  const h0 = result.results.find((r) => r.key === '/h0');
  assert.match(h0.issues.find((i) => i.type === 'too-many-redirects').detail, /More than 2 redirects/);
  const g = result.results.find((r) => r.key === '/g');
  assert.match(g.issues.find((i) => i.type === 'missing-from-map').fix, /"\/g;\/landing"/);
  assert.ok(!existsSync(join(dir, 'old-pages.json')));
});

// ---- Round 2 (N1–N13) ----

test('N2: malformed sitemap extension blocks and unclosed locs parse in linear time', () => {
  const ms = cpuMs(() => {
    parseSitemap('<image:image>'.repeat(300_000));
    parseSitemap(`<urlset>${'<loc><![CDATA['.repeat(200_000)}`);
    parseSitemap('<loc>x'.repeat(400_000));
  });
  assert.ok(ms < 1500, `${ms} ms CPU`);
});

test('N3: a page of many closed comments is read in linear time', () => {
  let info;
  const ms = cpuMs(() => {
    info = extractPageInfo(`${'<!--x-->'.repeat(32_768)}<title>T</title>`);
  });
  assert.ok(ms < 500, `${ms} ms CPU`);
  assert.equal(info.title, ''); // past the 256 KB scan limit, by design
  assert.equal(extractPageInfo(`${'<!--x-->'.repeat(1000)}<title>T</title>`).title, 'T');
});

test('N4: with relative targets, rows pointing at another site stay external', async () => {
  const site = await serve({ '/robots.txt': [200, {}, ''], '/about-us': redirect(301, '/about'), '/about': html('About'), '/docs/setup': redirect(301, 'https://help.vendor.example/setup') });
  const dir = await tmp();
  const map = join(dir, 'map.csv');
  await writeFile(map, 'old,new\n/about-us,/about\n/docs/setup,https://help.vendor.example/setup\n/docs/billing,https://help.vendor.example/billing\n');
  const result = await runCheck({ ...FAST, map, base: site.origin, content: false, retries: 0 });
  await site.close();
  const setup = result.results.find((r) => r.key === '/docs/setup');
  assert.equal(setup.expectedUrl, 'https://help.vendor.example/setup');
  assert.ok(!types(setup).includes('not-redirected'));
  assert.ok(result.notes.some((n) => /help\.vendor\.example as external/.test(n)));
});

test('N5/N6/R3: trust is by host name and pinned to the addresses seen at the start', async () => {
  // Simulated DNS: staging.internal resolves to 10.0.0.5 when we start, later to 10.0.0.9.
  let answer = '10.0.0.5';
  const lookup = (name, opts, cb) => cb(null, [{ address: name === 'staging.internal' ? answer : '93.184.216.34', family: 4 }]);
  const f = new Fetcher({ userAgent: 't', productToken: 't', lookup });
  await f.trustHost('http://127.0.0.1:4102/');
  assert.equal(f.addressAllowed('::1', '4102', 'localhost'), true); // loopback names are one host…
  assert.equal(f.addressAllowed('127.0.0.1', '80', 'localhost'), false); // …on the named port only
  assert.equal(f.addressAllowed('127.0.0.1', '443', '127.0.0.1'), false); // loopback: the named port only
  assert.equal(f.addressAllowed('127.0.0.1', '6379', '127.0.0.1'), false);
  await f.trustHost('http://staging.internal/');
  assert.equal(f.addressAllowed('10.0.0.5', '443', 'staging.internal'), true); // http → https
  answer = '10.0.0.9';
  assert.equal(f.addressAllowed('10.0.0.9', '80', 'staging.internal'), false); // re-resolved elsewhere: refused
  assert.equal(f.addressAllowed('10.0.0.5', '80', '10.0.0.5'), false); // the bare address isn't trusted
  assert.equal(f.addressAllowed('10.0.0.5', '80', 'intranet.example'), false);
  f.close();
});

test('N5: after naming 127.0.0.1, a redirect to localhost on the same port is allowed', async () => {
  const local = await serve({ '/robots.txt': [200, {}, ''], '/b': html('B') });
  const port = new URL(local.origin).port;
  const fetcher = new Fetcher({ userAgent: 't', productToken: 't' });
  await fetcher.trustHost(local.origin); // http://127.0.0.1:<port>
  const res = await fetcher.follow(`http://localhost:${port}/b`, { wantBody: true });
  fetcher.close();
  await local.close();
  assert.notEqual(res.errorCode, 'EPRIVATE');
  assert.equal(res.status, 200);
});

test('N7: candidate scoring stays fast on a large catalogue', async () => {
  const pages = [];
  for (let i = 0; i < 3000; i += 1) pages.push({ url: `https://s.example/catalogue/oak-table-${i}`, title: `Oak table ${i} | Shop`, h1: `Oak table ${i}` });
  const { createScorer } = await import('../src/content.js');
  const scorer = createScorer(pages, pages);
  const ms = cpuMs(() => {
    for (let i = 0; i < 300; i += 1) scorer(pages[i], pages[(i * 7) % 3000]);
  });
  assert.ok(ms < 500, `${ms} ms CPU`);
});

test('N8: the target-variant fix writes the value the way the map does', () => {
  const r = {
    oldUrl: 'https://old.example/a',
    requestUrl: 'http://127.0.0.1:9/a',
    expectedUrl: 'http://127.0.0.1:9/About',
    mapTarget: 'https://new.example/About',
    mapLine: 2,
    chain: { hops: [{ url: 'http://127.0.0.1:9/a', status: 301 }, { url: 'http://127.0.0.1:9/about', status: 200 }], finalUrl: 'http://127.0.0.1:9/about', finalStatus: 200 },
  };
  const fx = fixContext({ localHosts: ['127.0.0.1:9', 'old.example'], baseHosts: ['127.0.0.1:9'] });
  const fix = recommendFix({ type: 'target-variant', data: { differences: ['case'], landed: 'http://127.0.0.1:9/about' } }, r, fx);
  assert.match(fix, /Update row 2 to https:\/\/new\.example\/about /);
});

test('N9: HTTP edge cases keep the status and decode what arrives', async () => {
  const page = '<html><head><title>Deflated page</title></head><body>' + 'x'.repeat(5000) + '</body></html>';
  const gz = gzipSync(page);
  const site = await serve({
    '/drip404': (req, res) => {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.write('<p>');
      const t = setInterval(() => res.write('.'), 50);
      res.on('close', () => clearInterval(t));
    },
    '/raw-deflate': [200, { 'content-type': 'text/html', 'content-encoding': 'deflate' }, deflateRawSync(page)],
    '/trunc-gzip': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      res.end(gz.subarray(0, gz.length - 8));
    },
    '/cut': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': '100000' });
      res.write('<title>Cut short</title>');
      setTimeout(() => res.destroy(), 50);
    },
  });
  const f = new Fetcher({ userAgent: 't', productToken: 't', timeoutMs: 1500 });
  await f.trustHost(site.origin);
  const t0 = Date.now();
  const drip = await f.once(`${site.origin}/drip404`);
  assert.equal(drip.status, 404);
  assert.ok(Date.now() - t0 < 1000);
  const raw = await f.once(`${site.origin}/raw-deflate`, { wantBody: true });
  assert.equal(extractPageInfo(raw.body.toString()).title, 'Deflated page');
  const trunc = await f.once(`${site.origin}/trunc-gzip`, { wantBody: true });
  assert.equal(extractPageInfo(trunc.body.toString()).title, 'Deflated page');
  const cut = await f.once(`${site.origin}/cut`, { wantBody: true });
  assert.equal(cut.status, 200);
  assert.equal(cut.truncated, true);
  assert.equal(extractPageInfo(cut.body.toString()).title, 'Cut short');
  f.close();
  await site.close();
});

test('N10: a page from the sitemap and a map row on another host are checked once on --base', async () => {
  const { startDemo } = await import('../demo/server.js');
  const demo = await startDemo();
  const dir = await tmp();
  const map = join(dir, 'map.csv');
  await writeFile(map, 'old,new\nhttps://www.harbor-pine.example/showroom,https://www.harbor-pine.example/visit-us\n');
  const result = await runCheck({ ...FAST, sitemaps: [`${demo.oldOrigin}/sitemap.xml`], map, base: demo.newOrigin, content: false });
  await demo.close();
  const showroom = result.results.filter((r) => r.key === '/showroom');
  assert.equal(showroom.length, 1);
  assert.ok(showroom[0].inSitemap && showroom[0].inMap);
  assert.ok(!types(showroom[0]).includes('missing-from-map'));
  assert.ok(result.notes.some((n) => /same page on --base/.test(n)));
});

test('N11: on a loop row the not-redirected fix defers to the loop', async () => {
  const site = await serve({ '/robots.txt': [200, {}, ''] });
  const dir = await tmp();
  const map = join(dir, 'map.csv');
  await writeFile(map, 'old,new\n/loop-a,/loop-b\n/loop-b,/loop-a\n');
  const result = await runCheck({ ...FAST, map, base: site.origin, content: false });
  await site.close();
  const fix = result.results[0].issues.find((i) => i.type === 'not-redirected').fix;
  assert.match(fix, /don't add the one in the map yet.*part of a loop/);
});

test('N12: a later partial run merges into old-pages.json instead of shrinking it', async () => {
  const dir = await tmp();
  const summary = { urlsChecked: 0, clean: 0, urlsWithErrors: 0, urlsWithWarnings: 0, urlsUnchecked: 0, sitemapsUnread: 0, bySeverity: { error: 0, warning: 0, notice: 0 }, byType: {}, requests: 0, durationMs: 0, generatedAt: 'now' };
  const base = { summary, notes: [], mapRowIssues: [], results: [], oldPagesFromSnapshot: false };
  await writeReports({ ...base, oldPages: { a: { title: 'A' }, b: { title: 'B' }, c: { title: 'C' } } }, dir);
  const files = await writeReports({ ...base, oldPages: { a: { title: 'A2' } } }, dir);
  const pages = JSON.parse(await readFile(join(dir, 'old-pages.json'), 'utf8')).pages;
  assert.deepEqual(Object.keys(pages).sort(), ['a', 'b', 'c']);
  assert.equal(pages.a.title, 'A2');
  assert.equal(files.snapshotKept, 2);
});

test('N13: specific header names beat generic ones; Romanian headers; UTF-16 without BOM; Windows-1252', async () => {
  const pairs = (text) => parseRedirectMap(text).entries.map((e) => [e.old, e.new]);
  assert.deepEqual(pairs('Redirect,Old URL,New URL\n301,/a,/b'), [['/a', '/b']]);
  assert.deepEqual(pairs('URL vechi,URL nou\n/a,/b'), [['/a', '/b']]);
  assert.deepEqual(pairs('Sursă;Destinație\n/a;/b'), [['/a', '/b']]);
  const dir = await tmp();
  const u16 = join(dir, 'u16.csv');
  await writeFile(u16, Buffer.from('old,new\n/a,/b\n', 'utf16le'));
  const notes = [];
  assert.deepEqual(parseRedirectMap(await loadText(u16, null, { notes })).entries.map((e) => [e.old, e.new]), [['/a', '/b']]);
  const cp = join(dir, 'cp1252.csv');
  await writeFile(cp, Buffer.concat([Buffer.from('old,new\n/caf'), Buffer.from([0xe9]), Buffer.from(',/b\n')]));
  assert.deepEqual(parseRedirectMap(await loadText(cp, null, { notes })).entries.map((e) => e.old), ['/café']);
  assert.equal(notes.length, 2);
});

test('nits: ::7f00:1 is private; robots rule cap is noted; http/https/www share one delay', () => {
  assert.equal(isPrivateAddress('::7f00:1'), true);
  const groups = parseRobots(`User-agent: *\n${Array.from({ length: 5010 }, (_, i) => `Disallow: /p${i}`).join('\n')}`);
  assert.equal(groups.truncated, 5000);
  const f = new Fetcher({ userAgent: 't', productToken: 't' });
  assert.equal(f.site(new URL('http://www.shop.example/a')), f.site(new URL('https://shop.example/b')));
  assert.notEqual(f.site(new URL('http://shop.example:8080/a')), f.site(new URL('https://shop.example/b')));
  f.close();
});

// ---- Round 3 (R1–R4, L-new-1…4) ----

test('R1: two mapped rows on different old hosts that meet on --base are both checked', async () => {
  const site = await serve({ '/robots.txt': [200, {}, ''], '/about-us': redirect(301, '/about'), '/about': html('About') });
  const dir = await tmp();
  const map = join(dir, 'map.csv');
  await writeFile(map, 'old,new\nhttps://www.old.example/about-us,/about\nhttps://blog.old.example/about-us,/blog/about\n');
  const result = await runCheck({ ...FAST, map, base: site.origin, content: false, newHosts: ['old.example'] });
  await site.close();
  assert.equal(result.results.length, 2);
  assert.ok(result.results.some((r) => types(r).includes('wrong-target')));
  assert.ok(result.notes.some((n) => /become the same URL on --base/.test(n)));
});

test('R2: a "/,/" row does not stop an all-absolute map from being a domain change', async () => {
  const site = await serve({ '/robots.txt': [200, {}, ''], '/a': redirect(301, '/new-a'), '/b': redirect(301, '/new-b'), '/new-a': html('A'), '/new-b': html('B'), '/': html('Home') });
  const dir = await tmp();
  const map = join(dir, 'map.csv');
  await writeFile(map, 'old,new\n/,/\nhttps://old.example/a,https://new.example/new-a\nhttps://old.example/b,https://new.example/new-b\n');
  const result = await runCheck({ ...FAST, map, base: site.origin, content: false });
  await site.close();
  assert.deepEqual(result.results.flatMap((r) => r.issues.filter((i) => i.severity === 'error').map((i) => i.type)), []);
  assert.ok(result.notes.some((n) => /Treated new\.example as the new site/.test(n)));
});

test('R4: slow unwanted bodies never make the next request wait for a socket', async () => {
  const drip = (status, extra = {}) => (req, res) => {
    res.writeHead(status, { 'content-type': 'text/html', ...extra });
    const t = setInterval(() => res.write('.'), 100);
    res.on('close', () => clearInterval(t));
  };
  const routes = { '/robots.txt': [200, {}, ''] };
  for (let i = 0; i < 6; i += 1) routes[`/d${i}`] = i % 2 ? drip(301, { location: `/end${i}` }) : drip(404);
  for (let i = 0; i < 6; i += 1) routes[`/end${i}`] = html(`End ${i}`);
  const site = await serve(routes);
  const dir = await tmp();
  const list = join(dir, 'old.txt');
  await writeFile(list, Array.from({ length: 6 }, (_, i) => `${site.origin}/d${i}`).join('\n'));
  const result = await runCheck({ ...FAST, urlLists: [list], content: false, concurrency: 2, timeoutMs: 2000, retries: 0 });
  await site.close();
  for (const r of result.results) assert.ok(!types(r).includes('fetch-error'), `${r.key}: ${types(r)}`);
});

test('L-new-1: an unclosed image block does not swallow the next page entry', () => {
  const parsed = parseSitemap('<urlset><url><loc>https://s/a</loc><image:image><image:loc>https://cdn/x.jpg</image:loc></url><url><loc>https://s/b</loc></url></urlset>');
  assert.deepEqual(parsed.locs, ['https://s/a', 'https://s/b']);
  assert.equal(parsed.malformed, 1);
});

test('L-new-3: a gzip body cut before its trailer is marked truncated; a header-only body is an error', async () => {
  const gz = gzipSync(`<title>Whole</title>${'x'.repeat(3000)}`);
  const site = await serve({
    '/short': [200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }, gz.subarray(0, gz.length - 8)],
    '/header-only': [200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }, gz.subarray(0, 10)],
    '/whole': [200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }, gz],
  });
  const f = new Fetcher({ userAgent: 't', productToken: 't' });
  await f.trustHost(site.origin);
  const short = await f.once(`${site.origin}/short`, { wantBody: true });
  const head = await f.once(`${site.origin}/header-only`, { wantBody: true });
  const whole = await f.once(`${site.origin}/whole`, { wantBody: true });
  f.close();
  await site.close();
  assert.equal(short.truncated, true);
  assert.equal(extractPageInfo(short.body.toString()).title, 'Whole');
  assert.equal(head.errorCode, 'EBODY');
  assert.equal(whole.truncated, false);
});

test('L-new-4: a page that arrives cut off gets a notice', async () => {
  const site = await serve({
    '/robots.txt': [200, {}, ''],
    '/old': redirect(301, '/cut'),
    '/cut': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': '50000' });
      res.write('<title>Partial</title>');
      setTimeout(() => res.destroy(), 50);
    },
  });
  const dir = await tmp();
  const map = join(dir, 'map.csv');
  await writeFile(map, `old,new\n${site.origin}/old,${site.origin}/cut\n`);
  const result = await runCheck({ ...FAST, map });
  await site.close();
  assert.ok(types(result.results[0]).includes('page-incomplete'));
});

test('U1: local inputs must be regular files (a FIFO would block forever)', { skip: process.platform === 'win32' }, async () => {
  const dir = await tmp();
  const fifo = join(dir, 'pipe.xml');
  await new Promise((resolve, reject) => spawn('mkfifo', [fifo]).on('exit', (c) => (c === 0 ? resolve() : reject(new Error('mkfifo failed')))));
  const { loadText } = await import('../src/inputs.js');
  await assert.rejects(loadText(fifo), /not a regular file/);
});

test('S1: a remote child of a local sitemap index is trusted only on its own host', async () => {
  const { collectTargets } = await import('../src/check.js');
  const dir = await tmp();
  const index = join(dir, 'index.xml');
  await writeFile(index, '<sitemapindex><sitemap><loc>https://public-child.example/child.xml</loc></sitemap></sitemapindex>');
  const local = join(dir, 'local.xml');
  await writeFile(local, '<urlset><url><loc>http://10.0.0.9/mine</loc></url></urlset>');
  const child = '<urlset><url><loc>https://public-child.example/page</loc></url><url><loc>http://10.0.0.1/admin</loc></url><url><loc>http://169.254.169.254/latest/</loc></url></urlset>';
  const fetcher = { fetchRaw: async () => ({ status: 200, body: Buffer.from(child), truncated: false }) };
  const { trusted } = await collectTargets({ sitemaps: [index, local] }, fetcher, []);
  assert.ok(trusted.includes('https://public-child.example/page'));
  assert.ok(!trusted.includes('http://10.0.0.1/admin'));
  assert.ok(!trusted.includes('http://169.254.169.254/latest/'));
  assert.ok(trusted.includes('http://10.0.0.9/mine'), 'entries of a local file are still the user\'s own');
});

test('L3: cancelling while inputs load is reported as a cancel', async () => {
  const { runCheck } = await import('../src/check.js');
  const controller = new AbortController();
  const fetcher = {
    trustHost: async () => {},
    fetchRaw: async () => {
      controller.abort();
      return { status: 0, error: 'Cancelled', errorCode: 'ECANCELLED' };
    },
    close() {},
  };
  await assert.rejects(runCheck({ sitemaps: ['https://example.com/sitemap.xml'], fetcher, signal: controller.signal }), (err) => err.code === 'ECANCELLED');
});

test('L16 (planner QA): a sitemap index on the web can only point at web addresses, never a file here', async () => {
  // A file the old code would have opened: "x:local.xml" parses as a URL with scheme x:,
  // is not http, and was read as the relative path x:local.xml in the current folder.
  const dir = await tmp();
  await writeFile(join(dir, 'x:local.xml'), '<urlset><url><loc>https://s.example/from-this-computer</loc></url></urlset>');
  const site = await serve({
    '/index.xml': [200, { 'content-type': 'application/xml' }, `<sitemapindex>
      <sitemap><loc>/pages.xml</loc></sitemap>
      <sitemap><loc>x:local.xml</loc></sitemap>
      <sitemap><loc>file:///etc/passwd</loc></sitemap>
    </sitemapindex>`],
    '/pages.xml': [200, { 'content-type': 'application/xml' }, '<urlset><url><loc>https://s.example/a</loc></url></urlset>'],
  });
  const fetcher = new Fetcher({ userAgent: 't', productToken: 't', delayMs: 0 });
  await fetcher.trustHost(site.origin);
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await assert.rejects(loadSitemapUrls(`${site.origin}/index.xml`, fetcher, {}), /isn't a web address/);
    const failures = [];
    const urls = await loadSitemapUrls(`${site.origin}/index.xml`, fetcher, { allowPartial: true, failures });
    assert.deepEqual(urls, ['https://s.example/a']);
    assert.deepEqual(failures.map((f) => f.sitemap).sort(), ['file:///etc/passwd', 'x:local.xml']);
    assert.ok(failures.every((f) => /isn't a web address/.test(f.reason)));
  } finally {
    process.chdir(cwd);
    fetcher.close();
    await site.close();
  }
  // A local index may still point at local files and at web addresses.
  await writeFile(join(dir, 'pages.xml'), '<urlset><url><loc>https://s.example/b</loc></url></urlset>');
  await writeFile(join(dir, 'index.xml'), '<sitemapindex><sitemap><loc>pages.xml</loc></sitemap></sitemapindex>');
  assert.deepEqual(await loadSitemapUrls(join(dir, 'index.xml'), null, {}), ['https://s.example/b']);
});

test('L1 (planner QA): the hint at the end of the child-sitemap error is the caller\'s to set', async () => {
  const dir = await tmp();
  await writeFile(join(dir, 'index.xml'), '<sitemapindex><sitemap><loc>missing.xml</loc></sitemap></sitemapindex>');
  await assert.rejects(loadSitemapUrls(join(dir, 'index.xml'), null, {}), /we stopped\. Re-run, or pass --allow-partial-sitemaps/);
  await assert.rejects(loadSitemapUrls(join(dir, 'index.xml'), null, { partialHint: 'Try --other.' }), (err) => {
    assert.match(err.message, /we stopped\. Try --other\.$/);
    assert.doesNotMatch(err.message, /allow-partial/);
    return true;
  });
  await assert.rejects(loadSitemapUrls(join(dir, 'index.xml'), null, { partialHint: '' }), /we stopped\.$/);
});
