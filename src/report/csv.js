import { toCsv } from '../csv.js';
import { problemRows } from './rows.js';

const COLUMNS = [
  ['severity', 'severity'],
  ['issue', 'type'],
  ['title', 'title'],
  ['old_url', 'oldUrl'],
  ['tested_url', 'testedUrl'],
  ['expected_url', 'expectedUrl'],
  ['final_url', 'finalUrl'],
  ['final_status', 'finalStatus'],
  ['hops', 'hops'],
  ['status_chain', 'statusChain'],
  ['similarity', 'similarity'],
  ['detail', 'detail'],
  ['recommended_fix', 'fix'],
  ['suggested_pages', 'suggestedPages'],
];

/** One row per problem found. */
export function renderCsv(run) {
  const rows = problemRows(run);
  const withSuggestions = rows.map((row) => ({
    ...row,
    suggestedPages: row.suggestions.map((s) => `${s.url} (${s.confidence} ${s.score.toFixed(2)})`).join('; '),
  }));
  return toCsv([COLUMNS.map(([name]) => name), ...withSuggestions.map((row) => COLUMNS.map(([, key]) => row[key]))]);
}
