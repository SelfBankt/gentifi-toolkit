import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));

/** The toolkit's version, from package.json. */
export const VERSION = pkg.version;
