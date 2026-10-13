import { resolve } from 'node:path';
import { readStats } from '../lib/stats.js';

export default {
  summary: 'How often each hosted business was opened, asked about and found',
  usage: '--dir <folder> [--days <n>] [--json]',
  options: {
    dir: { type: 'string', description: 'The folder gentifi host serves (one sub-folder per business)' },
    days: { type: 'string', description: 'How many days to total, including today (default 30)' },
    json: { type: 'boolean', description: 'Print the totals as JSON' },
  },
  async run(values, { out, err }) {
    if (!values.dir) {
      err('Say which folder holds the businesses with --dir.');
      return 1;
    }
    const days = Math.max(1, Number(values.days ?? 30) || 30);
    let rows;
    try {
      rows = await readStats(resolve(values.dir), { days });
    } catch (e) {
      err(`Could not read ${values.dir}: ${e.message}`);
      return 1;
    }
    if (values.json) {
      out(JSON.stringify({ days, businesses: rows }, null, 2));
      return 0;
    }
    const head = ['Business', 'Page opened', 'AI asked about it', 'Came up in searches'];
    const table = [head, ...rows.map((r) => [r.slug, r.pageViews, r.toolCalls, r.searchAppearances].map(String))];
    const widths = head.map((_, i) => Math.max(...table.map((row) => row[i].length)));
    out(`Last ${days} day${days === 1 ? '' : 's'}, counted anonymously by gentifi host:\n`);
    for (const row of table) out(row.map((c, i) => (i ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('   '));
    if (!rows.length) out('No businesses in this folder.');
    return 0;
  },
};
