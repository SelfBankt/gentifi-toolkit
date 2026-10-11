const ICONS = { pass: '✓', warn: '!', fail: '✗', info: 'i' };

/**
 * Prints results grouped under headings, then a one-line verdict.
 * @param {Array<{ group?: string, level: string, text: string }>} results
 * @returns {{ fails: number, warnings: number }}
 */
export function printResults(results, out) {
  let group;
  for (const r of results) {
    if (r.group && r.group !== group) {
      if (group !== undefined) out('');
      group = r.group;
      out(group);
    }
    out(`  ${ICONS[r.level] ?? '-'} ${r.text}`);
  }
  return {
    fails: results.filter((r) => r.level === 'fail').length,
    warnings: results.filter((r) => r.level === 'warn').length,
  };
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
