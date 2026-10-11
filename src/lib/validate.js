import { SERVER_CARD_SCHEMA } from './outputs.js';

/**
 * Validators for the published formats. Each returns a list of results:
 * { level: 'pass' | 'warn' | 'fail' | 'info', text }.
 */

const pass = (text) => ({ level: 'pass', text });
const warn = (text) => ({ level: 'warn', text });
const fail = (text) => ({ level: 'fail', text });

export const URN = /^urn:air:([a-z0-9.-]+|\[[0-9a-f:]+\]):([^:\s]+):(\S+)$/i;

/** ARD v0.91 manifest: { entries: [...] } with identifier, displayName, type and one of url/data. */
export function validateArdManifest(manifest, { expectHost } = {}) {
  const out = [];
  if (!manifest || !Array.isArray(manifest.entries) || !manifest.entries.length) {
    return [fail('Discovery manifest needs an "entries" list with at least one entry')];
  }
  manifest.entries.forEach((e, i) => {
    const label = e?.displayName ? `"${e.displayName}"` : `entry ${i + 1}`;
    const problems = [];
    const urn = URN.exec(e?.identifier ?? '');
    if (!urn) problems.push('identifier must be a URN like urn:air:<domain>:<namespace>:<name>');
    else if (expectHost && urn[1].toLowerCase() !== expectHost.toLowerCase()) problems.push(`identifier publisher "${urn[1]}" should be the domain that serves it (${expectHost})`);
    if (!e?.displayName) problems.push('displayName is required');
    if (!e?.type || !/^[a-z]+\/[a-z0-9.+-]+$/i.test(e.type)) problems.push('type must be a media type');
    const hasUrl = typeof e?.url === 'string';
    const hasData = e?.data !== undefined;
    if (hasUrl === hasData) problems.push('needs exactly one of url or data');
    if (hasUrl && !/^https?:\/\//.test(e.url)) problems.push('url must be absolute');
    if (problems.length) out.push(fail(`${label}: ${problems.join('; ')}`));
    else out.push(pass(`${label} (${e.type})`));
    const q = e?.representativeQueries;
    if (!Array.isArray(q) || q.length < 2 || q.length > 5) out.push(warn(`${label}: ARD recommends 2 to 5 representativeQueries`));
  });
  return out;
}

/** MCP Server Card, v1 schema (SEP-2127). */
export function validateServerCard(card) {
  const problems = [];
  if (card?.$schema !== SERVER_CARD_SCHEMA) problems.push(`$schema should be ${SERVER_CARD_SCHEMA}`);
  if (typeof card?.name !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(card.name) || card.name.length < 3 || card.name.length > 200) {
    problems.push('name must look like namespace/server');
  }
  if (typeof card?.version !== 'string' || !card.version || /^[\^~]|[*<>=|\s]|(^|\.)x(\.|$)/i.test(card.version)) problems.push('version must be a single version, not a range');
  if (typeof card?.description !== 'string' || card.description.length < 1 || card.description.length > 100) problems.push('description must be 1 to 100 characters');
  const remotes = Array.isArray(card?.remotes) ? card.remotes : [];
  if (!remotes.length) problems.push('remotes should list the MCP endpoint');
  for (const r of remotes) {
    if (!['streamable-http', 'sse'].includes(r?.type)) problems.push(`remote type "${r?.type}" is not streamable-http or sse`);
    if (!/^(https?:\/\/|\{)/.test(r?.url ?? '')) problems.push('remote url must be http(s)');
  }
  return problems.length ? [fail(`Server card: ${problems.join('; ')}`)] : [pass(`Server card ${card.name}`)];
}

/** Agent Skills frontmatter rules from agentskills.io/specification. */
export function validateSkill(text) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text ?? '');
  if (!fm) return [fail('SKILL.md has no YAML frontmatter')];
  const field = (k) => {
    const m = new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(fm[1]);
    if (!m) return undefined;
    const raw = m[1].trim();
    try {
      return raw.startsWith('"') ? JSON.parse(raw) : raw;
    } catch {
      return raw;
    }
  };
  const problems = [];
  const name = field('name');
  if (!name || name.length > 64 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    problems.push('name must be 1 to 64 lower-case letters, numbers and single hyphens');
  }
  const description = field('description');
  if (!description || description.length > 1024) problems.push('description must be 1 to 1024 characters');
  return problems.length ? [fail(`SKILL.md: ${problems.join('; ')}`)] : [pass(`SKILL.md "${name}"`)];
}
