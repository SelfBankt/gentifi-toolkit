import { parseArgs } from 'node:util';
import init from './commands/init.js';
import sync from './commands/sync.js';
import build from './commands/build.js';
import check from './commands/check.js';
import serve from './commands/serve.js';
import publish from './commands/publish.js';
import collection from './commands/collection.js';
import payments from './commands/payments.js';
import host from './commands/host.js';
import website from './commands/website.js';
import stats from './commands/stats.js';
import profile from './commands/profile.js';
import { VERSION } from './lib/version.js';

export const commands = { init, sync, build, check, website, profile, serve, publish, host, stats, payments, collection };

export function helpText() {
  const width = Math.max(...Object.keys(commands).map((n) => n.length));
  const lines = Object.entries(commands).map(([name, cmd]) => `  ${name.padEnd(width)}  ${cmd.summary}`);
  return [
    `gentifi ${VERSION}: make a business agent-ready`,
    '',
    'Usage: gentifi <command> [options]',
    '',
    'Commands:',
    ...lines,
    '',
    'Run "gentifi <command> --help" for command options.',
  ].join('\n');
}

function commandHelp(name, cmd) {
  const opts = Object.entries(cmd.options ?? {}).map(
    ([flag, o]) => `  --${flag}${o.type === 'string' ? ' <value>' : ''}  ${o.description}`,
  );
  return [`Usage: gentifi ${name} ${cmd.usage ?? ''}`.trimEnd(), '', cmd.summary, ...(opts.length ? ['', 'Options:', ...opts] : [])].join('\n');
}

/**
 * Runs the CLI and returns an exit code.
 * @param {string[]} argv
 * @param {{ out?: (s: string) => void, err?: (s: string) => void }} io
 */
export async function main(argv, io = {}) {
  const out = io.out ?? ((s) => console.log(s));
  const err = io.err ?? ((s) => console.error(s));
  const [name, ...rest] = argv;

  if (!name || name === '--help' || name === '-h' || name === 'help') {
    out(helpText());
    return 0;
  }
  if (name === '--version' || name === '-v') {
    out(VERSION);
    return 0;
  }

  const cmd = commands[name];
  if (!cmd) {
    err(`Unknown command: ${name}\n\n${helpText()}`);
    return 1;
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: { help: { type: 'boolean', short: 'h' }, ...stripDescriptions(cmd.options) },
      allowPositionals: Boolean(cmd.positionals),
    });
  } catch (e) {
    err(`${e.message}\n\n${commandHelp(name, cmd)}`);
    return 1;
  }

  if (parsed.values.help) {
    out(commandHelp(name, cmd));
    return 0;
  }
  return cmd.run(parsed.values, { out, err }, parsed.positionals);
}

function stripDescriptions(options = {}) {
  return Object.fromEntries(Object.entries(options).map(([k, { description, ...rest }]) => [k, rest]));
}
