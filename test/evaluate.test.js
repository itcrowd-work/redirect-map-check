import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createScorer, extractPageInfo, matchScore, similarity, slugSimilarity, slugTokens, tokenize } from '../src/content.js';
import { evaluate } from '../src/check.js';
import { fixContext, recommendFix } from '../src/fixes.js';
import { isRootLike, pathKey, rebase, sameUrl } from '../src/url.js';

const O = 'https://www.example.com';

function result({ old = '/a', expected = '/b', hops, final = '/b', status = 200, extra = {} } = {}) {
  return {
    oldUrl: O + old,
    requestUrl: O + old,
    expectedUrl: expected === null ? null : O + expected,
    mapTarget: expected,
    mapLine: 2,
    inSitemap: true,
    inList: false,
    mapIssues: [],
    oldPage: null,
    chain: {
      hops: hops ?? [
        { url: O + old, status: 301 },
        { url: O + final, status },
      ],
      finalUrl: final === null ? null : O + final,
      finalStatus: final === null ? null : status,
      page: null,
      loop: false,
      tooMany: false,
      error: null,
      blocked: null,
      noLocation: false,
    },
    ...extra,
  };
}

const types = (r, opts = {}) => evaluate(r, { minSimilarity: 0.25, scorer: null, ...opts }).map((i) => i.type).sort();

test('a clean 301 has no issues', () => {
  assert.deepEqual(types(result()), []);
});

test('trailing-slash-only difference still counts as the right target', () => {
  assert.deepEqual(types(result({ expected: '/b', final: '/b/' })), []);
});

test('404 target, wrong target, homepage', () => {
  assert.deepEqual(types(result({ status: 404 })), ['not-found']);
  assert.deepEqual(types(result({ final: '/c' })), ['wrong-target']);
  assert.deepEqual(types(result({ final: '/' })), ['lands-on-homepage', 'wrong-target']);
  assert.deepEqual(types(result({ expected: '/', final: '/' })), ['mapped-to-homepage']);
  assert.deepEqual(types(result({ old: '/', expected: '/', final: '/' })), []);
});

test('temporary redirects and chains', () => {
  const hops = [
    { url: `${O}/a`, status: 302 },
    { url: `${O}/a/`, status: 307 },
    { url: `${O}/b`, status: 200 },
  ];
  assert.deepEqual(types(result({ hops })), ['redirect-chain', 'temporary-redirect']);
});

test('not redirected, unless the server errored', () => {
  const stay = (status) => result({ final: '/a', status, hops: [{ url: `${O}/a`, status }] });
  assert.deepEqual(types(stay(200)), ['not-redirected']);
  assert.deepEqual(types(stay(404)), ['not-redirected']); // one problem, reported once
  assert.deepEqual(types(stay(503)), ['server-error']);
});

test('URLs that are not in the map', () => {
  const unchanged = result({ expected: null, final: '/a', hops: [{ url: `${O}/a`, status: 200 }] });
  assert.deepEqual(types(unchanged), ['unchanged-not-in-map']);
  assert.deepEqual(types(result({ expected: null, final: '/' })), ['lands-on-homepage', 'missing-from-map']);
});

test('loops and blocked URLs', () => {
  const loop = result({ final: null });
  loop.chain.loop = true;
  loop.chain.hops = [
    { url: `${O}/a`, status: 301 },
    { url: `${O}/x`, status: 301 },
    { url: `${O}/a`, status: null, loopsBack: true },
  ];
  assert.deepEqual(types(loop), ['redirect-loop']);
  const blocked = result({ final: null, hops: [] });
  blocked.chain.blocked = { url: `${O}/a`, reason: 'Disallowed', kind: 'disallowed', hop: 0, siteHost: true };
  assert.deepEqual(types(blocked), ['unchecked']);
});

test('content mismatch uses title and H1, ignoring site-wide words', () => {
  const r = result();
  const pages = [
    { title: 'Pine Bookshelf | Acme', h1: 'Pine bookshelf' },
    { title: 'Oak Table – Acme', h1: 'Oak table' },
    { title: 'Linen Sofa | Acme', h1: 'Linen sofa' },
    { title: 'Walnut Desk | Acme', h1: 'Walnut desk' },
  ];
  const scorer = createScorer(pages, pages);
  r.oldPage = pages[0];
  r.chain.page = pages[1];
  assert.deepEqual(types(r, { scorer }), ['content-mismatch']);
  r.chain.page = { title: 'Pine Bookshelves – Acme', h1: 'Bookshelf in solid pine' };
  assert.deepEqual(types(r, { scorer }), []);
});

test('scorer drops words that appear on most pages', () => {
  const pages = ['Desk', 'Chair', 'Sofa', 'Lamp'].map((p) => ({ title: `${p} | Harbor & Pine`, h1: p }));
  const score = createScorer(pages, pages);
  assert.equal(score({ title: 'Desk | Harbor & Pine' }, { title: 'Lamp | Harbor & Pine' }), 0);
  assert.equal(similarity({ title: 'Desk | Harbor & Pine' }, { title: 'Lamp | Harbor & Pine' }) > 0, true);
});

test('tokenizer folds diacritics and plurals (Romanian works too)', () => {
  assert.deepEqual(tokenize('Ferestre și Uși PVC'), ['ferestre', 'usi', 'pvc']);
  assert.deepEqual(tokenize('Tables & Chairs, Benches, Accessories'), ['table', 'chair', 'bench', 'accessory']);
});

test('extractPageInfo ignores scripts and decodes entities', () => {
  const info = extractPageInfo('<title> A &amp; B </title><script>"<h1>no</h1>"</script><h1 class="x">Hello <em>there</em></h1>');
  assert.deepEqual(info, { title: 'A & B', h1: 'Hello there' });
});

test('URL helpers', () => {
  assert.equal(pathKey('https://a.example/x/?q=1'), '/x?q=1');
  assert.equal(pathKey('/caf%C3%A9/'), pathKey('/café'));
  assert.equal(sameUrl('https://A.example:443/x/', 'https://a.example/x#top'), true);
  assert.equal(sameUrl('https://a.example/x', 'http://a.example/x'), false);
  assert.equal(rebase('https://www.example.com/a?b=1', 'https://staging.example.com/preview/'), 'https://staging.example.com/preview/a?b=1');
  assert.equal(isRootLike('https://a.example/en/'), true);
  assert.equal(isRootLike('https://a.example/en/shop'), false);
});

test('fixes name the hop that only normalises the URL', () => {
  const fx = fixContext({ localHosts: ['www.example.com', 'example.com'] });
  const chainFix = (from, via) => {
    const r = result({ old: '/a', expected: '/b', final: '/b' });
    r.requestUrl = from;
    r.chain.hops = [
      { url: from, status: 301 },
      { url: via, status: 301 },
      { url: `${O}/b`, status: 200 },
    ];
    return recommendFix({ type: 'redirect-chain' }, r, fx);
  };
  assert.match(chainFix(`${O}/a`, `${O}/a/`), /only adds a trailing slash/);
  assert.match(chainFix('http://www.example.com/a', `${O}/a`), /only switches to https/);
  assert.match(chainFix('https://example.com/a', `${O}/a`), /only adds or removes www/);
  assert.doesNotMatch(chainFix(`${O}/a`, `${O}/x`), /only/);
  // Paths on the sites under test are shortened; other hosts stay full.
  assert.equal(fx.short(`${O}/a?b=1`), '/a?b=1');
  assert.equal(fx.short('https://elsewhere.example/a'), 'https://elsewhere.example/a');
});

test('not-redirected fix says when the target page is missing too', () => {
  const fx = fixContext({ localHosts: ['www.example.com'] });
  const r = result({ final: '/a', hops: [{ url: `${O}/a`, status: 200 }] });
  r.expectedProbe = { status: 404, page: null };
  assert.match(recommendFix({ type: 'not-redirected' }, r, fx), /publish \/b first: it answers 404/);
  r.expectedProbe = { status: 200, page: { title: 'B' } };
  assert.match(recommendFix({ type: 'not-redirected' }, r, fx), /Add a 301 from \/a to \/b \(\/b is live\)/);
});

test('slug words: last segment, extensions, numbers and the parent fallback', () => {
  assert.deepEqual(slugTokens('https://a.example/products/rattan-chair.html'), ['rattan', 'chair']);
  assert.deepEqual(slugTokens('/blog/2024/'), ['blog']);
  assert.deepEqual(slugTokens('/caf%C3%A9-tables'), ['cafe', 'table']);
  assert.deepEqual(slugTokens('/'), []);
  assert.equal(slugSimilarity('/products/rattan-chair', '/shop/living/rattan-armchair'), 0.5);
  assert.equal(slugSimilarity('/', '/x'), null);
});

test('match score: agreement between signals scores highest', () => {
  assert.equal(matchScore(1, 1).score, 1);
  assert.equal(matchScore(1, 0.5).score, 0.8);
  assert.equal(matchScore(0.5, null).score, 0.5);
  assert.equal(matchScore(null, null).score, null);
});
