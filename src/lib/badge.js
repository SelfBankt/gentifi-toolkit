import { worksWith } from './apps.js';
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

/** The Gentifi mark on its own, for pages and reports. */
export const markSvg = (color, size = 28) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="${size}" height="${size}" aria-hidden="true">${MARK(color, 10)}</svg>`;

/**
 * The window sticker: Gentifi mark and wordmark, "Agent-ready business", and a
 * scannable code for the business's own link. 1000 x 1000 units, prints at any size.
 */
export function badgeSvg({ businessName, link }) {
  const qr = encodeQr(link, { level: 'M' });
  const n = qr.size + 8; // modules including the quiet zone
  const shown = link.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const label = `Gentifi window sticker for ${businessName}: scan to add us to your AI assistant (${shown})`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" role="img" aria-labelledby="t">
<title id="t">${escapeXml(label)}</title>
<rect x="1" y="1" width="998" height="998" rx="87" fill="${TEAL}" stroke="${TEAL_LINE}" stroke-width="2"/>
<g transform="translate(87 87) scale(1.75)">${MARK(COPPER, 9)}</g>
<text x="87" y="452" font-family="${SANS}" font-weight="700" font-size="150" fill="${WHITE}" textLength="487" lengthAdjust="spacingAndGlyphs">Gentifi</text>
<g transform="translate(604 342) scale(5)"><circle cx="12" cy="12" r="11" fill="${COPPER}"/><path d="M6.5 12.5 L10.5 16.5 L17.5 8" fill="none" stroke="${TEAL}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></g>
<text x="87" y="542" font-family="${SANS}" font-weight="600" font-size="64" fill="${COPPER}" textLength="640" lengthAdjust="spacingAndGlyphs">Agent-ready business</text>
<line x1="87" y1="608" x2="913" y2="608" stroke="${TEAL_LINE}" stroke-width="2"/>
<text font-family="${SANS}" font-weight="600" font-size="40" fill="${WHITE}"><tspan x="87" y="690">Scan to add us to</tspan><tspan x="87" y="740">your AI assistant</tspan></text>
${monoText(worksWith(), { x: 87, y: 798, size: 24, fill: COPPER, maxWidth: 500 })}
${monoText(businessName, { x: 87, y: 850, size: 28, fill: WHITE, maxWidth: 500 })}
${monoText(shown, { x: 87, y: 890, size: 22, fill: MUTED, maxWidth: 500 })}
<rect x="640" y="640" width="273" height="273" rx="30" fill="${WHITE}"/>
<svg x="652" y="652" width="249" height="249" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><path fill="${TEAL}" d="${qrPath(qr)}"/></svg>
</svg>
`;
}

function centredText(text, { y, size, fill, weight = 400, font = SANS, maxWidth = 900, x = 525 }) {
  const natural = text.length * size * (font === MONO ? 0.6 : 0.55);
  const fit = natural > maxWidth ? ` textLength="${maxWidth}" lengthAdjust="spacingAndGlyphs"` : '';
  return `<text x="${x}" y="${y}" text-anchor="middle" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}"${fit}>${escapeXml(text)}</text>`;
}

/**
 * The Gentifi connector covers every business, so the card tells customers to ask by name.
 * Long names fall back to a shorter line so the text isn't squeezed.
 */
function askLine(businessName) {
  const question = `Then ask: “What has ${businessName} got today?”`;
  return question.length <= 56 ? question : 'Then ask your AI about us by name.';
}

/**
 * The counter card for the till: A6 portrait (105 x 148 mm), white, with a large
 * scannable code. 1050 x 1480 units, ten to the millimetre.
 */
export function counterCardSvg({ businessName, link }) {
  const qr = encodeQr(link, { level: 'M' });
  const n = qr.size + 8;
  const shown = link.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const label = `Gentifi counter card for ${businessName}: scan to add us to your AI assistant (${shown})`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1050 1480" role="img" aria-labelledby="t">
<title id="t">${escapeXml(label)}</title>
<rect x="2" y="2" width="1046" height="1476" rx="60" fill="${WHITE}" stroke="${TEAL}" stroke-width="4"/>
<g transform="translate(330 70) scale(0.95)">${MARK(TEAL, 10)}</g>
<text x="460" y="155" font-family="${SANS}" font-weight="700" font-size="76" fill="${TEAL}">Gentifi</text>
<g transform="translate(722 98) scale(2.6)"><circle cx="12" cy="12" r="11" fill="${COPPER}"/><path d="M6.5 12.5 L10.5 16.5 L17.5 8" fill="none" stroke="${TEAL}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></g>
${centredText('Ask your AI about us', { y: 320, size: 84, weight: 700, fill: TEAL })}
${centredText('Scan to add', { y: 410, size: 42, fill: TEAL })}
${centredText(businessName, { y: 468, size: 48, weight: 700, fill: TEAL })}
${centredText('to your AI assistant.', { y: 526, size: 42, fill: TEAL })}
${centredText(askLine(businessName), { y: 584, size: 34, fill: '#3D4A5C' })}
<rect x="225" y="640" width="600" height="600" rx="44" fill="${TEAL}"/>
<rect x="245" y="660" width="560" height="560" rx="28" fill="${WHITE}"/>
<svg x="265" y="680" width="520" height="520" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><path fill="${TEAL}" d="${qrPath(qr)}"/></svg>
${centredText(shown, { y: 1310, size: 32, font: MONO, fill: TEAL })}
${centredText(worksWith(), { y: 1374, size: 30, font: MONO, fill: TEAL })}
${centredText('Nothing is added or ordered without your OK.', { y: 1432, size: 28, fill: '#3D4A5C' })}
</svg>
`;
}

/** An A4 page with each sign at its real size, for printing or saving as a PDF. */
export function signsHtml({ businessName, link }) {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gentifi signs for ${escapeXml(businessName)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  body { font-family: ${SANS}; color: ${TEAL}; margin: 24px; }
  .help { max-width: 40rem; margin-bottom: 24px; line-height: 1.5; }
  .sign { page-break-after: always; break-after: page; display: grid; gap: 8px; justify-items: start; margin-bottom: 32px; }
  .sign:last-child { page-break-after: auto; break-after: auto; }
  .sign svg { display: block; }
  .window svg { width: 150mm; height: 150mm; }
  .counter svg { width: 105mm; height: 148mm; }
  .size { font-family: ${MONO}; font-size: 12px; color: #3D4A5C; }
  @media print { .help { display: none; } body { margin: 0; } }
</style>
</head>
<body>
<div class="help">
  <h1>Gentifi signs for ${escapeXml(businessName)}</h1>
  <p>Print at 100% (no "fit to page"), or save as a PDF for a print shop. The window sticker is 150 mm square and the counter card is A6. Both codes open ${escapeXml(link)}, where customers add you to their own AI assistant and approve it in their own app.</p>
</div>
<section class="sign window">${badgeSvg({ businessName, link })}<span class="size">Window sticker, 150 x 150 mm</span></section>
<section class="sign counter">${counterCardSvg({ businessName, link })}<span class="size">Counter card, A6 (105 x 148 mm)</span></section>
</body>
</html>
`;
}
