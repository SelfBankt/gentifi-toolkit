import { notImplemented } from './not-implemented.js';

export default {
  summary: 'Generate every agent format from gentifi.json',
  usage: '[--out <dir>]',
  options: {
    out: { type: 'string', description: 'Output directory (default: ./dist)' },
  },
  run(_values, io) {
    return notImplemented('build', [
      'MCP server with search, price, availability and order tools',
      'UCP profile, plus booking or quote tools for services',
      'A2A agent card and ai-catalog.json for discovery',
      'SKILL.md for headless agents',
      'Gentified badge with a scannable "add to your agent" code',
    ], io);
  },
};
