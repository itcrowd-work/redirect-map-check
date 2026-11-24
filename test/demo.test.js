// End-to-end against the Harbor & Pine demo sites: every planted mistake must
// be found, and the correct redirects must come out clean.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { tempDir } from './helpers/tmp.js';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCheck } from '../src/check.js';
import { startDemo } from '../demo/server.js';

const MAP = fileURLToPath(new URL('../demo/redirect-map.csv', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/redirect-map-check.js', import.meta.url));
const FAST = { delayMs: 0, retryBaseMs: 10, userAgent: 'redirect-map-check-test' };

let demo;
before(async () => {
  demo = await startDemo();
});
after(() => demo.close());

const byPath = (run) => Object.fromEntries(run.results.map((r) => [r.key, r.issues.map((i) => i.type).sort()]));

const EXPECTED_STAGING = {
  '/': ['map-self-target'],
  '/about-us': ['map-conflict'],
  '/contact-us': [],
  '/products/oak-dining-table': [],
  '/products/walnut-desk': ['not-found'],
  '/products/linen-sofa': ['temporary-redirect'],
  '/products/rattan-chair': ['lands-on-homepage', 'wrong-target'],
  '/products/teak-bench': ['server-error'],
  '/products/pine-bookshelf': ['content-mismatch'],
  '/blog/caring-for-solid-wood': ['redirect-chain'],
  '/blog/spring-collection': ['redirect-loop'],
  '/delivery-information': ['content-mismatch', 'wrong-target'],
  '/showroom': ['temporary-redirect'],
  '/gift-cards': ['missing-from-map', 'not-found'],
  '/faq': ['unchanged-not-in-map'],
  '/careers': ['not-redirected'],
  '/cart': ['map-self-target', 'unchecked'],
  '/old-promo-2023': [],
  '/summer-sale-2022': ['map-chain', 'redirect-chain'],
};

test('staging check (--base) finds every planted problem and nothing else', async () => {
  const run = await runCheck({ ...FAST, sitemaps: [`${demo.oldOrigin}/sitemap.xml`], map: MAP, base: demo.newOrigin });
  assert.deepEqual(byPath(run), EXPECTED_STAGING);
  assert.equal(run.mapRowIssues.length, 1);
  assert.equal(run.summary.urlsChecked, 19);
  assert.equal(Object.keys(run.oldPages).length, 17);
  // The loop is reported once, not also as a chain.
  assert.equal(run.summary.byType['redirect-chain'], 2);
});

test('every problem gets a specific recommended fix', async () => {
  const run = await runCheck({
    ...FAST,
    sitemaps: [`${demo.oldOrigin}/sitemap.xml`],
    map: MAP,
    base: demo.newOrigin,
    newSitemaps: [`${demo.newOrigin}/sitemap.xml`],
  });
  const fix = (key, type) => run.results.find((r) => r.key === key).issues.find((i) => i.type === type).fix;
  for (const r of run.results) for (const i of r.issues) assert.ok(i.fix, `${r.key} ${i.type} has no fix`);
  assert.ok(run.mapRowIssues.every(({ issue }) => issue.fix));

  assert.match(fix('/products/walnut-desk', 'not-found'), /Publish \/shop\/office\/walnut-desk/);
  assert.match(fix('/products/rattan-chair', 'wrong-target'), /301 straight to \/shop\/living\/rattan-armchair, which is live/);
  assert.match(fix('/products/pine-bookshelf', 'content-mismatch'), /row 10 .* closer match .* \/shop\/storage\/pine-bookshelf/);
  assert.match(fix('/blog/spring-collection', 'redirect-loop'), /^\/journal\/spring-collection sends visitors back/);
  assert.match(fix('/blog/caring-for-solid-wood', 'redirect-chain'), /only adds a trailing slash/);
  assert.match(fix('/gift-cards', 'missing-from-map'), /\/shop\/gift-vouchers/);
  assert.match(fix('/about-us', 'map-conflict'), /currently follows row 3/);
  assert.match(fix('/summer-sale-2022', 'map-chain'), /row 18 .* straight at \/shop/);
  assert.match(fix('/products/linen-sofa', 'temporary-redirect'), /302 at \/products\/linen-sofa to a 301/);

  // Without the new sitemap we only suggest pages we actually visited.
  const plain = await runCheck({ ...FAST, sitemaps: [`${demo.oldOrigin}/sitemap.xml`], map: MAP, base: demo.newOrigin });
  const giftFix = plain.results.find((r) => r.key === '/gift-cards').issues.find((i) => i.type === 'missing-from-map').fix;
  assert.doesNotMatch(giftFix, /gift-vouchers/);
});

test('suggestions: top three, strong or possible, title and slug signals', async () => {
  const base = { ...FAST, sitemaps: [`${demo.oldOrigin}/sitemap.xml`], map: MAP, base: demo.newOrigin, newSitemaps: [`${demo.newOrigin}/sitemap.xml`] };
  const issue = (run, key, type) => run.results.find((r) => r.key === key).issues.find((i) => i.type === type);

  const run = await runCheck(base);
  const gift = issue(run, '/gift-cards', 'missing-from-map').suggestions;
  assert.deepEqual(
    gift.map((s) => [new URL(s.url).pathname, s.confidence, s.score]),
    [
      ['/shop/gift-vouchers', 'strong', 0.8],
      ['/shop/gift-wrapping', 'possible', 0.5],
    ],
  );
  assert.deepEqual(gift[0].signals, { title: 1, slug: 0.5 });
  assert.match(issue(run, '/gift-cards', 'missing-from-map').fix, /gift-vouchers .*a strong match/);
  // Fix types that don't use suggestions don't carry them.
  assert.equal(issue(run, '/products/rattan-chair', 'wrong-target').suggestions, undefined);

  // A higher bar drops the weaker candidates.
  const strict = await runCheck({ ...base, minSuggestion: 0.9 });
  assert.equal(issue(strict, '/gift-cards', 'missing-from-map').suggestions, undefined);
  assert.equal(issue(strict, '/products/pine-bookshelf', 'content-mismatch').suggestions[0].score, 1);

  // After launch with no old titles, the slug alone still finds candidates, labelled possible.
  const dir = await tempDir('rmc-');
  const list = join(dir, 'old.txt');
  await writeFile(list, `${demo.newOrigin}/gift-cards\n`);
  const newList = join(dir, 'new.txt');
  await writeFile(newList, '/shop/gift-vouchers\n/shop/gift-wrapping\n/about\n');
  const slugOnly = await runCheck({ ...FAST, urlLists: [list], newUrlLists: [newList] });
  const s = issue(slugOnly, '/gift-cards', 'missing-from-map');
  assert.deepEqual(
    s.suggestions.map((c) => [new URL(c.url).pathname, c.confidence, c.signals.title]),
    [
      ['/shop/gift-vouchers', 'possible', null],
      ['/shop/gift-wrapping', 'possible', null],
    ],
  );
  assert.match(s.fix, /A possible match is \/shop\/gift-vouchers .*check it before you use it/);
});

test('--ignore-robots checks the blocked URL', async () => {
  const run = await runCheck({ ...FAST, sitemaps: [`${demo.oldOrigin}/sitemap.xml`], map: MAP, base: demo.newOrigin, respectRobots: false });
  assert.deepEqual(byPath(run)['/cart'], ['map-self-target']);
});

test('after launch: --old-site reads old titles, --snapshot reuses them', async () => {
  // Simulate launch: the new site now answers on the real domain, the old site survives elsewhere.
  const base = { ...FAST, map: MAP, oldBase: demo.newOrigin };
  const live = await runCheck({ ...base, oldSite: demo.oldOrigin });
  assert.deepEqual(byPath(live)['/products/pine-bookshelf'], ['content-mismatch']);
  assert.deepEqual(byPath(live)['/products/oak-dining-table'], []);

  const dir = await tempDir('rmc-');
  const snapshot = join(dir, 'old-pages.json');
  await writeFile(snapshot, JSON.stringify({ version: 1, pages: live.oldPages }));
  const reused = await runCheck({ ...base, snapshot });
  assert.deepEqual(byPath(reused)['/products/pine-bookshelf'], ['content-mismatch']);

  const blind = await runCheck({ ...base });
  assert.deepEqual(byPath(blind)['/products/pine-bookshelf'], []);
  assert.ok(blind.notes.some((n) => n.includes('Title/H1 comparison skipped')));
});

test('absolute production URLs in the map are rewritten onto --base', async () => {
  const dir = await tempDir('rmc-');
  const map = join(dir, 'map.csv');
  await writeFile(map, 'https://www.harbor-pine.example/about-us,https://www.harbor-pine.example/about\n');
  const run = await runCheck({ ...FAST, map, base: demo.newOrigin, content: false });
  assert.equal(run.results[0].requestUrl, `${demo.newOrigin}/about-us`);
  assert.equal(run.results[0].expectedUrl, `${demo.newOrigin}/about`);
  assert.deepEqual(run.results[0].issues, []);
});

test('politeness: User-Agent, concurrency limit, per-host delay and Crawl-delay', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const starts = [];
  const agents = new Set();
  const server = createServer((req, res) => {
    agents.add(req.headers['user-agent']);
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('User-agent: *\nCrawl-delay: 0.15\n');
    }
    starts.push(Date.now());
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    setTimeout(() => {
      inFlight -= 1;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>x</title>');
    }, 20);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dir = await tempDir('rmc-');
  const list = join(dir, 'urls.txt');
  await writeFile(list, Array.from({ length: 6 }, (_, i) => `${origin}/p${i}`).join('\n'));

  await runCheck({ urlLists: [list], concurrency: 2, delayMs: 50, userAgent: 'redirect-map-check/test (+https://itcrowd.work)', content: false });
  server.close();

  assert.deepEqual([...agents], ['redirect-map-check/test (+https://itcrowd.work)']);
  assert.ok(maxInFlight <= 2);
  for (let i = 1; i < starts.length; i += 1) assert.ok(starts[i] - starts[i - 1] >= 140, `gap ${starts[i] - starts[i - 1]}ms`);
});

test('CLI: exit code 1 on errors, writes CSV, HTML and JSON, escapes HTML', async () => {
  const dir = await tempDir('rmc-');
  const out = join(dir, 'report');
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, '--sitemap', `${demo.oldOrigin}/sitemap.xml`, '--map', MAP, '--base', demo.newOrigin, '--delay', '0', '--out', out, '--no-color'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('exit', (c) => resolve({ c, stdout }));
  });
  assert.equal(code.c, 1);
  assert.match(code.stdout, /19 URLs checked/);
  assert.match(code.stdout, /9 with errors/);
  assert.match(code.stdout, /1 URL could not be checked at all/);

  const csv = await readFile(join(out, 'report.csv'), 'utf8');
  assert.match(csv, /^severity,issue,title,old_url.*,detail,recommended_fix,suggested_pages\r\n/);
  assert.equal(csv.trim().split("\r\n").length, 1 + 22);
  const html = await readFile(join(out, 'report.html'), 'utf8');
  assert.match(html, /Harbor &amp; Pine/);
  assert.match(html, /Recommended fix/);
  assert.doesNotMatch(html, /Harbor & Pine/);
  assert.doesNotMatch(html, /<script/i);
  const json = JSON.parse(await readFile(join(out, 'results.json'), 'utf8'));
  assert.equal(json.results.length, 19);
  await readFile(join(out, 'old-pages.json'), 'utf8');
});

test('CLI: --fail-on never exits 0; bad flags exit 2', async () => {
  const run = (args) =>
    new Promise((resolve) => spawn(process.execPath, [BIN, ...args], { stdio: 'ignore' }).on('exit', resolve));
  const dir = await tempDir('rmc-');
  assert.equal(await run(['--map', MAP, '--base', demo.newOrigin, '--delay', '0', '--out', dir, '--fail-on', 'never']), 0);
  assert.equal(await run(['--map', MAP, '--fail-on', 'sometimes']), 2);
  assert.equal(await run(['--bogus']), 2);
  assert.equal(await run(['--map', MAP, '--min-suggestion', '0']), 2);
  assert.equal(await run([]), 2);
});
