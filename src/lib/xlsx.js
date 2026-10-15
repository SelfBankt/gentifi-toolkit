import { inflateRawSync } from 'node:zlib';

/**
 * Small .xlsx reader, enough for till and online-shop exports: the first
 * worksheet's cell values as rows of strings. No formulas, styles or dates
 * beyond the stored value. Zero dependencies: a zip directory walk plus the
 * few XML elements a sheet uses.
 */

export const isXlsx = (bytes) => bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

/** Reads every file in a zip archive into a Map of name -> Buffer. */
export function unzip(buf) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('damaged zip directory');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, inflateRawSync(data));
    p += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e] ?? m
));
/** The text of every <t> inside a fragment, joined (rich text comes in several runs). */
const texts = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1])).join('');
const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/** "B12" -> 1 (zero-based column index). */
function column(ref) {
  let n = 0;
  for (const c of /^[A-Z]+/.exec(ref)?.[0] ?? 'A') n = n * 26 + c.charCodeAt(0) - 64;
  return n - 1;
}

/** Excel stores 4.5 as 4.4999999999999991 now and then; keep what a person typed. */
const tidyNumber = (v) => (/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(v) ? String(Number(Number(v).toPrecision(12))) : v);

function firstSheetPath(files) {
  const workbook = files.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const sheet = /<sheet\s[^>]*>/.exec(workbook)?.[0];
  const id = sheet && attr(sheet, 'r:id');
  const rel = id && [...rels.matchAll(/<Relationship\s[^>]*>/g)].map((m) => m[0]).find((r) => attr(r, 'Id') === id);
  const target = rel && attr(rel, 'Target');
  if (target) return target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  return 'xl/worksheets/sheet1.xml';
}

/** Rows of string cells from the first worksheet. Missing cells are ''. */
export function readXlsxRows(buf) {
  const files = unzip(buf);
  const sheet = files.get(firstSheetPath(files))?.toString('utf8');
  if (!sheet) throw new Error('the spreadsheet has no worksheet');
  const shared = [...(files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]));
  const rows = [];
  for (const [, rowAttrs, body] of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const index = Number(attr(rowAttrs, 'r') ?? rows.length + 1) - 1;
    const cells = [];
    for (const [, cellAttrs, inner = ''] of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(cellAttrs, 'r');
      const at = ref ? column(ref) : cells.length;
      const type = attr(cellAttrs, 't');
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = '';
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = texts(inner);
      else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
      else if (v !== undefined) value = type === 'str' || type === 'e' ? decode(v) : tidyNumber(decode(v));
      while (cells.length < at) cells.push('');
      cells[at] = value;
    }
    while (rows.length < index) rows.push([]);
    rows[index] = cells;
  }
  const width = Math.max(0, ...rows.map((r) => r.length));
  return rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''));
}
