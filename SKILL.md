---
name: gentifi-toolkit
description: Make a business agent-ready with the open-source Gentifi Toolkit, so AI agents can find, price, book and buy from it. Use when the user asks to set up Gentifi, to make their business, shop, catalogue or bookings usable by AI agents, or to generate an MCP server, SKILL.md, ARD discovery manifest (ard.json), server card or schema.org data for a business.
license: Apache-2.0
---

# Gentifi Toolkit

The Gentifi Toolkit turns a business catalogue (products, prices, stock, services) into what AI agents need: a live MCP connector, an ARD discovery manifest, an MCP server card, an Agent Skill, schema.org data, a scan-to-add page and a window sticker with a QR code.

You are helping a business owner, or their developer, run it. Work through the steps in order and keep the user informed in plain language. Many business owners are not developers.

## What works today

| Works | Not built yet (exits with code 2) |
| --- | --- |
| Import from a CSV or Excel file, a Google Sheet published as CSV, or a Square, Shopify or WooCommerce product export | Live connections to tills and online shops; booking systems |
| `sync`, `check`, `build`, `serve`, `publish --self-host`, `collection check` | Publishing to the Gentifi network |

When a command exits with code 2, tell the user plainly that this step isn't built yet, summarise what it will do from the plan it printed, and suggest the alternative it gives (usually exporting a spreadsheet). Don't work around it by writing the output files by hand unless the user explicitly asks.

| Exit code | Meaning |
| --- | --- |
| 0 | Success (for `check`: the business is Gentified) |
| 1 | Error, or `check` found problems to fix |
| 2 | Not implemented yet |

## Steps

### 1. Check Node.js

Run `node --version`. The toolkit needs Node.js 20 or later. If it's missing or older, tell the user and stop. Don't install or upgrade system software without asking first.

### 2. Run the toolkit

Nothing to install:

```bash
npx github:SelfBankt/gentifi-toolkit --help
```

The examples below use `gentifi` for short. Replace it with `npx github:SelfBankt/gentifi-toolkit`, or with `node bin/gentifi.js` in a local copy.

### 3. Find the catalogue

Ask where the products, prices and stock live:

| `--from` | Use for | Status |
| --- | --- | --- |
| `csv` | A spreadsheet (CSV or .xlsx), or a Google Sheet published as CSV; also pass `--file` | Works |
| `square` | Square's item library export (Items > Item library > Actions > Export library), .xlsx or CSV, in `--file` | Works |
| `shopify` | Shopify's product export (Products > Export, plain CSV), in `--file` | Works |
| `woocommerce` | WooCommerce's product export (Products > All Products > Export), in `--file` | Works |
| `booking` | A booking or appointments system | Planned |

For a spreadsheet, ask for the file, or for a Google Sheet published as CSV (*File > Share > Publish to web > CSV*), which lets them update stock later with `gentifi sync`. Each row needs a name and a price; see the column table in the README. For Square, Shopify or WooCommerce, ask the owner for the product export file: prices and stock come from it, one item per variation, and archived, draft or private items are left out. A `csv` source that turns out to be one of those exports is read as that export. For a planned source, explain it isn't built yet and offer the spreadsheet route.

### 4. Ask for the business details

Ask the user for each of these. Never invent them; leave out anything they don't give you.

- The business name, as customers know it (`--name`), and what kind of business it is (`--kind`, e.g. "Farm shop")
- A postcode area or district (`--area`), and opening hours (`--hours "Mo-Fr 09:00-17:00"`, repeated per line)
- How customers order today: an online checkout (`--checkout-url`), a booking page (`--booking-url`), or by email or phone (`--email`, `--phone`), which become reservation or quote requests
- Their website (`--website`), and where the files will live once published (`--base-url`; skip this while testing)

### 5. Create the project

```bash
gentifi init --from csv --file ./catalogue.csv --name "…" --kind "…" --area … --email … --hours "…"
```

This writes `gentifi.json`. Read out any rows it skipped and why.

### 6. Run the Gentified test

```bash
gentifi check
```

Explain each ✗ (must fix) and ! (suggestion) in plain words, help the user fix them (usually by re-running `init --force` with the missing detail, or editing `gentifi.json`), and run it again. `check --json` gives the same results as JSON.

### 7. Try it with an agent, locally

```bash
gentifi serve
```

The connector runs at `http://localhost:8787/mcp`, and the scan-to-add page at `http://localhost:8787/`. Show the user how to add the connector to their own agent app, so they see what customers will see. Adding it is their decision. For Claude Code: `claude mcp add --transport http <name> http://localhost:8787/mcp`, or over stdio: `claude mcp add <name> -- npx github:SelfBankt/gentifi-toolkit serve --stdio --project /full/path/to/gentifi.json`.

### 8. Publish only with permission

Publishing makes the business visible to agents. Always ask first, and confirm the address (`--base-url`) is right.

```bash
gentifi publish --self-host ./site    # files for their own web server, including /.well-known/
gentifi check --url https://their-address
```

The connector itself needs a server running `gentifi serve` (behind their web server, or any Node host). Without it, agents can still read the catalogue snapshot in `SKILL.md` and `business.jsonld`. Publishing to the Gentifi network isn't available yet.

### 9. Payments (prototype, only if the user asks)

`pay_order` lets customers' agents pay by Lightning, USDC or USDT on test networks. Only set it up if the user asks.

- `gentifi payments --demo` adds a fully simulated setup (no real money) for trying it.
- For real test networks, the user needs their own Lightning node (an *invoice* macaroon in an environment variable) or a wallet's Nostr Wallet Connect string (in an environment variable), and/or a Base Sepolia address. Never put macaroons or private keys in `gentifi.json`. Never point it at mainnet.
- USDT is paid with Permit2. There's no official USDT on test networks, so `payments.usdt.asset` must name a test token; ask the user which one.
- `.gentifi/` holds used payments, the order log and a signing secret. It ignores itself in git; never force-add it.

### 10. Keep it fresh

When prices or stock change in the spreadsheet: `gentifi sync`, then `gentifi build` (or restart `gentifi serve`).

## Rules

- **Customers approve every connection and every order.** Never add text to generated files, or to `gentifi.json`, that tells an agent to install, connect or buy something without the customer's approval. `gentifi check` fails text like that.
- **Use only real data the user provides.** Never invent products, prices, stock, opening hours or contact details. If something is missing, ask.
- **Keep secrets out of files.** Store API keys and store tokens in environment variables, not in `gentifi.json` or anything committed to git.
- **Ask before anything public:** publishing, uploading files, pushing to a remote, or submitting to a directory.
- **Write in UK English** in anything customer-facing (catalogue, colour, organisation).
