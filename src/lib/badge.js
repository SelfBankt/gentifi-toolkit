import { encodeQr, qrPath } from './qr.js';

// Brand tokens (see gentifi.com)
const TEAL = '#05414D';
const TEAL_LINE = '#1C5D69';
const COPPER = '#F09A5C';
const WHITE = '#FFFFFF';
const MUTED = '#B8C4D3';
const SANS = "Sora, 'Sora Local', system-ui, -apple-system, 'Segoe UI', sans-serif";
const MONO = "'IBM Plex Mono', ui-monospace, Menlo, monospace";

export function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Monospace text is about 0.6em per character; squeeze it only when it would overflow. */
function monoText(text, { x, y, size, fill, maxWidth }) {
  const natural = text.length * size * 0.6;
  const fit = natural > maxWidth ? ` textLength="${maxWidth}" lengthAdjust="spacingAndGlyphs"` : '';
  return `<text x="${x}" y="${y}" font-family="${MONO}" font-size="${size}" fill="${fill}"${fit}>${escapeXml(text)}</text>`;
}

const MARK = (color, width) => `<path d="M73 37.48 A26 26 0 1 0 73 82.52" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`
  + `<path d="M92.53 27.47 A46 46 0 1 0 106 60 L64 60" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`
  + `<circle cx="60" cy="60" r="10" fill="${color}"/>`;

/**
 * The window sticker: Gentifi mark and wordmark, "Agent-ready business", and a
 * scannable code for the business's own link. 1000 x 1000 units, prints at any size.
 */
export function badgeSvg({ businessName, link }) {
  const qr = encodeQr(link, { level: 'M' });
  const n = qr.size + 8; // modules including the quiet zone
  const shown = link.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const label = `Gentifi window sticker for ${businessName}: scan to add us to your AI agent (${shown})`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" role="img" aria-labelledby="t">
<title id="t">${escapeXml(label)}</title>
<rect x="1" y="1" width="998" height="998" rx="87" fill="${TEAL}" stroke="${TEAL_LINE}" stroke-width="2"/>
<g transform="translate(87 87) scale(1.75)">${MARK(COPPER, 9)}</g>
<text x="87" y="452" font-family="${SANS}" font-weight="700" font-size="150" fill="${WHITE}" textLength="487" lengthAdjust="spacingAndGlyphs">Gentifi</text>
<g transform="translate(604 342) scale(5)"><circle cx="12" cy="12" r="11" fill="${COPPER}"/><path d="M6.5 12.5 L10.5 16.5 L17.5 8" fill="none" stroke="${TEAL}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></g>
<text x="87" y="542" font-family="${SANS}" font-weight="600" font-size="64" fill="${COPPER}" textLength="640" lengthAdjust="spacingAndGlyphs">Agent-ready business</text>
<line x1="87" y1="608" x2="913" y2="608" stroke="${TEAL_LINE}" stroke-width="2"/>
<text font-family="${SANS}" font-weight="600" font-size="40" fill="${WHITE}"><tspan x="87" y="690">Scan to add us to</tspan><tspan x="87" y="740">your AI agent</tspan></text>
${monoText('Claude · ChatGPT · Hermes · any agent', { x: 87, y: 798, size: 24, fill: COPPER, maxWidth: 500 })}
${monoText(businessName, { x: 87, y: 850, size: 28, fill: WHITE, maxWidth: 500 })}
${monoText(shown, { x: 87, y: 890, size: 22, fill: MUTED, maxWidth: 500 })}
<rect x="640" y="640" width="273" height="273" rx="30" fill="${WHITE}"/>
<svg x="652" y="652" width="249" height="249" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><path fill="${TEAL}" d="${qrPath(qr)}"/></svg>
</svg>
`;
}
