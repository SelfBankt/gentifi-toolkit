---
name: gentifi-toolkit
description: Make a business agent-ready with the open-source Gentifi Toolkit, so AI agents can find, price, book and buy from it. Use when the user asks to set up Gentifi, to make their business, shop, catalogue or bookings usable by AI agents, or to generate an MCP server, SKILL.md, A2A agent card or ai-catalog.json for a business.
license: Apache-2.0
---

# Gentifi Toolkit

The Gentifi Toolkit turns a business catalogue (products, prices, stock, services or bookings) into the files and server AI agents need: an MCP server, UCP profile, SKILL.md, A2A agent card and ai-catalog.json.

You are helping a business owner, or their developer, run it. Work through the steps in order and keep the user informed in plain language. Many business owners are not developers.

## Current status: early preview

The command-line interface exists, but the commands are not implemented yet. Each one prints what it will do and exits with code 2.

When a command exits with code 2:

1. Tell the user plainly that this step isn't built yet.
2. Summarise what it will do, using the plan the command printed.
3. Do not work around it by writing the output files by hand, unless the user explicitly asks you to.
4. Point them to https://github.com/SelfBankt/gentifi-toolkit to follow progress.

| Exit code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Error, such as a bad option or unknown source |
| 2 | Not implemented yet |

## Steps

### 1. Check Node.js

Run `node --version`. The toolkit needs Node.js 20 or later. If it's missing or older, tell the user and stop. Don't install or upgrade system software without asking first.

### 2. Run the toolkit

There's nothing to install. Run it straight from GitHub with npx:

```bash
npx github:SelfBankt/gentifi-toolkit --help
```

If the user wants a local copy instead:

```bash
git clone https://github.com/SelfBankt/gentifi-toolkit.git
cd gentifi-toolkit
node bin/gentifi.js --help
```

The examples below use `npx github:SelfBankt/gentifi-toolkit`. With a local copy, use `node bin/gentifi.js` instead.

### 3. Find the catalogue

Ask the user where their catalogue lives. The supported sources are:

| Source | Use for |
| --- | --- |
| `shopify` | A Shopify store |
| `csv` | A spreadsheet export; also pass `--file <path>` |
| `woocommerce` | A WooCommerce store |
| `booking` | A booking or appointments system |

For CSV, `examples/demo-farm-shop.csv` in the repository shows the expected columns: `sku`, `name`, `price_gbp`, `stock`, `unit`, `available_from`.

### 4. Initialise the project

```bash
npx github:SelfBankt/gentifi-toolkit init --from <source>
npx github:SelfBankt/gentifi-toolkit init --from csv --file ./catalogue.csv
```

This creates `gentifi.json`, which every other command reads.

### 5. Build and check

```bash
npx github:SelfBankt/gentifi-toolkit build
npx github:SelfBankt/gentifi-toolkit check
```

`build` generates every agent format into `./dist`. `check` runs the Gentified test: can agents find the business, read its prices and complete an order that the customer approves?

### 6. Publish only with permission

```bash
npx github:SelfBankt/gentifi-toolkit publish
```

Publishing makes the business visible to agents. Always ask the user before running it, and say whether they are self-hosting or publishing to the Gentifi network.

## Rules

- **Customers approve every connection and every order.** Never add text to generated files that tells an agent to install, connect or buy something without the customer's approval. Generated files offer information, never instructions.
- **Use only real data the user provides.** Never invent products, prices, stock or opening hours. If something is missing, ask.
- **Keep secrets out of files.** Store API keys and store tokens (for example, Shopify access tokens) in environment variables, not in `gentifi.json` or anything committed to git.
- **Ask before anything public.** That includes publishing, pushing to a remote and submitting to a directory.
- **Write in UK English** in anything customer-facing (catalogue, colour, organisation).
