import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { businessProfile } from '../lib/profile.js';
import { ProjectError, loadProject, projectPath } from '../lib/project.js';

export default {
  summary: 'Write the business as a Gentifi Business Profile (draft 0.1)',
  usage: '[--out <file>] [--project <file>]',
  options: {
    out: { type: 'string', description: 'File to write (default: print it)' },
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
    const json = `${JSON.stringify(businessProfile(project), null, 2)}\n`;
    if (!values.out) {
      out(json.trimEnd());
      return 0;
    }
    await writeFile(resolve(values.out), json);
    out(`Wrote ${values.out}: a Gentifi Business Profile (draft 0.1) for ${project.business.name}.`);
    out('Check it with gentifi-validate from github.com/SelfBankt/gentifi-profile.');
    return 0;
  },
};
