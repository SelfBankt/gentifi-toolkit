import { ProjectError, loadProject, projectPath } from '../lib/project.js';
import { plural, printResults } from '../lib/report.js';
import { writeFile } from 'node:fs/promises';
import { checkWebsite, googleProfileChecklist, websiteSnippet } from '../lib/website.js';
import { visibilityReport } from '../lib/visibility-report.js';

export default {
  summary: 'Structured data for the business\'s own website, and a check of what\'s there',
  usage: '[--check <url> [--report <file.html>] [--name <business>]] [--project <file>]',
  options: {
    check: { type: 'string', description: 'Check the business\'s website against its Gentifi data, instead of printing the snippet' },
    report: { type: 'string', description: 'With --check, also write a one-page "How AI sees your business" report (HTML, print to PDF)' },
    name: { type: 'string', description: 'With --check, the business name, for a business without a gentifi.json yet' },
    project: { type: 'string', description: 'Project file (default ./gentifi.json)' },
  },
  async run(values, { out, err, fetchImpl = globalThis.fetch }) {
    let project;
    if (values.check && values.name) {
      // A prospect: nothing to compare against except the name
      project = { business: { name: values.name, website: values.check }, catalogue: { items: [] }, publish: {} };
    } else {
      try {
        project = await loadProject(projectPath(values));
      } catch (e) {
        if (e instanceof ProjectError) { err(values.check ? `${e.message} For a business that isn't on Gentifi yet, give its name with --name.` : e.message); return 1; }
        throw e;
      }
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
    if (values.report) {
      await writeFile(values.report, visibilityReport({ name: project.business.name, url: values.check, results }));
      out(`\nWrote the report to ${values.report}: open it in a browser and print or save it as a PDF.`);
    }
    out('');
    out(fails || warnings
      ? `${plural(fails + warnings, 'thing')} to fix. Run "gentifi website" for the snippet to paste into the site's <head>.`
      : 'The website tells search engines and AI assistants the same as Gentifi.');
    return fails ? 1 : 0;
  },
};
