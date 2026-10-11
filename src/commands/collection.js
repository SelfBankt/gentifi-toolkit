import { readFile } from 'node:fs/promises';
import { validateCollection, verifyMembership } from '../lib/collections.js';
import { plural, printResults } from '../lib/report.js';

const SUBCOMMANDS = ['check'];

export default {
  summary: 'Check a Business Collection (draft 0.2): a show, market or high street',
  usage: 'check <file or URL> [--verify] [--published-at <url>] [--json]',
  positionals: true,
  options: {
    verify: { type: 'boolean', description: 'Fetch each member\'s own manifest and confirm it links back (rule 1)' },
    'published-at': { type: 'string', description: 'For a local file: the https URL it will be published at' },
    json: { type: 'boolean', description: 'Print results as JSON' },
  },
  async run(values, { out, err }, positionals = []) {
    const [sub, target] = positionals;
    if (!SUBCOMMANDS.includes(sub) || !target) {
      err('Usage: gentifi collection check <file or URL> [--verify] [--published-at <url>]');
      return 1;
    }
    const isUrl = /^https?:\/\//.test(target);
    let doc;
    try {
      if (isUrl) {
        const res = await fetch(target, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        doc = await res.json();
      } else {
        doc = JSON.parse(await readFile(target, 'utf8'));
      }
    } catch (e) {
      err(`Could not read ${target}: ${e.message}`);
      return 1;
    }

    const collectionUrl = isUrl ? target : values['published-at'];
    const results = validateCollection(doc, { servedFrom: collectionUrl }).map((r) => ({ group: 'Business Collection', ...r }));
    let membership = [];
    if (values.verify) {
      if (!collectionUrl) {
        err('To verify membership of a local file, pass --published-at with the URL members link back to.');
        return 1;
      }
      membership = await verifyMembership(doc, collectionUrl);
      for (const m of membership) {
        const level = m.status === 'confirmed' ? 'pass' : 'fail';
        results.push({ group: 'Membership (rule 1)', level, text: `${m.entry.displayName ?? m.entry.identifier}: ${m.status}, ${m.detail}` });
      }
    } else {
      results.push({ group: 'Membership (rule 1)', level: 'info', text: 'Not checked. Add --verify to confirm each member links back to this collection' });
    }

    const fails = results.filter((r) => r.level === 'fail').length;
    if (values.json) {
      out(JSON.stringify({ target, valid: fails === 0, results }, null, 2));
      return fails ? 1 : 0;
    }
    out(`Business Collection check for ${target}\n`);
    printResults(results, out);
    out('');
    const confirmed = membership.filter((m) => m.status === 'confirmed').length;
    out(fails
      ? `${plural(fails, 'problem')} against draft 0.2.${values.verify ? ` ${confirmed} of ${membership.length} members confirmed.` : ''}`
      : `Valid against draft 0.2.${values.verify ? ` All ${plural(membership.length, 'member')} confirmed.` : ''}`);
    return fails ? 1 : 0;
  },
};
