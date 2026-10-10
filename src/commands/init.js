import { notImplemented } from './not-implemented.js';

export const SOURCES = ['shopify', 'csv', 'woocommerce', 'booking'];

export default {
  summary: 'Import a business catalogue and create a gentifi.json project',
  usage: '--from <source> [--file <path>]',
  options: {
    from: { type: 'string', description: `Catalogue source: ${SOURCES.join(', ')}` },
    file: { type: 'string', description: 'Path to the catalogue file (for csv)' },
  },
  run(values, io) {
    if (values.from && !SOURCES.includes(values.from)) {
      io.err(`Unknown source "${values.from}". Use one of: ${SOURCES.join(', ')}`);
      return 1;
    }
    return notImplemented('init', [
      'Read products, prices, stock, services or bookings from the chosen source',
      'Collect business details: name, address, opening hours, service area',
      'Write a gentifi.json project file that every other command reads',
    ], io);
  },
};
