import { notImplemented } from './not-implemented.js';

export default {
  summary: 'Run the Gentified test: can agents find and buy?',
  usage: '[--url <url>]',
  options: {
    url: { type: 'string', description: 'Check a published business instead of the local build' },
  },
  run(_values, io) {
    return notImplemented('check', [
      'Validate generated files against each spec',
      'Call the MCP tools as an agent would: search, price, availability, order',
      'Confirm every order path ends with the customer approving it',
    ], io);
  },
};
