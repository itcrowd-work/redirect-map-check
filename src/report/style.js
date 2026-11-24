// Shared look for everything we render in a browser (the HTML report and the local UI):
// the itcrowd.work tokens, Geist + IBM Plex Mono embedded, the brain mark.

import { readFileSync } from 'node:fs';

let fontCss = null;
/** @font-face rules with the fonts inlined (OFL 1.1, licences in assets/fonts/). Empty if the files are missing. */
export function fonts() {
  if (fontCss !== null) return fontCss;
  try {
    const data = (name) => readFileSync(new URL(`../../assets/fonts/${name}`, import.meta.url)).toString('base64');
    fontCss = [
      `@font-face{font-family:"Geist";src:url(data:font/woff2;base64,${data('geist-variable.woff2')}) format("woff2");font-weight:100 900;font-display:swap}`,
      `@font-face{font-family:"IBM Plex Mono";src:url(data:font/woff2;base64,${data('ibm-plex-mono-400.woff2')}) format("woff2");font-weight:400;font-display:swap}`,
      `@font-face{font-family:"IBM Plex Mono";src:url(data:font/woff2;base64,${data('ibm-plex-mono-500.woff2')}) format("woff2");font-weight:500;font-display:swap}`,
    ].join('\n');
  } catch {
    fontCss = '';
  }
  return fontCss;
}

// The ITCrowd brain mark, drawn with the current text colour.
export const BRAIN = `<svg class="logo_mark" viewBox="0 0 320 262" fill="none" stroke="currentColor" stroke-width="12" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M136 236 C 124 246, 102 248, 86 238 C 74 230, 70 220, 72 212 C 50 220, 24 206, 16 184 C 12 170, 18 156, 30 150 C 12 140, 6 116, 18 98 C 26 86, 40 80, 52 84 C 40 68, 46 42, 66 32 C 78 26, 92 28, 102 36 C 104 20, 120 8, 138 10 C 150 12, 158 18, 162 28 C 170 16, 186 8, 204 12 C 220 16, 232 28, 236 44 C 258 38, 284 48, 296 70 C 304 86, 300 104, 290 114 C 310 126, 318 154, 306 176 C 300 190, 288 198, 276 200 C 286 218, 272 240, 250 246 C 236 250, 220 246, 210 236 C 204 242, 196 246, 186 247"/><path d="M52 102 C 40 114, 40 132, 52 146"/><path d="M72 118 C 64 126, 64 138, 72 146"/><path d="M108 44 C 114 52, 118 64, 118 78"/><path d="M212 46 C 228 48, 240 60, 246 76"/><path d="M258 150 C 270 160, 276 174, 276 190"/><path d="M160 76 V 252"/><path d="M188 120 V 190 H 236"/><path d="M220 150 V 168 H 188"/><path d="M134 144 V 198 H 106 V 180"/><circle cx="160" cy="64" r="11"/><circle cx="188" cy="108" r="11"/><circle cx="220" cy="138" r="11"/><circle cx="134" cy="132" r="11"/><circle cx="106" cy="168" r="11"/></svg>`;

// The site's background line field, as a static tile (the live site turns the lines towards the pointer).
export const field = (hex) =>
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Cpath d='M5.9 10.1 10.1 5.9' stroke='%23${hex}' stroke-opacity='.1' stroke-linecap='round'/%3E%3C/svg%3E")`;


/** The site's tokens and the report's component styles. */
export function baseCss() {
  return `${fonts()}
:root {
  color-scheme: light dark;
  --color-paper: #f5f4f0; --color-paper-2: #ecebe6; --color-surface: #fbfaf8;
  --color-ink: #0c0c0b; --color-grey: #5c5f66; --color-grey-dim: #6b6e75; --color-line: #dddcd6; --color-error: #b42318;
  --font-sans: "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
  --text-size-tiny: 0.8rem; --text-size-small: 0.95rem; --text-size-regular: 1.0625rem; --text-size-large: 1.25rem;
  --text-size-h1: clamp(2.5rem, 6.2vw, 4.75rem); --text-size-h2: clamp(1.75rem, 3.4vw, 2.5rem);
  --container-large: 72.5rem; --container-text: 64ch; --grid-gap: 2rem;
  --span-5: calc((100% - 11 * var(--grid-gap)) / 12 * 5 + var(--grid-gap) * 4);
  --radius-small: 0.375rem; --radius-large: 0.75rem;
  --field: ${field('0c0c0b')};
}
@media (prefers-color-scheme: dark) {
  :root {
    --color-paper: #0f0f0e; --color-paper-2: #1c1c1a; --color-surface: #171716;
    --color-ink: #f2f1ec; --color-grey: #a9abb1; --color-grey-dim: #8b8e95; --color-line: #2c2c29; --color-error: #f97066;
    --field: ${field('f2f1ec')};
  }
}
@media (min-width: 90rem) { html { font-size: clamp(16px, 1.1111vw, 26px); } }
* { box-sizing: border-box; }
html { background: var(--color-paper); }
body {
  margin: 0; background: var(--color-paper) var(--field); color: var(--color-ink);
  font-family: var(--font-sans); font-size: var(--text-size-regular); line-height: 1.6;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
}
h1, h2, p, ul, dl, dd { margin: 0; }
ul { padding: 0; list-style: none; }
a { color: inherit; text-decoration: none; }
::selection { background: var(--color-ink); color: var(--color-paper); }
:focus-visible { outline: 2px solid var(--color-ink); outline-offset: 3px; }

/* Structure */
.padding-global { padding-left: 1.25rem; padding-right: 1.25rem; }
.container-large { width: 100%; max-width: var(--container-large); margin: 0 auto; }
.section_inner { padding: 3rem 0; }
.rule-top { border-top: 1px solid var(--color-line); }
@media (min-width: 40rem) { .padding-global { padding-left: 2rem; padding-right: 2rem; } .section_inner { padding: 4.5rem 0; } }
@media (min-width: 64rem) { .container-large.is-framed { border-left: 1px solid var(--color-line); border-right: 1px solid var(--color-line); } .container-large.is-framed > * { padding-left: 2rem; padding-right: 2rem; } }
.split_layout { display: grid; gap: 2rem var(--grid-gap); }
@media (min-width: 64rem) { .split_layout { grid-template-columns: var(--span-5) minmax(0, 1fr); } .split_text { position: sticky; top: 5.5rem; align-self: start; } }
.split_title { margin-top: 1rem; }
.split_lead { margin-top: 1.25rem; color: var(--color-grey); max-width: 46ch; }
.split_count { margin-top: 1.5rem; }

/* Typography */
.heading-style-h1 { font-size: var(--text-size-h1); line-height: 1.02; letter-spacing: -0.035em; font-weight: 600; text-wrap: balance; }
.heading-style-h2 { font-size: var(--text-size-h2); line-height: 1.1; letter-spacing: -0.028em; font-weight: 600; text-wrap: balance; }
.text-style-mono { font-family: var(--font-mono); font-weight: 500; font-size: var(--text-size-tiny); letter-spacing: 0.08em; text-transform: uppercase; }
.text-style-eyebrow { font-family: var(--font-mono); font-size: var(--text-size-tiny); letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-grey); }
.text-style-eyebrow::before { content: "/ "; }
.text-style-link { text-decoration: underline; text-decoration-color: var(--color-grey-dim); text-underline-offset: 0.2em; text-decoration-thickness: 1px; overflow-wrap: anywhere; }
.text-style-link:hover { text-decoration-color: var(--color-ink); }
.text-color-grey { color: var(--color-grey); }
.text-color-grey-dim { color: var(--color-grey-dim); }

/* Header */
.nav_component { position: sticky; top: 0; z-index: 10; border-bottom: 1px solid var(--color-line); background: color-mix(in srgb, var(--color-paper) 90%, transparent); backdrop-filter: blur(8px); }
.nav_inner { display: flex; height: 4rem; align-items: center; justify-content: space-between; gap: 1rem; }
.nav_logo { display: flex; align-items: center; gap: 0.625rem; font-size: 1.05rem; font-weight: 600; letter-spacing: -0.01em; }
.nav_logo .logo_mark { height: 1.6875rem; width: auto; }
.logo_caret { display: inline-block; width: 0.05em; height: 0.95em; margin-left: 0.12em; background: var(--color-grey); vertical-align: -0.12em; }
.nav_meta { display: none; color: var(--color-grey); }
.nav_meta span + span::before { content: "/"; color: var(--color-grey-dim); margin: 0 0.6rem; }
@media (min-width: 40rem) { .nav_meta { display: block; } }

/* Hero */
.hero_title { margin-top: 1.25rem; }
.hero_lead { margin-top: 1.75rem; font-size: var(--text-size-large); color: var(--color-grey); max-width: var(--container-text); }
.hero_lead b { color: var(--color-ink); font-weight: 500; overflow-wrap: anywhere; }
.hero_meta { margin-top: 1.5rem; color: var(--color-grey); }
.hero_meta span { white-space: nowrap; }
.hero_meta span + span::before { content: "/"; color: var(--color-grey-dim); margin: 0 0.6rem; }

/* Track-record style band */
.stats_grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.stats_cell { padding: 1.75rem 1.25rem; border-left: 1px solid var(--color-line); }
.stats_cell:nth-child(odd) { border-left: 0; }
.stats_cell:nth-child(n+3) { border-top: 1px solid var(--color-line); }
.stats_number { font-size: var(--text-size-h2); font-weight: 600; letter-spacing: -0.028em; line-height: 1.1; font-variant-numeric: tabular-nums; margin-bottom: 0.5rem; }
@media (min-width: 48rem) {
  .stats_grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .stats_cell { padding: 2.25rem 2rem; }
  .stats_cell:nth-child(odd) { border-left: 1px solid var(--color-line); }
  .stats_cell:first-child { border-left: 0; }
  .stats_cell:nth-child(n+3) { border-top: 0; }
}
@media (min-width: 64rem) { .container-large.is-framed > .stats_grid { padding: 0; } }

/* Severity marks, bracketed like the site's tool marks */
.mark { font-family: var(--font-mono); font-weight: 500; font-size: var(--text-size-tiny); letter-spacing: 0.04em; white-space: nowrap; }
.mark.is-error { color: var(--color-error); }
.mark.is-warning { color: var(--color-ink); }
.mark.is-notice, .mark.is-ok { color: var(--color-grey); }

/* Index card ("Problems by type") */
.index_card { border: 1px solid var(--color-line); border-radius: var(--radius-large); background: var(--color-surface); padding: 0.5rem 1.25rem 1.25rem; }
.index_group { padding-top: 1rem; }
.index_list { margin-top: 0.25rem; }
.index_row { display: grid; grid-template-columns: 4.25rem minmax(0, 1fr) auto; align-items: baseline; gap: 0.75rem; padding: 0.625rem 0; border-bottom: 1px solid var(--color-line); font-size: var(--text-size-small); }
.index_list li:last-child .index_row { border-bottom: 0; }
.index_row:hover .index_title { text-decoration: underline; text-underline-offset: 0.2em; text-decoration-thickness: 1px; }
.index_count { font-family: var(--font-mono); font-weight: 500; font-variant-numeric: tabular-nums; }

/* Problem items */
.item_list { display: grid; gap: 1rem; }
.item_card { border: 1px solid var(--color-line); border-radius: var(--radius-large); background: var(--color-surface); padding: 1.25rem; }
@media (min-width: 40rem) { .item_card { padding: 1.5rem 1.75rem; } }
.item_url { font-weight: 500; overflow-wrap: anywhere; }
.item_url .text-style-link { text-decoration-color: var(--color-line); }
.item_facts { display: grid; gap: 0.5rem; margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--color-line); font-size: var(--text-size-small); }
.item_fact { display: grid; gap: 0.125rem; }
@media (min-width: 40rem) { .item_fact { grid-template-columns: 6.5rem minmax(0, 1fr); gap: 0.75rem; } }
.item_fact dt { color: var(--color-grey-dim); }
.item_fact dd { color: var(--color-grey); overflow-wrap: anywhere; }
.chain { font-family: var(--font-mono); font-size: var(--text-size-tiny); white-space: nowrap; }
.status { color: var(--color-ink); font-weight: 500; }
.status.is-bad { color: var(--color-error); }
.status.is-temp { text-decoration: underline wavy var(--color-grey-dim); text-underline-offset: 0.25em; }
.status.is-muted { color: var(--color-grey); }
.status_arrow { color: var(--color-grey-dim); margin: 0 0.4em; }

/* Recommended fix: the first thing to read on every card */
.item_fix { margin-top: 1rem; padding: 0.875rem 1rem; border-radius: var(--radius-small); background: var(--color-paper-2); border-left: 2px solid var(--color-ink); font-size: var(--text-size-small); overflow-wrap: anywhere; }
.item_fix-label { color: var(--color-grey); margin-bottom: 0.25rem; }

/* Candidate pages for a fix */
.cand_list { margin: 0; padding: 0; list-style: none; display: grid; gap: 0.375rem; }
.cand_score { font-family: var(--font-mono); font-size: var(--text-size-tiny); letter-spacing: 0.04em; text-transform: uppercase; white-space: nowrap; }
.cand_score.is-strong { color: var(--color-ink); font-weight: 500; }
.cand_score.is-possible { color: var(--color-grey-dim); }

/* Notes */
.note_list { display: grid; gap: 1rem; color: var(--color-grey); max-width: var(--container-text); }
.note_list li { padding-left: 1.5rem; position: relative; }
.note_list li::before { content: "→"; position: absolute; left: 0; color: var(--color-grey-dim); font-family: var(--font-mono); }

/* Every URL */
.all_toggle { display: inline-flex; align-items: center; height: 3rem; padding: 0 1.25rem; border: 1px solid var(--color-line); border-radius: var(--radius-small); cursor: pointer; font-weight: 500; font-size: var(--text-size-small); list-style: none; }
.all_toggle::-webkit-details-marker { display: none; }
.all_toggle:hover { border-color: var(--color-ink); }
details[open] .all_toggle-show, details:not([open]) .all_toggle-hide { display: none; }
.all_scroll { margin-top: 1.5rem; overflow-x: auto; border: 1px solid var(--color-line); border-radius: var(--radius-large); background: var(--color-surface); }
.all_table { border-collapse: collapse; width: 100%; font-size: var(--text-size-small); }
.all_table th { font-family: var(--font-mono); font-weight: 500; font-size: var(--text-size-tiny); letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-grey); text-align: left; padding: 0.875rem 1rem; border-bottom: 1px solid var(--color-line); }
.all_table td { padding: 0.75rem 1rem; border-bottom: 1px solid var(--color-line); vertical-align: top; overflow-wrap: anywhere; }
.all_table tr:last-child td { border-bottom: 0; }

/* Footer */
.footer_grid { display: grid; gap: 2rem var(--grid-gap); padding: 3rem 0; }
@media (min-width: 48rem) { .footer_grid { grid-template-columns: var(--span-5) minmax(0, 1fr) minmax(0, 1fr); } }
.footer_brand .logo_mark { height: 2.375rem; width: auto; }
.footer_wordmark { margin-top: 1rem; font-weight: 600; }
.footer_tagline, .footer_text { margin-top: 0.5rem; font-size: var(--text-size-small); color: var(--color-grey); max-width: 40ch; }
.footer_heading { font-weight: 600; font-size: var(--text-size-small); }
.footer_link { color: var(--color-ink); }
.footer_bottom { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.5rem 1.5rem; padding: 1.5rem 0 2.5rem; border-top: 1px solid var(--color-line); font-size: var(--text-size-tiny); color: var(--color-grey-dim); }

@media print {
  body { background: #fff; }
  .nav_component { position: static; backdrop-filter: none; }
  .split_text { position: static; }
  .item_card, .index_card { break-inside: avoid; }
}`;
}
