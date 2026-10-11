/**
 * Small RFC 4180 CSV reader: quoted fields, doubled quotes, delimiters and
 * line breaks inside quotes, CRLF or LF endings and a UTF-8 byte order mark.
 * The delimiter (comma, semicolon or tab) is taken from the header row, so
 * spreadsheet exports from most locales work unchanged.
 */

const DELIMITERS = [',', ';', '\t'];

export function detectDelimiter(text) {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  let best = ',';
  let bestCount = 0;
  for (const d of DELIMITERS) {
    const count = firstLine.split(d).length - 1;
    if (count > bestCount) [best, bestCount] = [d, count];
  }
  return best;
}

/** Splits CSV text into rows of raw string fields. */
export function parseRows(text, delimiter = detectDelimiter(text)) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const isBlank = (cells) => cells.every((f) => f.trim() === '');

/** Header cells become snake_case keys: "Price (£)" -> "price", "Available from" -> "available_from". */
export function normaliseHeader(h) {
  return h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Parses CSV text into records keyed by the normalised header row.
 * Each record keeps its spreadsheet row number (the header is row 1) for messages.
 */
export function parseCsv(text) {
  const [header = [], ...body] = parseRows(text);
  const headers = header.map(normaliseHeader);
  const records = [];
  body.forEach((cells, i) => {
    if (isBlank(cells)) return;
    const record = { _row: i + 2 };
    headers.forEach((h, j) => {
      if (h) record[h] = (cells[j] ?? '').trim();
    });
    records.push(record);
  });
  return { headers, records };
}
