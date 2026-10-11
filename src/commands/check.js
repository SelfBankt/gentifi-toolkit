import { checkProject, checkRemote } from '../lib/check.js';
import { ProjectError, loadProject, projectPath } from '../lib/project.js';
import { plural, printResults } from '../lib/report.js';
import { VERSION } from '../lib/version.js';

export default {
  summary: 'Run the Gentified test: can agents find and buy?',
  usage: '[--url <url>] [--project <file>] [--json]',
  options: {
    url: { type: 'string', description: 'Check a published business by its link instead of the local project' },
    project: { type: 'string', description: 'Project file (default ./gentifi.json)' },
    json: { type: 'boolean', description: 'Print results as JSON' },
  },
  async run(values, { out, err }) {
    let results;
    let title;
    if (values.url) {
      if (!/^https?:\/\//.test(values.url)) {
        err('--url must be a full link, such as https://gentifi.com/b/your-business');
        return 1;
      }
      title = values.url;
      results = await checkRemote(values.url);
    } else {
      let project;
      try {
        project = await loadProject(projectPath(values));
      } catch (e) {
        if (e instanceof ProjectError) { err(e.message); return 1; }
        throw e;
      }
      title = project.business.name;
      results = await checkProject(project, { toolkitVersion: VERSION });
    }

    const fails = results.filter((r) => r.level === 'fail').length;
    const warnings = results.filter((r) => r.level === 'warn').length;
    if (values.json) {
      out(JSON.stringify({ target: title, gentified: fails === 0, fails, warnings, results }, null, 2));
      return fails ? 1 : 0;
    }
    out(`Gentified test for ${title}\n`);
    printResults(results, out);
    out('');
    out(fails
      ? `Not Gentified yet: ${plural(fails, 'problem')} to fix${warnings ? `, ${plural(warnings, 'suggestion')}` : ''}.`
      : `Gentified ✓ Agents can find this business, read its prices and prepare orders the customer confirms.${warnings ? ` (${plural(warnings, 'suggestion')} above.)` : ''}`);
    return fails ? 1 : 0;
  },
};
