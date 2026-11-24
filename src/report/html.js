// A single self-contained HTML file in the itcrowd.work style: paper and ink,
// hairline frames, mono labels, Geist + IBM Plex Mono embedded. No scripts and
// no external requests; light or dark follows the reader's system setting.

import { ISSUES, SEVERITIES } from '../issues.js';
import { problemRows, statusChain } from './rows.js';
import { BRAIN, baseCss } from './style.js';

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const MARK = { error: 'ERR', warning: 'WARN', notice: 'NOTE' };
const LABEL = { error: 'Error', warning: 'Warning', notice: 'Notice' };
const PLURAL = { error: 'Errors', warning: 'Warnings', notice: 'Notices' };

const mark = (severity) => `<span class="mark is-${severity}">[${MARK[severity]}]</span>`;

function link(url) {
  if (!url) return '<span class="text-color-grey-dim">–</span>';
  if (!/^https?:\/\//i.test(url)) return esc(url);
  return `<a class="text-style-link" href="${esc(url)}" rel="noopener noreferrer nofollow">${esc(url)}</a>`;
}

/** "301 → 404" with failing statuses in the error colour and temporary redirects marked. */
function chainHtml(chain) {
  if (!chain) return '<span class="text-color-grey-dim">–</span>';
  return chain
    .split(' → ')
    .map((part) => {
      const n = Number(part);
      let cls = 'status';
      if (n >= 400 || part === 'ERR' || part === '↺') cls += ' is-bad';
      else if ([302, 303, 307].includes(n)) cls += ' is-temp';
      else if (part === 'robots') cls += ' is-muted';
      return `<span class="${cls}">${esc(part)}</span>`;
    })
    .join('<span class="status_arrow">→</span>');
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function headline(s) {
  const urls = `${s.urlsChecked} URL${s.urlsChecked === 1 ? '' : 's'}`;
  const unchecked = s.urlsUnchecked ?? 0;
  const broken = s.urlsWithErrors - unchecked;
  const lost = s.sitemapsUnread ? ` ${s.sitemapsUnread} sitemap${s.sitemapsUnread === 1 ? '' : 's'} could not be read, so some URLs were never checked.` : '';
  if (unchecked && broken > 0) return `${broken} of ${urls} need fixing, and ${unchecked} could not be checked.${lost}`;
  if (unchecked) return `${unchecked} of ${urls} could not be checked.${lost}`;
  if (s.urlsWithErrors > 0) return `${s.urlsWithErrors} of ${urls} need fixing.${lost}`;
  if (lost) return lost.trim();
  if (s.urlsWithWarnings > 0) return `No errors in ${urls}. ${s.urlsWithWarnings} with warnings.`;
  return `All ${urls} redirect cleanly.`;
}

export function renderHtml(run, { version = '', toolUrl = 'https://itcrowd.work/tools/redirect-map-check/' } = {}) {
  const { summary: s } = run;
  const rows = problemRows(run);
  const types = Object.keys(ISSUES).filter((t) => s.byType[t]);
  const seconds = (s.durationMs / 1000).toFixed(1);

  const overview = SEVERITIES.map((sev) => {
    const list = types.filter((t) => ISSUES[t].severity === sev);
    if (!list.length) return '';
    return `<div class="index_group">
      <p class="text-style-mono text-color-grey">${PLURAL[sev]}</p>
      <ul class="index_list">${list
        .map(
          (t) =>
            `<li><a class="index_row" href="#${t}">${mark(sev)}<span class="index_title">${esc(ISSUES[t].title)}</span><span class="index_count">${s.byType[t]}</span></a></li>`,
        )
        .join('')}</ul>
    </div>`;
  }).join('');

  const sections = types
    .map((type) => {
      const def = ISSUES[type];
      const typeRows = rows.filter((r) => r.type === type);
      const items = typeRows
        .map((r) => {
          const facts = [];
          if (r.statusChain) facts.push(['Statuses', `<span class="chain">${chainHtml(r.statusChain)}</span>`]);
          if (r.finalUrl) facts.push(['Lands on', link(r.finalUrl)]);
          if (r.expectedUrl && r.expectedUrl !== r.finalUrl) facts.push(['Expected', link(r.expectedUrl)]);
          if (r.detail) facts.push(['Details', esc(r.detail)]);
          if (r.suggestions.length) {
            facts.push([
              'Candidates',
              `<ol class="cand_list">${r.suggestions
                .map(
                  (c) =>
                    `<li>${link(c.url)}${c.title || c.h1 ? ` <span class="text-color-grey">${esc(c.title || c.h1)}</span>` : ''} <span class="cand_score is-${c.confidence}">${c.confidence} ${c.score.toFixed(2)}</span></li>`,
                )
                .join('')}</ol>`,
            ]);
          }
          return `<li class="item_card">
          <p class="item_url">${r.oldUrl ? link(r.oldUrl) : '<span class="text-color-grey">Redirect map</span>'}</p>
          ${r.fix ? `<div class="item_fix"><p class="text-style-mono item_fix-label">Recommended fix</p><p>${esc(r.fix)}</p></div>` : ''}
          <dl class="item_facts">${facts.map(([k, v]) => `<div class="item_fact"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
        </li>`;
        })
        .join('');
      return `<section id="${type}" class="rule-top">
  <div class="padding-global"><div class="container-large is-framed"><div class="section_inner split_layout">
    <div class="split_text">
      <p class="text-style-eyebrow">${LABEL[def.severity]}</p>
      <h2 class="heading-style-h2 split_title">${esc(def.title)}</h2>
      <p class="split_lead">${esc(def.fix)}</p>
      <p class="text-style-mono text-color-grey split_count">${mark(def.severity)} ${typeRows.length} ${typeRows.length === 1 ? 'URL' : 'URLs'}</p>
    </div>
    <ul class="item_list">${items}</ul>
  </div></div></div>
</section>`;
    })
    .join('\n');

  const notes = run.notes.length
    ? `<section class="rule-top">
  <div class="padding-global"><div class="container-large is-framed"><div class="section_inner split_layout">
    <div class="split_text"><p class="text-style-eyebrow">Notes</p><h2 class="heading-style-h2 split_title">About this run</h2></div>
    <ul class="note_list">${run.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
  </div></div></div>
</section>`
    : '';

  const allRows = run.results
    .map((r) => {
      const worst = r.issues[0]?.severity;
      return `<tr><td>${worst ? mark(worst) : '<span class="mark is-ok">[OK]</span>'}</td><td>${link(r.oldUrl)}</td><td><span class="chain">${chainHtml(statusChain(r))}</span></td><td>${link(r.chain.finalUrl)}</td><td class="text-color-grey">${esc(r.issues.map((i) => i.type).join(', ')) || '–'}</td></tr>`;
    })
    .join('');

  const stats = [
    [s.urlsChecked, 'URLs checked'],
    [s.urlsWithErrors, 'With errors'],
    [s.urlsWithWarnings, 'Warnings only'],
    [s.clean, 'Clean'],
  ]
    .map(([n, label]) => `<div class="stats_cell"><p class="stats_number">${n}</p><p class="text-style-mono text-color-grey">${label}</p></div>`)
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">
<meta name="color-scheme" content="light dark">
<title>Redirect report: ${s.urlsWithErrors} with errors, ${s.urlsWithWarnings} with warnings</title>
<style>
${baseCss()}
</style>
</head>
<body>
<header class="nav_component">
  <div class="padding-global"><div class="container-large is-framed"><div class="nav_inner">
    <a class="nav_logo" href="https://itcrowd.work" aria-label="ITCrowd">${BRAIN}<span>IT_Crowd<span class="logo_caret" aria-hidden="true"></span></span></a>
    <p class="nav_meta text-style-mono"><span>redirect-map-check</span>${version ? `<span>v${esc(version)}</span>` : ''}<span><a href="${esc(toolUrl)}">Docs</a></span></p>
  </div></div></div>
</header>
<main>
  <section>
    <div class="padding-global"><div class="container-large is-framed"><div class="section_inner">
      <p class="text-style-eyebrow">Redirect report</p>
      <h1 class="heading-style-h1 hero_title">${esc(headline(s))}</h1>
      <p class="hero_lead">We followed every old URL from the sitemap and the redirect map${s.base ? ` against <b>${esc(s.base)}</b>` : ''}. Errors break the migration, warnings cost search signal, notices are for your information.${s.urlsUnchecked ? ` ${s.urlsUnchecked} URL${s.urlsUnchecked === 1 ? '' : 's'} could not be checked and count as errors, never as clean.` : ''}</p>
      <p class="hero_meta text-style-mono"><span>${fmtDate(s.generatedAt)}</span><span>${s.requests} requests</span><span>${seconds} s</span></p>
    </div></div></div>
  </section>
  <section class="rule-top">
    <div class="padding-global"><div class="container-large is-framed"><div class="stats_grid">${stats}</div></div></div>
  </section>
  <section class="rule-top">
    <div class="padding-global"><div class="container-large is-framed"><div class="section_inner split_layout">
      <div class="split_text">
        <p class="text-style-eyebrow">Overview</p>
        <h2 class="heading-style-h2 split_title">${types.length ? 'Problems by type' : 'No problems found'}</h2>
        <p class="split_lead">${types.length ? 'Each type below has its own section with every URL it affects and a recommended fix for each one. The same problems are in report.csv, one row each, with the fix in the last column.' : 'Every URL redirected in one permanent hop to the page in the map.'}</p>
      </div>
      ${types.length ? `<div class="index_card">${overview}</div>` : ''}
    </div></div></div>
  </section>
${sections}
${notes}
  <section class="rule-top">
    <div class="padding-global"><div class="container-large is-framed"><div class="section_inner">
      <p class="text-style-eyebrow">Appendix</p>
      <h2 class="heading-style-h2 split_title">Every URL checked</h2>
      <details style="margin-top:2rem">
        <summary class="all_toggle"><span class="all_toggle-show">Show all ${run.results.length}</span><span class="all_toggle-hide">Hide the list</span></summary>
        <div class="all_scroll"><table class="all_table">
          <thead><tr><th></th><th>Old URL</th><th>Statuses</th><th>Lands on</th><th>Issues</th></tr></thead>
          <tbody>${allRows}</tbody>
        </table></div>
      </details>
    </div></div></div>
  </section>
</main>
<footer class="rule-top">
  <div class="padding-global"><div class="container-large is-framed"><div>
    <div class="footer_grid">
      <div class="footer_brand">${BRAIN}<p class="footer_wordmark">IT_Crowd</p><p class="footer_tagline">Web development agency. We plan and run website migrations.</p></div>
      <div><p class="footer_heading">This report</p><p class="footer_text">Generated by <a class="text-style-link" href="${esc(toolUrl)}">redirect-map-check</a>${version ? ` v${esc(version)}` : ''}, our free, MIT-licensed redirect checker.</p></div>
      <div><p class="footer_heading">Planning a migration?</p><p class="footer_text"><a class="text-style-link" href="https://itcrowd.work/services/migrations/">See how we run them</a> or <a class="text-style-link" href="https://itcrowd.work/contact/">get in touch</a>.</p></div>
    </div>
    <div class="footer_bottom"><span>Fonts: Geist and IBM Plex Mono, SIL Open Font License 1.1.</span><span>itcrowd.work</span></div>
  </div></div></div>
</footer>
</body>
</html>
`;
}
