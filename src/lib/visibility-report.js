import { escapeXml as e, markSvg } from './badge.js';

/**
 * A one-page "How AI sees your business" report from a website check, to send
 * to a business before a first conversation. Plain words, no scores or
 * invented numbers: only what the check found on their own site.
 */

const MEANING = {
  pass: 'Good',
  warn: 'Worth fixing',
  fail: 'Needs fixing',
};

export function visibilityReport({ name, url, results, date = new Date(), contact = 'gentifiai@gmail.com' }) {
  const site = results.filter((r) => r.group === 'Your website');
  const profile = results.filter((r) => r.level === 'info');
  const toFix = site.filter((r) => r.level !== 'pass').length;
  const when = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const row = (r) => `<li class="${r.level}"><span class="tag">${MEANING[r.level]}</span><span>${e(r.text)}</span></li>`;
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>How AI sees ${e(name)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Sora, system-ui, -apple-system, 'Segoe UI', sans-serif; color: #05414D; background: #fff; font-size: 10pt; line-height: 1.5; }
  .page { max-width: 210mm; min-height: 296mm; margin: 0 auto; padding: 0 16mm 10mm; display: flex; flex-direction: column; overflow: hidden; }
  header { background: #05414D; color: #fff; margin: 0 -16mm 8mm; padding: 11mm 16mm 9mm; }
  .brand { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 13pt; }
  .eyebrow { color: #F09A5C; font-family: ui-monospace, Menlo, monospace; font-size: 8pt; letter-spacing: .08em; text-transform: uppercase; margin: 7mm 0 2mm; }
  h1 { font-size: 22pt; line-height: 1.1; margin: 0 0 3mm; }
  .lede { color: #B8C4D3; margin: 0; max-width: 160mm; }
  h2 { font-size: 12pt; margin: 0 0 3mm; }
  section { margin-bottom: 7mm; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 2.5mm; }
  li { display: grid; grid-template-columns: 28mm 1fr; gap: 4mm; align-items: start; }
  .tag { font-size: 8pt; font-weight: 600; border-radius: 99px; padding: 1px 8px; text-align: center; }
  .pass .tag { background: #E9EDF2; color: #05414D; }
  .warn .tag { background: #FCE6D6; color: #8A4A1C; }
  .fail .tag { background: #05414D; color: #F09A5C; }
  .profile li { grid-template-columns: 5mm 1fr; }
  .profile li::before { content: '\\2610'; color: #3D4A5C; }
  .why { background: #E9EDF2; border-radius: 10px; padding: 5mm 6mm; }
  .why p { margin: 0 0 2mm; }
  .why p:last-child { margin: 0; }
  .next { background: #05414D; color: #fff; border-radius: 10px; padding: 5mm 6mm; }
  .next b { color: #F09A5C; }
  footer { margin-top: auto; padding-top: 5mm; border-top: 1px solid #E9EDF2; display: flex; justify-content: space-between; font-size: 8.5pt; color: #3D4A5C; }
  @media print { .page { height: 296mm; } }
</style>
</head>
<body>
<div class="page">
<header>
  <div class="brand">${markSvg('#F09A5C', 26)}Gentifi</div>
  <p class="eyebrow">AI visibility check · ${e(when)}</p>
  <h1>How AI sees ${e(name)}</h1>
  <p class="lede">When someone asks ChatGPT, Claude, Google or Perplexity about a local business, they lean on the business's own website and its Google profile. We checked what ${e(url.replace(/^https?:\/\//, '').replace(/\/$/, ''))} tells them today.</p>
</header>
<section>
  <h2>${toFix ? `What we found: ${toFix} thing${toFix === 1 ? '' : 's'} worth fixing` : 'What we found: your website is in good shape'}</h2>
  <ul>${site.map(row).join('')}</ul>
</section>
<section class="why">
  <h2>Why it matters</h2>
  <p>AI assistants answer from what they can read. If your website doesn't say clearly that you're a local shop, where you are and when you're open, they may leave you out, or guess.</p>
  <p>Structured data is a short, invisible block in your website that states those facts in a form every search engine and AI can read. It takes minutes to add, and it doesn't change how your site looks.</p>
</section>
<section class="profile">
  <h2>Worth checking on your Google Business Profile</h2>
  <ul>${profile.map((r) => `<li><span>${e(r.text)}</span></li>`).join('')}</ul>
</section>
<section class="next">
  <b>How Gentifi helps.</b> We write the structured data for your website, put your products and prices into Claude, ChatGPT, Gemini and Grok so customers can ask about them, and give you signs that let customers add you in a scan. You keep your own till and checkout.
</section>
<footer><span>${e(contact)}</span><span>gentifi.com</span></footer>
</div>
</body>
</html>
`;
}
