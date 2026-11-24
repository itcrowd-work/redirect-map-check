// The single page of the local interface. Server-rendered shell + one inline script
// (allowed by a per-request CSP nonce). No data from a check is ever put into this HTML:
// results arrive as JSON and are added to the page with textContent.

import { readFileSync } from 'node:fs';
import { BRAIN, baseCss } from '../report/style.js';

let clientJs = null;
const client = () => (clientJs ??= readFileSync(new URL('./client.js', import.meta.url), 'utf8'));

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const UI_CSS = `
.ui_form { display: grid; gap: 1.75rem; }
.ui_step { display: grid; gap: 0.75rem; padding-top: 1.25rem; border-top: 1px solid var(--color-line); }
.ui_step:first-child { padding-top: 0; border-top: 0; }
.ui_step-head { display: flex; align-items: baseline; gap: 0.75rem; }
.ui_step-num { font-family: var(--font-mono); font-size: var(--text-size-tiny); color: var(--color-grey-dim); }
.ui_step-title { font-weight: 600; }
.ui_hint { font-size: var(--text-size-small); color: var(--color-grey); }
.ui_label { display: block; font-family: var(--font-mono); font-weight: 500; font-size: var(--text-size-tiny); letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-grey); margin-bottom: 0.25rem; }
.ui_input, .ui_textarea, .ui_select { width: 100%; font: inherit; font-size: var(--text-size-regular); color: var(--color-ink); background: transparent; border: 0; border-bottom: 1px solid var(--color-line); border-radius: 0; padding: 0.5rem 0; }
.ui_textarea { min-height: 3.5rem; resize: vertical; font-family: var(--font-mono); font-size: var(--text-size-small); }
.ui_input:focus, .ui_textarea:focus, .ui_select:focus { outline: none; border-bottom-color: var(--color-ink); }
.ui_input::placeholder, .ui_textarea::placeholder { color: var(--color-grey-dim); }
.ui_drop { position: relative; display: flex; align-items: center; gap: 0.75rem; padding: 1rem 1.25rem; border: 1px dashed var(--color-line); border-radius: var(--radius-large); background: var(--color-surface); cursor: pointer; }
.ui_drop:hover, .ui_drop.is-over, .ui_drop:focus-within { border-color: var(--color-ink); }
.ui_drop input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.ui_drop-mark { font-family: var(--font-mono); font-weight: 500; color: var(--color-ink); }
.ui_drop-text { font-size: var(--text-size-small); color: var(--color-grey); overflow-wrap: anywhere; }
.ui_drop.has-file .ui_drop-text { color: var(--color-ink); }
.ui_check { display: flex; align-items: flex-start; gap: 0.625rem; font-size: var(--text-size-small); color: var(--color-grey); }
.ui_check input { margin-top: 0.3rem; accent-color: var(--color-ink); }
.ui_grid { display: grid; gap: 1rem 1.5rem; }
@media (min-width: 40rem) { .ui_grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.ui_advanced summary { cursor: pointer; font-family: var(--font-mono); font-size: var(--text-size-tiny); letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-grey); list-style: none; }
.ui_advanced summary::-webkit-details-marker { display: none; }
.ui_advanced summary::before { content: "+ "; }
.ui_advanced[open] summary::before { content: "− "; }
.ui_advanced-body { display: grid; gap: 1rem; margin-top: 1rem; }
.button { display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem; height: 3rem; padding: 0 1.25rem; border-radius: var(--radius-small); background: var(--color-ink); color: var(--color-paper); border: 1px solid var(--color-ink); font: inherit; font-weight: 500; font-size: var(--text-size-small); cursor: pointer; white-space: nowrap; }
.button:hover { opacity: 0.88; }
.button[disabled] { opacity: 0.5; cursor: not-allowed; }
.button.is-secondary { background: transparent; color: var(--color-ink); border-color: var(--color-line); }
.button.is-secondary:hover { border-color: var(--color-ink); opacity: 1; }
.button.is-small { height: 2.25rem; padding: 0 0.875rem; }
.button-group { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; }
.ui_error { color: var(--color-error); font-size: var(--text-size-small); }
.ui_card { border: 1px solid var(--color-line); border-radius: var(--radius-large); background: var(--color-surface); padding: 1.5rem; }
@media (min-width: 40rem) { .ui_card { padding: 1.75rem 2rem; } }
.ui_progress { height: 6px; border-radius: 3px; background: var(--color-paper-2); overflow: hidden; margin-top: 1rem; }
.ui_progress-bar { height: 100%; width: 0; background: var(--color-ink); transition: width 200ms ease; }
.ui_progress.is-indeterminate .ui_progress-bar { width: 30%; animation: rmc-slide 1.2s ease-in-out infinite; }
@keyframes rmc-slide { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
@media (prefers-reduced-motion: reduce) { .ui_progress.is-indeterminate .ui_progress-bar { animation: none; width: 100%; opacity: 0.3; } }
.ui_live { margin-top: 1.25rem; max-height: 18rem; overflow: auto; font-family: var(--font-mono); font-size: var(--text-size-tiny); }
.ui_live-row { display: grid; grid-template-columns: 7.5rem minmax(0, 1fr); gap: 0.75rem; padding: 0.3rem 0; border-bottom: 1px solid var(--color-line); }
.ui_live-row span:last-child { overflow-wrap: anywhere; color: var(--color-grey); }
.ui_toolbar { display: grid; gap: 1rem; margin-bottom: 1.5rem; }
@media (min-width: 64rem) { .ui_toolbar { grid-template-columns: auto minmax(0, 1fr) 14rem auto; align-items: end; } }
.ui_chips { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.ui_chip { font: inherit; font-family: var(--font-mono); font-size: var(--text-size-tiny); letter-spacing: 0.06em; text-transform: uppercase; padding: 0.45rem 0.75rem; border: 1px solid var(--color-line); border-radius: 999px; background: transparent; color: var(--color-grey); cursor: pointer; }
.ui_chip[aria-pressed="true"] { background: var(--color-ink); border-color: var(--color-ink); color: var(--color-paper); }
.item_card.is-done { opacity: 0.55; }
.item_head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
.item_type { font-size: var(--text-size-small); color: var(--color-grey); margin-top: 0.25rem; }
.ui_done { flex-shrink: 0; }
.ui_more { margin-top: 1rem; }
.ui_saved { font-size: var(--text-size-small); color: var(--color-grey); overflow-wrap: anywhere; }
[hidden] { display: none !important; }
`;

export function renderPage({ nonce, version = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>redirect-map-check</title>
<style>
${baseCss()}
${UI_CSS}
</style>
</head>
<body>
<header class="nav_component">
  <div class="padding-global"><div class="container-large is-framed"><div class="nav_inner">
    <a class="nav_logo" href="https://itcrowd.work" target="_blank" rel="noopener noreferrer" aria-label="ITCrowd">${BRAIN}<span>IT_Crowd<span class="logo_caret" aria-hidden="true"></span></span></a>
    <p class="nav_meta text-style-mono"><span>redirect-map-check</span>${version ? `<span>v${esc(version)}</span>` : ''}<span>Local</span></p>
  </div></div></div>
</header>
<main>
  <noscript><p class="padding-global">This page needs JavaScript. The command line works without it: run redirect-map-check --help.</p></noscript>
  <section id="no-token" hidden>
    <div class="padding-global"><div class="container-large is-framed"><div class="section_inner">
      <p class="text-style-eyebrow">Access</p>
      <h1 class="heading-style-h2 split_title">Open the address from the terminal</h1>
      <p class="split_lead">This page only works with the private address that <code>redirect-map-check ui</code> printed when it started (it ends in <code>?t=</code> and a long code). Copy it from the terminal into this tab.</p>
    </div></div></div>
  </section>

  <section id="form-section">
    <div class="padding-global"><div class="container-large is-framed"><div class="section_inner split_layout">
      <div class="split_text">
        <p class="text-style-eyebrow">Redirect check</p>
        <h1 class="heading-style-h2 split_title">Check a migration's redirects</h1>
        <p class="split_lead">Give us the old site's URLs and your redirect map. We follow every old URL, hop by hop, and tell you what's broken and how to fix it.</p>
        <p class="split_lead">Everything runs on this computer. Nothing is uploaded anywhere: the files you pick only travel from this page to the tool running in your terminal.</p>
      </div>
      <form id="rmc-form" class="ui_card ui_form" novalidate>
        <div class="ui_step">
          <div class="ui_step-head"><span class="ui_step-num">01</span><span class="ui_step-title">Old URLs</span></div>
          <label class="ui_label" for="f-sitemaps">Old sitemap URL (one per line)</label>
          <textarea id="f-sitemaps" class="ui_textarea" placeholder="https://www.example.com/sitemap.xml" spellcheck="false"></textarea>
          <label class="ui_drop" id="d-old"><span class="ui_drop-mark">[+]</span><span class="ui_drop-text">Or drop a saved sitemap (.xml, .gz) or a list of URLs (.txt)</span><input id="f-oldfiles" type="file" multiple accept=".xml,.gz,.txt,.csv,text/plain,text/xml,application/xml,application/gzip"></label>
          <label class="ui_check" id="c-default-old" hidden><input type="checkbox" id="f-default-old" checked><span id="t-default-old"></span></label>
        </div>

        <div class="ui_step">
          <div class="ui_step-head"><span class="ui_step-num">02</span><span class="ui_step-title">Redirect map</span></div>
          <label class="ui_drop" id="d-map"><span class="ui_drop-mark">[+]</span><span class="ui_drop-text">Drop the map: CSV or TSV with the old URL and the new URL</span><input id="f-map" type="file" accept=".csv,.tsv,.txt,text/csv,text/plain"></label>
          <label class="ui_check" id="c-default-map" hidden><input type="checkbox" id="f-default-map" checked><span id="t-default-map"></span></label>
          <p class="ui_hint">Headers like old/new, from/to or Source URL/Destination URL are found in any order. Commas, semicolons and tabs all work.</p>
          <label class="ui_label" for="f-oldbase">Old site's address, if the map lists only paths like /about</label>
          <input id="f-oldbase" class="ui_input" type="url" placeholder="https://www.example.com" spellcheck="false">
        </div>

        <div class="ui_step">
          <div class="ui_step-head"><span class="ui_step-num">03</span><span class="ui_step-title">Where to test</span></div>
          <label class="ui_label" for="f-base">Staging URL (leave empty after launch)</label>
          <input id="f-base" class="ui_input" type="url" placeholder="https://staging.example.com" spellcheck="false">
          <label class="ui_label" for="f-newsitemaps">New site's sitemap, for better fix suggestions (optional, one per line)</label>
          <textarea id="f-newsitemaps" class="ui_textarea" placeholder="https://staging.example.com/sitemap.xml" spellcheck="false"></textarea>
          <label class="ui_check" id="c-default-new" hidden><input type="checkbox" id="f-default-new" checked><span id="t-default-new"></span></label>
          <label class="ui_check"><input type="checkbox" id="f-ignore-robots"><span>Ignore robots.txt. Only for sites you own (staging usually blocks crawlers).</span></label>
        </div>

        <details class="ui_advanced" id="advanced">
          <summary>More options</summary>
          <div class="ui_advanced-body">
            <div>
              <label class="ui_label" for="f-oldsite">Old site still online elsewhere (after launch)</label>
              <input id="f-oldsite" class="ui_input" type="url" placeholder="https://old-site.webflow.io" spellcheck="false">
            </div>
            <label class="ui_drop" id="d-snapshot"><span class="ui_drop-mark">[+]</span><span class="ui_drop-text">Or drop old-pages.json from a run before launch</span><input id="f-snapshot" type="file" accept=".json,application/json"></label>
            <label class="ui_check" id="c-default-snapshot" hidden><input type="checkbox" id="f-default-snapshot" checked><span id="t-default-snapshot"></span></label>
            <div>
              <label class="ui_label" for="f-newhosts">Hosts that belong to the new site (comma separated)</label>
              <input id="f-newhosts" class="ui_input" type="text" placeholder="shop.example.com" spellcheck="false">
            </div>
            <div class="ui_grid">
              <div><label class="ui_label" for="f-delay">Delay between requests (ms)</label><input id="f-delay" class="ui_input" type="number" min="0" max="60000" placeholder="250"></div>
              <div><label class="ui_label" for="f-concurrency">Requests at once</label><input id="f-concurrency" class="ui_input" type="number" min="1" max="16" placeholder="4"></div>
              <div><label class="ui_label" for="f-timeout">Timeout (ms)</label><input id="f-timeout" class="ui_input" type="number" min="1000" max="120000" placeholder="15000"></div>
              <div><label class="ui_label" for="f-retries">Retries</label><input id="f-retries" class="ui_input" type="number" min="0" max="5" placeholder="1"></div>
              <div><label class="ui_label" for="f-maxhops">Max redirects per URL</label><input id="f-maxhops" class="ui_input" type="number" min="1" max="30" placeholder="10"></div>
              <div><label class="ui_label" for="f-minsimilarity">Lowest title match (0–1)</label><input id="f-minsimilarity" class="ui_input" type="number" min="0" max="1" step="0.05" placeholder="0.25"></div>
              <div><label class="ui_label" for="f-limit">Check only the first N URLs</label><input id="f-limit" class="ui_input" type="number" min="1" placeholder="All"></div>
              <div><label class="ui_label" for="f-minsuggestion">Lowest suggestion score (0–1)</label><input id="f-minsuggestion" class="ui_input" type="number" min="0.01" max="1" step="0.05" placeholder="0.5"></div>
            </div>
            <label class="ui_check"><input type="checkbox" id="f-nocontent"><span>Skip the title/H1 comparison</span></label>
            <label class="ui_check"><input type="checkbox" id="f-partial"><span>If a child sitemap fails, check the rest and report it as an error</span></label>
            <label class="ui_check"><input type="checkbox" id="f-private"><span>Allow redirects into private network addresses</span></label>
          </div>
        </details>

        <p class="ui_error" id="form-error" role="alert" hidden></p>
        <div class="button-group"><button class="button" id="run" type="submit">Run the check</button><span class="ui_hint" id="run-hint"></span></div>
      </form>
    </div></div></div>
  </section>

  <section class="rule-top" id="progress" hidden>
    <div class="padding-global"><div class="container-large is-framed"><div class="section_inner">
      <p class="text-style-eyebrow">Progress</p>
      <div class="item_head">
        <h2 class="heading-style-h2 split_title" id="phase" aria-live="polite">Starting…</h2>
        <button class="button is-secondary is-small" id="cancel" type="button">Cancel</button>
      </div>
      <p class="hero_meta text-style-mono" id="progress-count"></p>
      <div class="ui_progress is-indeterminate" id="bar-wrap"><div class="ui_progress-bar" id="bar"></div></div>
      <div class="ui_live" id="live" aria-label="URLs as they are checked"></div>
    </div></div></div>
  </section>

  <section class="rule-top" id="results" hidden>
    <div class="padding-global"><div class="container-large is-framed"><div class="section_inner">
      <p class="text-style-eyebrow">Results</p>
      <h2 class="heading-style-h1 hero_title" id="headline"></h2>
      <p class="hero_meta text-style-mono" id="results-meta"></p>
      <div class="button-group" style="margin-top:1.5rem">
        <button class="button" id="dl-html" type="button" data-file="report.html">Open full report</button>
        <button class="button is-secondary" type="button" data-file="report.csv">report.csv</button>
        <button class="button is-secondary" type="button" data-file="results.json">results.json</button>
        <button class="button is-secondary" id="dl-old" type="button" data-file="old-pages.json" hidden>old-pages.json</button>
        <button class="button is-secondary" id="save" type="button">Save to folder</button>
        <span class="ui_saved" id="saved" aria-live="polite"></span>
      </div>
    </div></div></div>
  </section>

  <section class="rule-top" id="stats-section" hidden>
    <div class="padding-global"><div class="container-large is-framed"><div class="stats_grid" id="stats"></div></div></div>
  </section>

  <section class="rule-top" id="list-section" hidden>
    <div class="padding-global"><div class="container-large is-framed"><div class="section_inner">
      <div class="ui_toolbar">
        <div class="ui_chips" id="chips" role="group" aria-label="Filter by severity"></div>
        <div><label class="ui_label" for="search">Search URLs and fixes</label><input id="search" class="ui_input" type="search" placeholder="/products/" spellcheck="false"></div>
        <div><label class="ui_label" for="type">Problem type</label><select id="type" class="ui_select"></select></div>
        <label class="ui_check"><input type="checkbox" id="hide-done"><span>Hide done</span></label>
      </div>
      <p class="ui_hint" id="shown"></p>
      <ul class="item_list" id="list"></ul>
      <div class="ui_more"><button class="button is-secondary" id="more" type="button" hidden>Show more</button></div>
      <div id="notes-wrap" hidden><p class="text-style-eyebrow" style="margin-top:3rem">Notes</p><ul class="note_list" id="notes" style="margin-top:1rem"></ul></div>
    </div></div></div>
  </section>
</main>
<footer class="rule-top">
  <div class="padding-global"><div class="container-large is-framed"><div>
    <div class="footer_bottom"><span>redirect-map-check${version ? ` v${esc(version)}` : ''}, a free tool by ITCrowd. Running locally; close it with Ctrl+C in the terminal.</span><span>itcrowd.work</span></div>
  </div></div></div>
</footer>
<script nonce="${esc(nonce)}">
${client()}
</script>
</body>
</html>
`;
}
