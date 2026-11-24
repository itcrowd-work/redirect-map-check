import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { tempDir } from './helpers/tmp.js';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { detectDelimiter, parseCsv, toCsv } from '../src/csv.js';
import { loadSitemapUrls, parseRedirectMap, parseSitemap, parseUrlList } from '../src/inputs.js';
import { isAllowed, parseRobots, robotsAllows, selectGroup } from '../src/robots.js';

test('CSV: quotes, escaped quotes, CRLF, BOM and blank lines', () => {
  const rows = parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n"multi\nline",z');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'say "hi"'], ['multi\nline', 'z']]);
});

test('CSV: detects semicolon and tab delimiters', () => {
  assert.equal(detectDelimiter('old;new\n/a;/b'), ';');
  assert.equal(detectDelimiter('old\tnew'), '\t');
  assert.equal(detectDelimiter('"a;b",c'), ',');
  assert.deepEqual(parseCsv('/a;/b\n/c;/d'), [['/a', '/b'], ['/c', '/d']]);
});

test('CSV: writer quotes and neutralises spreadsheet formulas', () => {
  assert.equal(toCsv([['a,b', 'he said "x"', '=HYPERLINK("x")', 'plain']]), '"a,b","he said ""x""","\'=HYPERLINK(""x"")",plain\r\n');
});

test('map: header detection by name, column order and skipped rows', () => {
  const { entries, problems } = parseRedirectMap('Redirect To,Redirect From\n/new,/old\n,\nnot a url,/x\n');
  assert.deepEqual(entries, [{ old: '/old', new: '/new', line: 2 }]);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /Row 4/);
});

test('map: no header, absolute URLs, semicolons', () => {
  const { entries } = parseRedirectMap('https://old.example/a;https://new.example/b\n/c;/d');
  assert.deepEqual(
    entries.map((e) => [e.old, e.new]),
    [
      ['https://old.example/a', 'https://new.example/b'],
      ['/c', '/d'],
    ],
  );
});

test('URL list: comments, blanks and extra columns', () => {
  assert.deepEqual(parseUrlList('# old URLs\nhttps://a.example/x\n\n  /y  \nhttps://a.example/z\t200\n/quoted,comma\n'), [
    'https://a.example/x',
    '/y',
    'https://a.example/z',
    '/quoted,comma', // commas are valid in URLs; only whitespace separates columns
  ]);
});

test('sitemap: urlset, index, CDATA, entities and namespaces', () => {
  const urlset = parseSitemap('<urlset><url><loc>https://a.example/?a=1&amp;b=2</loc></url><url><loc><![CDATA[https://a.example/c]]></loc></url></urlset>');
  assert.deepEqual(urlset, { type: 'urlset', locs: ['https://a.example/?a=1&b=2', 'https://a.example/c'], malformed: 0 });
  const index = parseSitemap('<sm:sitemapindex xmlns:sm="x"><sm:sitemap><sm:loc>https://a.example/s1.xml</sm:loc></sm:sitemap></sm:sitemapindex>');
  assert.deepEqual(index, { type: 'index', locs: ['https://a.example/s1.xml'], malformed: 0 });
});

test('sitemap: local index pointing at a gzipped child', async () => {
  const dir = await tempDir('rmc-');
  const child = join(dir, 'pages.xml.gz');
  await writeFile(child, gzipSync('<urlset><url><loc>https://a.example/one</loc></url><url><loc>https://a.example/two</loc></url></urlset>'));
  const index = join(dir, 'sitemap.xml');
  await writeFile(index, `<sitemapindex><sitemap><loc>${child}</loc></sitemap></sitemapindex>`);
  assert.deepEqual(await loadSitemapUrls(index), ['https://a.example/one', 'https://a.example/two']);
});

test('robots: specific agent beats *, longest rule wins, Allow wins ties', () => {
  const text = [
    'User-agent: *',
    'Disallow: /',
    '',
    'User-agent: redirect-map-check',
    'Disallow: /private',
    'Allow: /private/public',
    'Disallow: /*.pdf$',
    'Crawl-delay: 2',
  ].join('\n');
  const group = selectGroup(parseRobots(text), 'redirect-map-check');
  assert.equal(group.crawlDelay, 2);
  assert.equal(isAllowed(group, '/about'), true);
  assert.equal(isAllowed(group, '/private/x'), false);
  assert.equal(isAllowed(group, '/private/public/x'), true);
  assert.equal(isAllowed(group, '/files/a.pdf'), false);
  assert.equal(isAllowed(group, '/files/a.pdf?x=1'), true);
  assert.equal(robotsAllows(text, 'someotherbot', '/about'), false);
});

test('robots: grouped agents, empty Disallow, comments, robots.txt always allowed', () => {
  const text = 'User-agent: a\nUser-agent: *\nDisallow: # nothing\n\nUser-agent: b\nDisallow: /';
  assert.equal(robotsAllows(text, 'redirect-map-check', '/anything'), true);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /', 'x', '/robots.txt'), true);
  assert.equal(robotsAllows('', 'x', '/'), true);
});
