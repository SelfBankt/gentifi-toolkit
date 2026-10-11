import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { generateOutputs } from '../lib/outputs.js';
import { ProjectError, baseUrl, loadProject, mcpUrl, projectPath } from '../lib/project.js';
import { VERSION } from '../lib/version.js';

const DESCRIPTIONS = {
  'index.html': 'scan-to-add page (what the badge opens)',
  'ard.json': 'discovery manifest (ARD), linked from the page',
  '.well-known/ard.json': 'discovery manifest at the domain root',
  '.well-known/ai-catalog.json': 'same manifest at the older path some tools read',
  'mcp/server-card.json': 'MCP server card: where agents connect',
  'SKILL.md': 'Agent Skill for headless agents',
  'business.jsonld': 'schema.org data for search engines and AI search',
  'badge.svg': 'window sticker with the scannable code',
  '.well-known/agent-card.json': 'A2A agent card',
};

export async function writeOutputs(files, dir) {
  for (const [path, body] of files) {
    const target = join(dir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  }
}

export default {
  summary: 'Generate every agent format from gentifi.json',
  usage: '[--out <dir>] [--project <file>]',
  options: {
    out: { type: 'string', description: 'Output directory (default ./dist)' },
    project: { type: 'string', description: 'Project file (default ./gentifi.json)' },
  },
  async run(values, { out, err }) {
    let project;
    try {
      project = await loadProject(projectPath(values));
    } catch (e) {
      if (e instanceof ProjectError) { err(e.message); return 1; }
      throw e;
    }
    const dir = resolve(values.out ?? 'dist');
    const files = generateOutputs(project, VERSION);
    await writeOutputs(files, dir);
    const width = Math.max(...[...files.keys()].map((p) => p.length));
    out([
      `Wrote ${files.size} files to ${dir} for ${baseUrl(project)}:`,
      ...[...files.keys()].map((p) => `  ${p.padEnd(width)}  ${DESCRIPTIONS[p] ?? ''}`),
      '',
      `The MCP connector itself runs with "gentifi serve" (it will answer at ${mcpUrl(project)}).`,
      'Run "gentifi check" for the Gentified test.',
    ].join('\n'));
    return 0;
  },
};
