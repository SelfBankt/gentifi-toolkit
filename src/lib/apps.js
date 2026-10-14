/**
 * AI apps we have tested end to end with a hosted connector. Printed signs and
 * scan pages only promise these, so add an app here once it has been tested.
 */
export const TESTED_APPS = ['Claude', 'ChatGPT'];

/** How a customer adds a connector in each tested app, in plain words. */
export const ADD_STEPS = {
  Claude: 'Settings → Connectors → Add custom connector. Paste the link.',
  ChatGPT: 'In a browser, not the app: chatgpt.com/plugins → Add (top right) → Add custom MCP server. Paste the link, no authentication. Then type @ in a chat to pick it.',
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

/** "Works in Claude and ChatGPT today" */
export const worksWith = (apps = TESTED_APPS) => `Works in ${list(apps)} today`;
