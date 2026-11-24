import { ISSUES, SEVERITIES } from '../issues.js';

function palette(enabled) {
  const wrap = (code) => (text) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : String(text));
  return { red: wrap('31'), yellow: wrap('33'), blue: wrap('34'), green: wrap('32'), dim: wrap('2'), bold: wrap('1') };
}

/** The short summary printed at the end of a run. */
export function renderSummary(run, { color = false, files = [] } = {}) {
  const c = palette(color);
  const s = run.summary;
  const tint = { error: c.red, warning: c.yellow, notice: c.blue };
  const lines = [];
  lines.push('');
  lines.push(`${c.bold('redirect-map-check')}  ${s.urlsChecked} URLs checked in ${(s.durationMs / 1000).toFixed(1)}s (${s.requests} requests)`);
  if (s.base) lines.push(c.dim(`Tested against ${s.base}`));
  lines.push('');
  lines.push(
    `  ${c.red(`✖ ${s.urlsWithErrors} with errors`)}   ${c.yellow(`▲ ${s.urlsWithWarnings} with warnings`)}   ${c.green(`✔ ${s.clean} clean`)}${s.sitemapsUnread ? c.dim(' (of the URLs we could read)') : ''}`,
  );
  if (s.sitemapsUnread) {
    lines.push(c.red(`  ? ${s.sitemapsUnread} sitemap${s.sitemapsUnread === 1 ? '' : 's'} could not be read; the URLs in ${s.sitemapsUnread === 1 ? 'it' : 'them'} were not checked.`));
  }
  if (s.urlsUnchecked) {
    const n = s.urlsUnchecked;
    lines.push(c.red(`  ? ${n} URL${n === 1 ? '' : 's'} could not be checked at all; ${n === 1 ? 'it counts' : 'they count'} as ${n === 1 ? 'an error' : 'errors'}, never as clean.`));
  }

  for (const severity of SEVERITIES) {
    const types = Object.keys(ISSUES).filter((t) => ISSUES[t].severity === severity && s.byType[t]);
    if (!types.length) continue;
    lines.push('');
    lines.push(`  ${tint[severity](severity === 'error' ? 'Errors' : severity === 'warning' ? 'Warnings' : 'Notices')}`);
    for (const type of types) {
      lines.push(`    ${String(s.byType[type]).padStart(4)}  ${type.padEnd(26)} ${c.dim(ISSUES[type].title)}`);
    }
  }

  if (run.notes.length) {
    lines.push('');
    for (const note of run.notes) lines.push(c.dim(`  Note: ${note}`));
  }
  if (files.length) {
    lines.push('');
    for (const file of files) lines.push(`  ${file}`);
  }
  lines.push('');
  return lines.join('\n');
}
