import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SLUG } from './host.js';

/**
 * Private, anonymous counts for each hosted business, per day: how often its
 * page was opened (pageViews), how often AI tools asked about it (toolCalls),
 * how often it came up in searches across Gentifi (searchAppearances), and how
 * many orders customers confirmed on the confirmation page (confirmations).
 * Only numbers are kept, in <dir>/<slug>/stats.json: never who, from where,
 * or what was asked.
 */

export const KINDS = ['pageViews', 'toolCalls', 'searchAppearances', 'confirmations'];
const KEEP_DAYS = 400;

/** Crawlers, link previews and scripts don't count as people opening a page. */
export const isBot = (userAgent) => !userAgent || /bot|crawl|spider|slurp|preview|externalhit|whatsapp|telegram|slack|discord|skype|fetch|curl|wget|python|httpclient|monitor|headless|scan/i.test(userAgent);

const today = () => new Date().toISOString().slice(0, 10);

export function createStats({ dir, log = () => {} }) {
  const pending = new Map();

  function count(slug, kind, n = 1) {
    if (!SLUG.test(slug) || !KINDS.includes(kind)) return;
    const days = pending.get(slug) ?? pending.set(slug, {}).get(slug);
    const day = (days[today()] ??= {});
    day[kind] = (day[kind] ?? 0) + n;
  }

  /** Adds the counts so far to each business's stats.json. */
  async function flush() {
    const batch = [...pending];
    pending.clear();
    for (const [slug, days] of batch) {
      const file = join(dir, slug, 'stats.json');
      try {
        const saved = await readFile(file, 'utf8').then(JSON.parse, () => ({ days: {} }));
        for (const [day, kinds] of Object.entries(days)) {
          const into = (saved.days[day] ??= {});
          for (const [kind, n] of Object.entries(kinds)) into[kind] = (into[kind] ?? 0) + n;
        }
        const keep = Object.keys(saved.days).sort().slice(-KEEP_DAYS);
        saved.days = Object.fromEntries(keep.map((d) => [d, saved.days[d]]));
        await writeFile(`${file}.tmp`, `${JSON.stringify(saved, null, 2)}\n`);
        await rename(`${file}.tmp`, file);
      } catch (e) {
        log(`[${slug}] Could not save stats: ${e.message}`);
      }
    }
  }

  return { count, flush };
}

/** Totals per business over the last `days` days, from the saved files. */
export async function readStats(dir, { days = 30 } = {}) {
  const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SLUG.test(entry.name)) continue;
    const saved = await readFile(join(dir, entry.name, 'stats.json'), 'utf8').then(JSON.parse, () => null);
    const totals = Object.fromEntries(KINDS.map((k) => [k, 0]));
    for (const [day, kinds] of Object.entries(saved?.days ?? {})) {
      if (day < since) continue;
      for (const k of KINDS) totals[k] += kinds[k] ?? 0;
    }
    out.push({ slug: entry.name, ...totals });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}
