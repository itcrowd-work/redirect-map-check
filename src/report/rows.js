// Flatten results into one row per problem, shared by the CSV and HTML reports.

import { severityRank } from '../issues.js';

export function statusChain(result) {
  const parts = result.chain.hops.map((h) => (h.loopsBack ? '↺' : h.status ?? 'ERR'));
  if (result.chain.blocked) parts.push('robots');
  return parts.join(' → ');
}

export function redirectCount(result) {
  return result.chain.hops.filter((h) => [301, 302, 303, 307, 308].includes(h.status)).length;
}

export function problemRows(run) {
  const rows = [];
  for (const result of run.results) {
    for (const issue of result.issues) {
      rows.push({
        severity: issue.severity,
        type: issue.type,
        title: issue.title,
        detail: issue.detail,
        fix: issue.fix ?? '',
        suggestions: issue.suggestions ?? [],
        oldUrl: result.oldUrl,
        testedUrl: result.requestUrl,
        expectedUrl: result.expectedUrl ?? '',
        finalUrl: result.chain.finalUrl ?? '',
        finalStatus: result.chain.finalStatus ?? '',
        hops: redirectCount(result),
        statusChain: statusChain(result),
        similarity: result.similarity === null || result.similarity === undefined ? '' : result.similarity.toFixed(2),
      });
    }
  }
  for (const { line, issue } of run.mapRowIssues) {
    rows.push({
      severity: issue.severity,
      type: issue.type,
      title: issue.title,
      detail: issue.detail || `Map row ${line}`,
      fix: issue.fix ?? '',
      suggestions: [],
      oldUrl: issue.data?.url ?? '',
      testedUrl: '',
      expectedUrl: '',
      finalUrl: '',
      finalStatus: '',
      hops: '',
      statusChain: '',
      similarity: '',
    });
  }
  return rows.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.type.localeCompare(b.type));
}
