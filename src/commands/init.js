import { access } from 'node:fs/promises';
import { notImplemented } from './not-implemented.js';
import { SOURCE_TYPES, readSource } from '../lib/catalogue.js';
import { IMPORTERS } from '../lib/imports.js';
import { ORDER_METHODS, createProject, inferOrderMethod, projectPath, saveProject, slugify } from '../lib/project.js';

export const SOURCES = [...SOURCE_TYPES, 'booking'];

const PLANS = {
  booking: ['Read services, prices and free slots from a booking system'],
};

export default {
  summary: 'Import a business catalogue and create a gentifi.json project',
  usage: '--from csv|square|shopify|woocommerce --file <path or URL> --name <business> [options]',
  options: {
    from: { type: 'string', description: `Catalogue source: ${SOURCES.join(', ')} (all but booking work today, from a file)` },
    file: { type: 'string', description: 'CSV or .xlsx file, the https link of a published Google Sheet, or a Square, Shopify or WooCommerce product export' },
    name: { type: 'string', description: 'Business name, as customers know it' },
    kind: { type: 'string', description: 'What kind of business, e.g. "Farm shop"' },
    description: { type: 'string', description: 'One line about the business, in its own words' },
    area: { type: 'string', description: 'Postcode area or district, e.g. "BS" or "BS16"' },
    website: { type: 'string', description: 'Website address' },
    phone: { type: 'string', description: 'Phone number for customers' },
    email: { type: 'string', description: 'Email address for orders and reservations' },
    hours: { type: 'string', multiple: true, description: 'Opening hours, e.g. "Mo-Fr 09:00-17:00" (repeat for each line)' },
    order: { type: 'string', description: `How customers order: ${ORDER_METHODS.join(', ')}` },
    'checkout-url': { type: 'string', description: 'Checkout link; {sku} and {quantity} are filled in for single items' },
    'booking-url': { type: 'string', description: 'Booking page link' },
    'base-url': { type: 'string', description: 'Where the files will live (default http://localhost:8787, for testing)' },
    'short-url': { type: 'string', description: 'Short link for printed signs, such as https://gentifi.com/b/your-business' },
    project: { type: 'string', description: 'Project file (default ./gentifi.json)' },
    force: { type: 'boolean', description: 'Replace an existing project file' },
  },
  async run(values, { out, err }) {
    if (!values.from) {
      err(`Choose where the catalogue comes from with --from (${SOURCES.join(', ')}).`);
      return 1;
    }
    if (!SOURCES.includes(values.from)) {
      err(`Unknown source "${values.from}". Use one of: ${SOURCES.join(', ')}`);
      return 1;
    }
    if (PLANS[values.from]) {
      return notImplemented(`init --from ${values.from}`, [
        ...PLANS[values.from],
        'Until then: export a spreadsheet and use --from csv',
      ], { err });
    }
    if (!values.file) {
      err(IMPORTERS[values.from]
        ? `Pass the export with --file. ${IMPORTERS[values.from].export}.`
        : 'Pass the catalogue with --file: a CSV or Excel file, or the link of a Google Sheet published as CSV.');
      return 1;
    }
    if (!values.name?.trim()) {
      err('Pass the business name with --name "Your Business". The toolkit never guesses business details.');
      return 1;
    }
    if (values.order && !ORDER_METHODS.includes(values.order)) {
      err(`Unknown ordering method "${values.order}". Use one of: ${ORDER_METHODS.join(', ')}`);
      return 1;
    }
    if (values['short-url'] && !/^https:\/\/[^/]+/.test(values['short-url'])) {
      err('--short-url must be a full https address, such as https://gentifi.com/b/your-business');
      return 1;
    }
    if (values['base-url'] && !/^https?:\/\/[^/]+/.test(values['base-url'])) {
      err('--base-url must be a full address, such as https://yourshop.co.uk');
      return 1;
    }
    if (!slugify(values.name)) {
      err('The business name needs at least one letter or number.');
      return 1;
    }

    const path = projectPath(values);
    if (!values.force && await access(path).then(() => true, () => false)) {
      err(`${path} already exists. Use "gentifi sync" to refresh the catalogue, or --force to start again.`);
      return 1;
    }

    const source = { type: values.from, file: values.file };
    let imported;
    try {
      imported = await readSource(source);
    } catch (e) {
      err(`Could not read the catalogue: ${e.message}`);
      return 1;
    }
    const { items, problems } = imported;
    if (!items.length) {
      err(['No usable items found.', ...problems.map((p) => `  - ${p}`), 'Each row needs at least a name and a price.'].join('\n'));
      return 1;
    }

    const project = createProject({
      business: {
        name: values.name.trim(),
        kind: values.kind,
        description: values.description,
        area: values.area,
        website: values.website,
        telephone: values.phone,
        email: values.email,
        openingHours: values.hours,
      },
      ordering: {
        method: inferOrderMethod({ method: values.order, checkoutUrl: values['checkout-url'], bookingUrl: values['booking-url'], email: values.email, telephone: values.phone }),
        checkoutUrl: values['checkout-url'],
        bookingUrl: values['booking-url'],
      },
      items,
      source,
      baseUrl: values['base-url'],
      shortUrl: values['short-url'],
    });
    await saveProject(path, project);

    out(`Created ${path} for ${project.business.name}: ${items.length} item${items.length === 1 ? '' : 's'} from ${values.file}.`);
    if (problems.length) out(['', 'Check these rows:', ...problems.map((p) => `  ! ${p}`)].join('\n'));
    out([
      '',
      'Next:',
      '  gentifi check    see what agents can do, and what\'s missing',
      '  gentifi build    write the files agents read',
      '  gentifi serve    run the MCP connector locally to try it with your agent',
    ].join('\n'));
    return 0;
  },
};
