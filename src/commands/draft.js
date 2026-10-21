import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DEFAULT_AI_URL, DraftError, draftFromReply, readPhotos, toCsv } from '../lib/draft.js';

export default {
  summary: 'Draft a catalogue from photos of a price board or menu, for you to check',
  usage: '--photo <file> [--photo <file>…] [--out <folder>] [--model <name>]',
  options: {
    photo: { type: 'string', multiple: true, description: 'A JPEG, PNG or WebP photo (up to 5, of one board or menu)' },
    out: { type: 'string', description: 'Folder for catalogue.csv and notes.md (default ./draft)' },
    model: { type: 'string', description: 'AI model that reads images (default $GENTIFI_AI_MODEL)' },
  },
  async run(values, { out, err }, _positionals, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
    const photos = values.photo ?? [];
    const folder = resolve(values.out ?? 'draft');
    let draft;
    try {
      out(`Reading ${photos.length} photo${photos.length === 1 ? '' : 's'} with ${values.model || env.GENTIFI_AI_MODEL || 'the AI model'} at ${env.GENTIFI_AI_URL || DEFAULT_AI_URL}…`);
      draft = draftFromReply(await readPhotos(photos, { env, fetchImpl, model: values.model || env.GENTIFI_AI_MODEL }));
    } catch (e) {
      if (e instanceof DraftError) { err(e.message); return 1; }
      throw e;
    }
    const { rows, business, unreadable } = draft;
    if (!rows.length) {
      err('No items could be read from the photo. Try a straighter, closer, well-lit photo.');
      return 1;
    }
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'catalogue.csv'), toCsv(rows));
    await writeFile(join(folder, 'notes.md'), notes(business, unreadable, rows, folder));
    const flagged = rows.filter((r) => r.check).length;
    out([
      `Drafted ${rows.length} item${rows.length === 1 ? '' : 's'}${flagged ? `, ${flagged} to check` : ''}: ${join(folder, 'catalogue.csv')}`,
      `What else the photo shows, to confirm: ${join(folder, 'notes.md')}`,
      '',
      'Check every name and price against the photo (open the CSV in a spreadsheet), fix the',
      'rows marked in the "check" column and clear their notes, then create the project:',
      `  gentifi init --from csv --file ${join(folder, 'catalogue.csv')} --name "${business.name || 'Business name'}" …`,
    ].join('\n'));
    return 0;
  },
};

function notes(business, unreadable, rows, folder) {
  const shown = [
    business.name && `- Name: ${business.name}`,
    ...business.openingHours.map((h) => `- Hours: ${h}`),
    business.phone && `- Phone: ${business.phone}`,
    business.email && `- Email: ${business.email}`,
    business.website && `- Website: ${business.website}`,
    business.address && `- Address: ${business.address}`,
  ].filter(Boolean);
  const init = [
    `gentifi init --from csv --file ${join(folder, 'catalogue.csv')}`,
    `  --name "${business.name || 'Business name'}"`,
    ...business.openingHours.map((h) => `  --hours "${h}"`),
    business.phone && `  --phone "${business.phone}"`,
    business.email && `  --email "${business.email}"`,
    business.website && `  --website "${business.website}"`,
  ].filter(Boolean);
  return [
    '# Draft from a photo: check before use',
    '',
    'An AI model read these from the photo. It can misread, so confirm each with the business',
    'before using it; the toolkit never fills in business details by itself.',
    '',
    '## Business details shown on the photo',
    '',
    ...(shown.length ? shown : ['- None shown.']),
    '',
    '## Parts the model couldn’t read',
    '',
    ...(unreadable.length ? unreadable.map((u) => `- ${u}`) : ['- None.']),
    '',
    `## Items to check (${rows.filter((r) => r.check).length} of ${rows.length})`,
    '',
    ...(rows.some((r) => r.check) ? rows.filter((r) => r.check).map((r) => `- ${r.name}: ${r.check}`) : ['- None flagged, but check every price anyway.']),
    '',
    '## Then',
    '',
    'Once checked and confirmed with the business:',
    '',
    '```',
    init.join(' \\\n'),
    '```',
    '',
  ].join('\n');
}
