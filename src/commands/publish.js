import { resolve } from 'node:path';
import { notImplemented } from './not-implemented.js';
import { writeOutputs } from './build.js';
import { generateOutputs } from '../lib/outputs.js';
import { ProjectError, baseUrl, isLocalUrl, loadProject, mcpUrl, projectPath } from '../lib/project.js';
import { VERSION } from '../lib/version.js';

export default {
  summary: 'Self-host the output, or publish to the Gentifi network',
  usage: '--self-host <dir> [--project <file>]',
  options: {
    'self-host': { type: 'string', description: 'Lay out the files for your own web server, including /.well-known/' },
    project: { type: 'string', description: 'Project file (default ./gentifi.json)' },
  },
  async run(values, { out, err }) {
    if (!values['self-host']) {
      return notImplemented('publish (to the Gentifi network)', [
        'Host the MCP connector and scan-to-add page at gentifi.com/b/<your-business>',
        'List the business on the Gentifi network connector',
        'Until then: gentifi publish --self-host <dir>, and gentifi serve for the connector',
      ], { err });
    }
    let project;
    try {
      project = await loadProject(projectPath(values));
    } catch (e) {
      if (e instanceof ProjectError) { err(e.message); return 1; }
      throw e;
    }
    const base = baseUrl(project);
    if (isLocalUrl(base)) {
      err(`The project points at ${base}. Set where the files will live first, e.g. --base-url https://yourshop.co.uk with "gentifi init --force", or edit publish.baseUrl in gentifi.json.`);
      return 1;
    }
    const dir = resolve(values['self-host']);
    await writeOutputs(generateOutputs(project, VERSION), dir);
    const root = new URL(base).pathname === '/';
    out([
      `Wrote the files for ${base} to ${dir}.`,
      '',
      'To publish:',
      `  1. Upload everything in ${dir} so that index.html is served at ${base}/`,
      root
        ? '     Keep the .well-known folder: agents look for /.well-known/ard.json on your domain.'
        : `     The page links to ${base}/ard.json, so agents find it without /.well-known/.`,
      `  2. Run the connector at ${mcpUrl(project)} with "gentifi serve --host 0.0.0.0" behind your web server,`,
      '     or leave it out: agents can still use the catalogue in SKILL.md and business.jsonld.',
      `  3. Print badge.svg. Its code opens ${base}`,
      `  4. Check it like an agent would: gentifi check --url ${base}`,
    ].join('\n'));
    return 0;
  },
};
