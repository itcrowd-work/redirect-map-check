// The package's public subpaths (0.2.0). Each promised name must exist; anything not in
// "exports" must stay unreachable, so internals can change without breaking other tools.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const PROMISED = {
  'redirect-map-check': ['runCheck', 'evaluate', 'DEFAULTS', 'ISSUES', 'writeReports', 'renderHtml', 'renderCsv', 'renderSummary'],
  'redirect-map-check/inputs': ['decodeText', 'loadText', 'parseSitemap', 'loadSitemapUrls', 'parseUrlList', 'parseRedirectMap'],
  'redirect-map-check/csv': ['detectDelimiter', 'parseCsv', 'parseCsvDetailed', 'toCsv'],
  'redirect-map-check/url': ['toUrl', 'isRelative', 'looksLikeUrl', 'normalizeUrl', 'pathKey', 'sameUrl', 'isRootLike', 'foldHost'],
  'redirect-map-check/http': ['Fetcher', 'isPrivateAddress'],
  'redirect-map-check/content': ['decodeHtml', 'extractPageInfo', 'tokenize', 'slugTokens', 'slugSimilarity', 'createScorer', 'similarity', 'matchScore'],
  'redirect-map-check/report-style': ['baseCss', 'BRAIN', 'fonts'],
};

// Exported but not promised: internal helpers the files share, and root exports from before
// 0.2.0. A new export must be added to PROMISED (README table) or here, on purpose.
const UNPROMISED = {
  'redirect-map-check': ['createScorer', 'extractPageInfo', 'isAllowed', 'parseRedirectMap', 'parseRobots', 'parseSitemap', 'parseUrlList', 'robotsAllows', 'selectGroup', 'similarity'],
  'redirect-map-check/inputs': ['MAX_INPUT_BYTES', 'normalizeHeader'],
  'redirect-map-check/csv': [],
  'redirect-map-check/url': ['exactKey', 'hostVariants', 'rebase', 'siteKey', 'variantDifferences'],
  'redirect-map-check/http': [],
  'redirect-map-check/content': ['decodeEntities', 'pageTokens'],
  'redirect-map-check/report-style': ['field'],
};

test('every export is either promised or listed as internal, so nothing becomes public by accident', async () => {
  for (const [specifier, names] of Object.entries(PROMISED)) {
    const known = new Set([...names, ...UNPROMISED[specifier]]);
    for (const name of Object.keys(await import(specifier))) assert.ok(known.has(name), `${specifier} exports ${name}: promise it (README) or list it in UNPROMISED`);
  }
});

test('every promised name is exported from its subpath', async () => {
  for (const [specifier, names] of Object.entries(PROMISED)) {
    const mod = await import(specifier);
    for (const name of names) assert.ok(name in mod, `${specifier} should export ${name}`);
  }
});

test('the subpaths work together: a sitemap, a map and a fetcher from the outside', async () => {
  const { parseSitemap, parseRedirectMap } = await import('redirect-map-check/inputs');
  const { pathKey } = await import('redirect-map-check/url');
  const { Fetcher } = await import('redirect-map-check/http');
  const { toCsv } = await import('redirect-map-check/csv');
  const { extractPageInfo } = await import('redirect-map-check/content');
  const { baseCss } = await import('redirect-map-check/report-style');
  assert.deepEqual(parseSitemap('<urlset><url><loc>https://example.com/a</loc></url></urlset>').locs, ['https://example.com/a']);
  assert.equal(parseRedirectMap('Redirect from,Redirect to\n/a,/pages/a\n').entries[0].new, '/pages/a');
  assert.equal(parseRedirectMap('source,target\n/a,/b\n').entries[0].old, '/a');
  assert.equal(pathKey('https://example.com/A/'), pathKey('https://example.com/A'));
  assert.equal(toCsv([['old', 'new'], ['/a', '/b']]).trim(), 'old,new\r\n/a,/b'.trim());
  assert.equal(extractPageInfo('<title>Pine shelf</title><h1>Pine</h1>').title, 'Pine shelf');
  assert.match(baseCss(), /@font-face/);
  const fetcher = new Fetcher({ userAgent: 'test', productToken: 'test' });
  fetcher.close();
});

test('internal files are not reachable from outside', async () => {
  for (const specifier of ['redirect-map-check/src/check.js', 'redirect-map-check/src/fixes.js', 'redirect-map-check/robots', 'redirect-map-check/bin/redirect-map-check.js']) {
    await assert.rejects(import(specifier), (err) => err.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED', specifier);
  }
});

// The members other tools rely on (README "Promised members"): Fetcher options and methods,
// loadSitemapUrls / loadText options, and the fields of their results.
test('promised members: Fetcher, loadSitemapUrls, loadText and parseRedirectMap', async () => {
  const { Fetcher } = await import('redirect-map-check/http');
  const { loadSitemapUrls, loadText, parseRedirectMap, parseUrlList } = await import('redirect-map-check/inputs');

  const map = parseRedirectMap('Redirect from,Redirect to\n/a,/pages/a\nonly-one-value\n');
  assert.deepEqual(map.entries[0], { old: '/a', new: '/pages/a', line: 2 });
  assert.equal(map.problems[0].line, 3);
  assert.equal(typeof map.problems[0].message, 'string');
  assert.equal(map.delimiter, ',');
  assert.deepEqual(parseUrlList('# comment\n/a\n\n/b extra\n'), ['/a', '/b']);

  const other = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Other</title>'));
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  const otherPort = other.address().port;
  const server = createServer((req, res) => {
    if (req.url === '/robots.txt') return res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nDisallow: /private\n');
    if (req.url === '/hop') return res.writeHead(302, { location: `http://localhost:${otherPort}/` }).end();
    if (req.url === '/sitemap.xml') return res.writeHead(200, { 'content-type': 'application/xml' }).end('<urlset><url><loc>https://example.com/remote</loc></url></urlset>');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<title>Pine</title>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = await mkdtemp(join(tmpdir(), 'rmc-exports-'));
  const notes = [];
  const fetcher = new Fetcher({ userAgent: 'test', productToken: 'test', concurrency: 2, delayMs: 0, timeoutMs: 5000, retries: 0, respectRobots: true, allowPrivateNetwork: false, notes });
  try {
    await fetcher.trustHost(base);
    const ok = await fetcher.follow(`${base}/ok`, { wantBody: true, checkRobots: true });
    assert.equal(ok.status, 200);
    assert.match(String(ok.body), /<title>Pine/);
    assert.match(ok.contentType, /text\/html/);
    const robots = await fetcher.follow(`${base}/private/x`, { wantBody: true, checkRobots: true });
    assert.equal(robots.status, 0);
    assert.equal(robots.errorCode, 'EROBOTS');
    const offsite = await fetcher.follow(`${base}/hop`, { wantBody: true, checkRobots: false });
    assert.equal(offsite.errorCode, 'EPRIVATE', 'a host you did not name, on a private address, is refused');
    const offsiteRobots = await fetcher.follow(`${base}/hop`, { wantBody: true, checkRobots: true });
    assert.equal(offsiteRobots.errorCode, 'EROBOTS');
    assert.equal(offsiteRobots.blocked.kind, 'private', 'with checkRobots the guard shows as blocked.kind');
    assert.equal(robots.blocked.kind, 'disallowed');
    assert.ok(fetcher.requestCount >= 3);
    assert.equal(typeof fetcher.requestCount, 'number');

    await writeFile(join(dir, 'index.xml'), `<sitemapindex><sitemap><loc>${join(dir, 'child.xml')}</loc></sitemap><sitemap><loc>${base}/sitemap.xml</loc></sitemap></sitemapindex>`);
    await writeFile(join(dir, 'child.xml'), '<urlset><url><loc>https://example.com/local</loc></url></urlset>');
    const entrySources = [];
    const urls = await loadSitemapUrls(join(dir, 'index.xml'), fetcher, { notes, entrySources });
    assert.deepEqual([...urls].sort(), ['https://example.com/local', 'https://example.com/remote']);
    const byFile = Object.fromEntries(entrySources.map(({ from, locs }) => [String(from), locs]));
    assert.deepEqual(byFile[join(dir, 'child.xml')], ['https://example.com/local']);
    assert.deepEqual(byFile[`${base}/sitemap.xml`], ['https://example.com/remote']);
    assert.match(await loadText(`${base}/ok`, fetcher, { notes }), /Pine/);
    assert.ok(Array.isArray(notes));
  } finally {
    fetcher.close();
    server.close();
    other.close();
    await rm(dir, { recursive: true, force: true });
  }
});
