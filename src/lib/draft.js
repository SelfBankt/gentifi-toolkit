import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { VERSION } from './version.js';

/**
 * Drafts a catalogue from photos of a price board, menu or price list, with an AI
 * model that reads images, for Gentifi to check before anything goes live.
 *
 * The model only reads what's there: a price it can't read is left blank, never
 * guessed, and anything it's unsure of is flagged in a "check" column. Business
 * details it sees (name, hours, phone) are notes for a person to confirm; the
 * toolkit never guesses business details.
 *
 * Any OpenAI-compatible chat completions API that takes images works. Settings:
 *   GENTIFI_AI_URL    base URL (default OpenCode Go: https://opencode.ai/inference/go/openai/v1)
 *   GENTIFI_AI_MODEL  a model that reads images
 *   GENTIFI_AI_KEY    the API key, or GENTIFI_AI_KEY_FILE (default ~/.gentifi/ai-key)
 */

export const DEFAULT_AI_URL = 'https://opencode.ai/inference/go/openai/v1';
export const MAX_PHOTOS = 5;
const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

export class DraftError extends Error {}

const INSTRUCTIONS = `You read photos of price boards, menus and price lists for small independent UK shops, cafés and market stalls, so their catalogue can be put online. Accuracy matters more than completeness: a wrong price is worse than a missing one.

Reply with JSON only, no other text, in exactly this shape:
{
  "items": [
    {"name": "", "price": null, "price_from": null, "unit": "", "category": "", "description": "", "allergens": "", "dietary": "", "notice": "", "unsure": ""}
  ],
  "business": {"name": "", "opening_hours": [], "phone": "", "email": "", "website": "", "address": ""},
  "unreadable": []
}

Rules:
- One item per thing for sale, with its name as written. Several sizes or options at different prices are separate items (e.g. "Sourdough loaf (large)").
- price: the price in pounds as a number (3.5 for £3.50). "From £8" or "£8+" goes in price_from instead. If there's no price, or you can't read it with certainty, use null and say why in "unsure". Never guess or work out a price.
- unit: what the price is for, as shown ("dozen", "kg", "each", "per person"); blank if not shown.
- category: the board's own heading for the item if it has one; otherwise blank.
- description, allergens, dietary (e.g. "vegan", "gluten-free") and notice (e.g. "order 48 hours ahead"): only what's written.
- unsure: anything you're not sure of about this item (a smudged letter, a price that could be 3.50 or 8.50); blank if sure.
- business: only details actually shown, such as the shop's name, opening hours ("Mo-Fr 09:00-17:00" style), phone, email, website, address. Leave the rest blank.
- unreadable: parts of the photo you couldn't read, in a few words each.
- Don't include anything that isn't shown.`;

/** The key, from GENTIFI_AI_KEY or a file only the user can read; never printed. */
export async function aiKey(env = process.env) {
  if (env.GENTIFI_AI_KEY) return env.GENTIFI_AI_KEY.trim();
  const file = env.GENTIFI_AI_KEY_FILE || join(homedir(), '.gentifi', 'ai-key');
  const key = await readFile(file, 'utf8').then((s) => s.trim(), () => '');
  if (!key) throw new DraftError(`No AI key: put it in ${file} (one line, nothing else), or set GENTIFI_AI_KEY.`);
  return key;
}

/** A photo as a data URL the model can read. */
export async function photoUrl(path) {
  const ext = extname(path).toLowerCase();
  if (ext === '.heic' || ext === '.heif') {
    throw new DraftError(`${path} is an iPhone HEIC photo, which models can't read. On a Mac, convert it first: sips -s format jpeg "${path}" --out photo.jpg`);
  }
  const type = TYPES[ext];
  if (!type) throw new DraftError(`${path}: use a JPEG, PNG, WebP or GIF photo.`);
  const data = await readFile(path).catch(() => { throw new DraftError(`Can't read ${path}.`); });
  if (data.length > MAX_BYTES) throw new DraftError(`${path} is over 10 MB: send a smaller copy of the photo.`);
  return `data:${type};base64,${data.toString('base64')}`;
}

/** The model's JSON, even wrapped in a code fence or a sentence. */
export function parseReply(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new DraftError('The model didn’t reply with a catalogue. Try again, or a clearer photo.');
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new DraftError('The model’s reply wasn’t valid JSON. Try again, or a clearer photo.');
  }
}

const str = (v) => (v == null ? '' : String(v).trim());
const price = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[£,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : NaN;
};

/**
 * The reply as rows for the catalogue CSV, each with a "check" note for anything a
 * person should look at, and the business details and unreadable parts as notes.
 */
export function draftFromReply(reply) {
  const rows = [];
  const names = new Map();
  for (const raw of Array.isArray(reply?.items) ? reply.items : []) {
    const name = str(raw?.name);
    if (!name) continue;
    const checks = [str(raw.unsure)].filter(Boolean);
    let p = price(raw.price);
    let from = price(raw.price_from);
    if (Number.isNaN(p) || Number.isNaN(from)) {
      checks.push(`price "${str(raw.price) || str(raw.price_from)}" isn't a number`);
      p = Number.isNaN(p) ? null : p;
      from = Number.isNaN(from) ? null : from;
    }
    if (p == null && from == null) checks.push('no price read: add it, or this row is left out');
    if ((p ?? from ?? 0) >= 500) checks.push('unusually high price: check it');
    const key = name.toLowerCase();
    if (names.has(key)) checks.push(`same name as row ${names.get(key)}: give each its own name`);
    else names.set(key, rows.length + 2); // + header row, 1-based
    rows.push({
      name, price: p ?? '', price_from: p == null ? from ?? '' : '', unit: str(raw.unit), category: str(raw.category),
      description: str(raw.description), allergens: str(raw.allergens), dietary: str(raw.dietary), notice: str(raw.notice),
      check: checks.join('; '),
    });
  }
  const b = reply?.business ?? {};
  const business = {
    name: str(b.name), phone: str(b.phone), email: str(b.email), website: str(b.website), address: str(b.address),
    openingHours: (Array.isArray(b.opening_hours) ? b.opening_hours : [b.opening_hours]).map(str).filter(Boolean),
  };
  const unreadable = (Array.isArray(reply?.unreadable) ? reply.unreadable : []).map(str).filter(Boolean);
  return { rows, business, unreadable };
}

export const CSV_COLUMNS = ['name', 'price', 'price_from', 'unit', 'category', 'description', 'allergens', 'dietary', 'notice', 'check'];

export function toCsv(rows) {
  const cell = (v) => (/[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [CSV_COLUMNS.join(','), ...rows.map((r) => CSV_COLUMNS.map((c) => cell(r[c] ?? '')).join(','))].join('\n') + '\n';
}

/** Sends the photos to the model and returns its reply, parsed. */
export async function readPhotos(paths, { env = process.env, fetchImpl = globalThis.fetch, model = env.GENTIFI_AI_MODEL, timeoutMs = 180000 } = {}) {
  if (!paths.length) throw new DraftError('Give at least one photo with --photo.');
  if (paths.length > MAX_PHOTOS) throw new DraftError(`At most ${MAX_PHOTOS} photos at a time.`);
  if (!model) throw new DraftError('Choose a model that reads images with --model or GENTIFI_AI_MODEL (on OpenCode Go, try kimi-k3).');
  const images = await Promise.all(paths.map(photoUrl));
  const key = await aiKey(env);
  const base = (env.GENTIFI_AI_URL || DEFAULT_AI_URL).replace(/\/+$/, '');
  let res;
  try {
    res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'user-agent': `gentifi-toolkit/${VERSION}`,
        'x-opencode-session': `gentifi-draft-${randomBytes(6).toString('hex')}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: INSTRUCTIONS },
          { role: 'user', content: [
            { type: 'text', text: `Read ${paths.length === 1 ? 'this photo' : `these ${paths.length} photos (one board or menu)`} and reply with the JSON.` },
            ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
          ] },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new DraftError(`Couldn't reach the AI service at ${base}: ${e.message}`);
  }
  const body = await res.text();
  if (res.status === 401 || res.status === 403) throw new DraftError('The AI service refused the key: check ~/.gentifi/ai-key.');
  if (!res.ok) throw new DraftError(`The AI service answered ${res.status}${/image/i.test(body) ? ' (this model may not read images: try another with --model)' : ''}: ${body.slice(0, 300)}`);
  let content;
  try {
    content = JSON.parse(body).choices?.[0]?.message?.content;
  } catch {
    content = null;
  }
  if (Array.isArray(content)) content = content.map((p) => p.text ?? '').join('');
  if (typeof content !== 'string' || !content.trim()) throw new DraftError('The AI service sent back an empty reply.');
  return parseReply(content);
}
