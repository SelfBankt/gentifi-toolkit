/**
 * AI apps that printed signs and scan pages name ("Works in … today"). Claude
 * and ChatGPT are tested end to end; Gemini was added on 15 October 2026 and
 * tested from the UK on 21 October 2026. Grok was added and tested on 23 October
 * 2026.
 */
export const TESTED_APPS = ['Claude', 'ChatGPT', 'Gemini', 'Grok'];

/** Apps whose add steps scan and event pages show. */
export const ADD_APPS = TESTED_APPS;

/** How a customer adds a connector in each tested app, in plain words. */
export const ADD_STEPS = {
  Claude: 'Settings → Connectors → Add custom connector. Paste the link.',
  ChatGPT: 'In a browser, not the app: chatgpt.com/plugins → Add (top right) → Add custom MCP server. Paste the link, no authentication. Then type @ in a chat to pick it.',
  Gemini: 'On a computer: gemini.google.com/app → Settings → Connected Apps → Custom apps → add. Paste the link, click Next and follow the steps. Then type @ in a chat to pick it. It works in the Gemini phone app once added.',
  Grok: 'grok.com/connectors → New Connector → Custom. Paste the link, no authentication. Then ask about the shop in any chat.',
};

/**
 * Links that open each tested app with a question already typed in. Neither app documents
 * these, so the scan page always offers "Copy question" as well.
 */
export const ASK_LINKS = {
  Claude: (q) => `https://claude.ai/new?q=${encodeURIComponent(q)}`,
  ChatGPT: (q) => `https://chatgpt.com/?q=${encodeURIComponent(q)}`,
};

const list = (apps) => (apps.length === 1 ? apps[0] : `${apps.slice(0, -1).join(', ')} and ${apps.at(-1)}`);

/** "Works in Claude, ChatGPT, Gemini and Grok today" */
export const worksWith = (apps = TESTED_APPS) => `Works in ${list(apps)} today`;
