import { readSource } from '../lib/catalogue.js';
import { ProjectError, describePrice, loadProject, projectPath, saveProject } from '../lib/project.js';

/** Compares two catalogues by SKU: what was added, removed, repriced or restocked. */
export function diffItems(before, after) {
  const old = new Map(before.map((i) => [i.sku, i]));
  const changes = [];
  for (const item of after) {
    const prev = old.get(item.sku);
    if (!prev) changes.push(`+ ${item.name} (${describePrice(item)})`);
    else {
      if ((prev.price ?? prev.priceFrom) !== (item.price ?? item.priceFrom)) changes.push(`~ ${item.name}: ${describePrice(prev)} -> ${describePrice(item)}`);
      if (prev.stock !== item.stock) changes.push(`~ ${item.name}: stock ${prev.stock ?? 'unknown'} -> ${item.stock ?? 'unknown'}`);
      old.delete(item.sku);
    }
  }
  for (const item of old.values()) changes.push(`- ${item.name}`);
  return changes;
}

export default {
  summary: 'Refresh prices and stock from the catalogue source',
  usage: '[--project <file>] [--file <path or URL>]',
  options: {
    project: { type: 'string', description: 'Project file (default ./gentifi.json)' },
    file: { type: 'string', description: 'Read from a different CSV file or link this time' },
  },
  async run(values, { out, err }) {
    const path = projectPath(values);
    let project;
    try {
      project = await loadProject(path);
    } catch (e) {
      if (e instanceof ProjectError) { err(e.message); return 1; }
      throw e;
    }
    const source = values.file ? { ...project.catalogue.source, file: values.file } : project.catalogue.source;
    if (!source?.file) {
      err('This project has no catalogue source to sync from. Pass --file.');
      return 1;
    }
    let imported;
    try {
      imported = await readSource(source);
    } catch (e) {
      err(`Could not read the catalogue: ${e.message}`);
      return 1;
    }
    if (!imported.items.length) {
      err(['No usable items found, so nothing was changed.', ...imported.problems.map((p) => `  - ${p}`)].join('\n'));
      return 1;
    }
    const changes = diffItems(project.catalogue.items, imported.items);
    project.catalogue = { ...project.catalogue, source, items: imported.items, updatedAt: new Date().toISOString() };
    await saveProject(path, project);
    out(changes.length ? [`Updated ${imported.items.length} items:`, ...changes.map((c) => `  ${c}`)].join('\n') : 'No changes to prices, stock or items.');
    if (imported.problems.length) out(['', 'Check these rows:', ...imported.problems.map((p) => `  ! ${p}`)].join('\n'));
    out('\nRun "gentifi build" (or restart "gentifi serve") to publish the changes.');
    return 0;
  },
};
