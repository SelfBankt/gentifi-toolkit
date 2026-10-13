import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHost } from '../src/lib/host.js';
import { createStats, isBot, readStats } from '../src/lib/stats.js';
import { McpHttpClient } from '../src/mcp/client.js';
import { saveProject } from '../src/lib/project.js';
import statsCommand from '../src/commands/stats.js';
import { demoProject, withTempDir } from './helpers.js';

const BROWSER = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';

test('the host counts page opens, AI questions and search appearances, and nothing else', async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, 'hollow-lane'));
    await saveProject(join(dir, 'hollow-lane', 'gentifi.json'), demoProject());
    const stats = createStats({ dir });
    let host;
    const server = createServer((req, res) => host.handle(req, res));
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      host = createHost({ dir, baseUrl: url, stats });
      await host.scan();
      await fetch(`${url}/b/hollow-lane/`, { headers: { 'user-agent': BROWSER } });
      await fetch(`${url}/b/hollow-lane/`, { headers: { 'user-agent': BROWSER } });
      await fetch(`${url}/b/hollow-lane/`, { headers: { 'user-agent': 'Googlebot/2.1' } });
      await fetch(`${url}/b/hollow-lane/ard.json`, { headers: { 'user-agent': BROWSER } });

      const own = new McpHttpClient(`${url}/b/hollow-lane/mcp`);
      await own.connect();
      await own.request('tools/call', { name: 'get_business_info', arguments: {} });
      const network = new McpHttpClient(`${url}/mcp`);
      await network.connect();
      await network.request('tools/call', { name: 'find_businesses', arguments: { query: 'eggs' } });
      await network.request('tools/call', { name: 'search_catalogue', arguments: { business: 'hollow-lane', query: 'eggs' } });
      await fetch(`${url}/ask?query=eggs`);

      await stats.flush();
      const saved = JSON.parse(await readFile(join(dir, 'hollow-lane', 'stats.json'), 'utf8'));
      const day = Object.values(saved.days)[0];
      assert.deepEqual(day, { pageViews: 2, toolCalls: 2, searchAppearances: 2 }, 'people only, not crawlers or other files');
      assert.doesNotMatch(JSON.stringify(saved), /eggs|Mozilla|127\.0\.0\.1/, 'only numbers are kept');

      stats.count('hollow-lane', 'pageViews');
      await stats.flush();
      assert.deepEqual((await readStats(dir))[0], { slug: 'hollow-lane', pageViews: 3, toolCalls: 2, searchAppearances: 2 }, 'flushes add up');

      const lines = [];
      assert.equal(await statsCommand.run({ dir }, { out: (l) => lines.push(l), err: (l) => lines.push(l) }), 0);
      assert.match(lines.join('\n'), /hollow-lane\s+3\s+2\s+2/);
    } finally {
      server.close();
    }
  });
});

test('crawlers and scripts are not people', () => {
  for (const ua of ['Googlebot/2.1', 'facebookexternalhit/1.1', 'WhatsApp/2.23.20.0', 'Slackbot-LinkExpanding 1.0', 'curl/8.4.0', 'python-requests/2.31', '', undefined]) assert.equal(isBot(ua), true, ua);
  assert.equal(isBot(BROWSER), false);
});
