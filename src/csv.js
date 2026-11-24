// Small RFC 4180 CSV reader/writer. Handles quoted fields, escaped quotes,
// CRLF, a BOM, and comma / semicolon / tab delimiters (spreadsheets set to a
// European locale often export with semicolons).

/** Guess the delimiter from the first non-empty line, counting only characters outside quotes. */
export function detectDelimiter(text) {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch] += 1;
  }
  const [best] = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return best[1] > 0 ? best[0] : ',';
}

/** Parse CSV text into an array of rows (arrays of strings). Blank lines are skipped. */
export function parseCsv(text, delimiter) {
  return parseCsvDetailed(text, delimiter).rows;
}

/**
 * Like parseCsv, but also reports where an unclosed quote started (so a stray " can't
 * silently swallow the rest of the file): { rows, unclosedQuoteLine }.
 */
export function parseCsvDetailed(text, delimiter) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const delim = delimiter ?? detectDelimiter(src);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  let line = 1; // physical line where the current row starts, as a spreadsheet would number it
  let rowLine = 1;
  let quoteLine = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    if (row.some((cell) => cell.trim() !== '')) {
      Object.defineProperty(row, 'line', { value: rowLine });
      rows.push(row);
    }
    row = [];
    line += 1;
    rowLine = line;
  };

  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      quoteLine = line;
    }
    else if (ch === delim) endField();
    else if (ch === '\n') endRow();
    else if (ch === '\r') {
      if (src[i + 1] !== '\n') endRow();
    } else field += ch;
    i += 1;
  }
  const unclosedQuoteLine = inQuotes ? quoteLine : 0;
  if (field !== '' || row.length > 0) endRow();
  return { rows, unclosedQuoteLine };
}

function escapeCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  // Stop spreadsheet apps from evaluating crawled text as a formula.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Serialise rows (arrays) into CSV text with CRLF line endings. */
export function toCsv(rows) {
  return rows.map((row) => row.map(escapeCell).join(',')).join('\r\n') + '\r\n';
}
