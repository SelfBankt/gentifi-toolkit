import { ProjectError, loadProject, projectPath } from '../lib/project.js';
import { plural, printResults } from '../lib/report.js';
import { checkWebsite, googleProfileChecklist, websiteSnippet } from '../lib/website.js';

export default {
  summary: 'Structured data for the business\'s own website, and a check of what\'s there',
  usage: '[--check <url>] [--project <file>]',
  options: {
    check: { type: 'string', description: 'Check the business\'s website against its Gentifi data, instead of printing the snippet' },
    project: { type: 'string', description: 'Project file (default ./gentifi.json)' },
  },
  async run(values, { out, err, fetchImpl = globalThis.fetch }) {
    let project;
    try {
      project = await loadProject(projectPath(values));
    } catch (e) {
      if (e instanceof ProjectError) { err(e.message); return 1; }
      throw e;
    }
    if (!values.check) {
      out(websiteSnippet(project));
      return 0;
    }
    if (!/^https?:\/\//.test(values.check)) {
      err('--check must be a full link, such as https://www.example.co.uk');
      return 1;
    }
    const get = async (url) => {
      const res = await fetchImpl(url, { headers: { 'user-agent': 'gentifi-toolkit (website check)' }, redirect: 'follow' });
      return res.ok ? res.text() : undefined;
    };
    let html;
    try {
      html = await get(values.check);
    } catch (e) {
      err(`Could not open ${values.check}: ${e.message}`);
      return 1;
    }
    if (html === undefined) {
      err(`${values.check} didn't return a page.`);
      return 1;
    }
    const robots = await get(new URL('/robots.txt', values.check)).catch(() => undefined);
    const results = [...checkWebsite(project, { html, robots }), ...googleProfileChecklist(project)];
    out(`Website check for ${project.business.name}: ${values.check}\n`);
    const { fails, warnings } = printResults(results, out);
    out('');
    out(fails || warnings
      ? `${plural(fails + warnings, 'thing')} to fix. Run "gentifi website" for the snippet to paste into the site's <head>.`
      : 'The website tells search engines and AI assistants the same as Gentifi.');
    return fails ? 1 : 0;
  },
};
