// The package's public subpaths (0.2.0). Each promised name must exist; anything not in
// "exports" must stay unreachable, so internals can change without breaking other tools.

import assert from 'node:assert/strict';
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
