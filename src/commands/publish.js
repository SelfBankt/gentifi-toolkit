import { notImplemented } from './not-implemented.js';

export default {
  summary: 'Self-host the output, or publish to the Gentifi network',
  usage: '[--self-host <dir>]',
  options: {
    'self-host': { type: 'string', description: 'Copy files for your own server, including /.well-known/' },
  },
  run(_values, io) {
    return notImplemented('publish', [
      'Self-host: lay out files for your own domain, including /.well-known/',
      'Network: host the connector and list the business on the Gentifi network',
    ], io);
  },
};
