# Gentifi Toolkit

**Turn any business catalogue into everything AI agents need to find, price, book and buy.**

The Gentifi Toolkit is open source. Point it at a catalogue and it generates what an AI agent needs to work with the business: a live MCP connector, a discovery manifest, an MCP server card, an Agent Skill, schema.org data, a scan-to-add page and a window sticker with a QR code.

It works for consumers (B2C) and business buyers (B2B) on the same rails.

> **Status: early preview (0.1).** Spreadsheets (CSV, including a Google Sheet published as CSV) work end to end. Shopify, WooCommerce and booking-system imports, and publishing to the Gentifi network, are planned: those commands say so and exit with code 2.

## Try it in a minute

Requires Node.js 20 or later. No dependencies.

```bash
npx github:SelfBankt/gentifi-toolkit init --from csv \
  --file https://raw.githubusercontent.com/SelfBankt/gentifi-toolkit/main/examples/demo-farm-shop.csv \
  --name "Hollow Lane Farm Shop" --kind "Farm shop" --area BS \
  --email orders@hollowlane.example --hours "Tu-Sa 09:00-17:00"

npx github:SelfBankt/gentifi-toolkit check    # the Gentified test
npx github:SelfBankt/gentifi-toolkit serve    # connector at http://localhost:8787/mcp
```

Then add it to an agent and ask *"Have they got eggs this week? Reserve a dozen for Saturday."* With Claude Code, for example:

```bash
claude mcp add --transport http hollow-lane http://localhost:8787/mcp
```

The agent can search the catalogue, check stock and prepare the reservation. It can't order anything: `prepare_order` returns a summary and an email link that the customer sends themselves.

## Set up with your coding agent

Paste this into Claude Code or any coding agent:

```
Set up https://raw.githubusercontent.com/SelfBankt/gentifi-toolkit/main/SKILL.md
```

[SKILL.md](SKILL.md) is an [Agent Skill](https://agentskills.io) that walks the agent through running the toolkit for your business, and asks you before anything goes public.

## Commands

```bash
gentifi init --from csv --file <path or URL> --name "…"   # import a catalogue, create gentifi.json
gentifi sync                    # refresh prices and stock from the same spreadsheet
gentifi check                   # the Gentified test: can agents find and buy?
gentifi build                   # write every agent format to ./dist
gentifi serve                   # run the MCP connector (HTTP, or --stdio)
gentifi publish --self-host <dir>   # lay out the files for your own web server
gentifi host --dir <folder> --base-url <url>   # host many businesses from one server
gentifi check --url <link>      # test a published business, the way an agent would
gentifi website [--check <url>] # snippet for the business's own site, or check what's there
gentifi website --check <url> --name "…" --report <file.html>   # one-page AI visibility report for a prospect
gentifi stats --dir <folder>    # how often each hosted business was opened, asked about and found
gentifi collection check <file or URL> [--verify]   # check a Business Collection (draft 0.2)
gentifi payments [--demo]       # agent payments by Lightning, USDC or USDT (prototype)
```

Run `gentifi <command> --help` for every option. Business details come from flags (`--name`, `--kind`, `--area`, `--hours`, `--email`, `--phone`, `--website`, `--checkout-url`, `--booking-url`, `--base-url`); the toolkit never guesses them, and `check` tells you what's missing.

### Spreadsheet columns

One row per product or service. Header names are flexible (`Price (£)` and `price_gbp` both work); comma, semicolon and tab exports all read.

| Column | Required | Example |
| --- | --- | --- |
| `name` | yes | Free-range eggs (dozen) |
| `price_gbp` (or `price`) | yes, or `price_from` | 3.20 |
| `price_from_gbp` | for quotes and services | 85 |
| `sku` | no (made from the name) | EGG-12 |
| `stock` | no | 40, or yes / no / sold out |
| `unit` | no | box |
| `category` | no | Eggs and dairy |
| `availability` | no | Baked Fri and Sat |
| `description`, `url`, `kind` (`product` or `service`) | no | |

Rows without a name or a usable price are skipped and reported, never guessed. For a Google Sheet, use *File > Share > Publish to web > CSV* and pass that link to `--file`; `gentifi sync` picks up changes.

## What it generates

| File | What it's for | Standard |
| --- | --- | --- |
| MCP connector (`gentifi serve`) | Tools agents call: `search_catalogue`, `check_availability`, `prepare_order`, `get_business_info` | [MCP](https://modelcontextprotocol.io) 2026-07-28, and 2025-11-25 clients |
| `.well-known/ard.json`, `ard.json` | Discovery: tells agents this business has a connector and a skill | [Agentic Resource Discovery](https://agenticresourcediscovery.org/spec) v0.91 |
| `.well-known/ai-catalog.json` | The same manifest at the older path some tools still read | ARD predecessor |
| `mcp/server-card.json` | Where and how to connect, before connecting | [MCP Server Cards](https://modelcontextprotocol.io/seps/2127-mcp-server-cards) v1 |
| `SKILL.md` | Instructions and a catalogue snapshot for headless agents | [Agent Skills](https://agentskills.io) |
| `business.jsonld` | The business and its offers for search engines and AI search | [schema.org](https://schema.org) |
| `website-snippet.txt` | For the business's own website: paste once into its `<head>` (also `gentifi website`) | [schema.org](https://schema.org), ARD |
| `index.html` | The scan-to-add page the badge opens | |
| `badge.svg` | Window sticker with a scannable "add to your agent" code | |
| `.well-known/agent-card.json` | Only when the business runs an A2A endpoint (`a2a.url` in gentifi.json) | [A2A](https://a2a-protocol.org) 1.0 |

A UCP profile is planned for businesses with an online checkout that implements UCP; the toolkit won't publish one that points at nothing.

## Printed signs

`gentifi build` also writes `counter-card.svg` (A6, for the till), `badge.svg` (the 150 mm window sticker) and `signs.html`, which lays both out at their real sizes on A4: print it at 100%, or save it as a PDF for a print shop. The codes open the business's page, or the short link in `publish.shortUrl` when it has one (`gentifi init --short-url https://gentifi.com/b/<business>`), so printed signs survive a move of hosting.

For bakeries and food shops, `examples/bakery-template.csv` adds allergens, dietary notes and pre-order notice. Agents get allergens exactly as given, and are told never to assume an item is free from anything when none are listed.

## The business's own website

Search engines and AI search mostly trust a business's own site, so `gentifi website` prints a snippet to paste once into its `<head>`: schema.org `LocalBusiness` data with the details that rarely change (name, address, hours, contact) and a link to the Gentifi page for products and prices, so it never goes stale when a price changes. `gentifi website --check https://their-site.example` reports what the site says today: missing or company-only markup, a name, phone number, postcode or hours that differ from Gentifi, a `robots.txt` that blocks Google, Bing, ChatGPT, Claude or Perplexity search, and what to check by hand on the Google Business Profile.

For a business that isn't on Gentifi yet, give its name instead of a project: `gentifi website --check https://their-site.example --name "Their Shop" --report report.html` writes a one-page "How AI sees your business" report to send before a first conversation. It states only what the check found; print it or save it as a PDF from a browser.

`gentifi host` also keeps anonymous daily counts for each business in `<dir>/<slug>/stats.json`: page opens by people (not crawlers or link previews), questions from AI tools, and appearances in searches. Only numbers are kept, never who, from where or what was asked. `gentifi stats --dir <folder>` prints the totals for the last 30 days (`--days` to change).

## Hosting many businesses

`gentifi host` serves every business in a folder from one process: each sub-folder is a business, named by its slug and holding its `gentifi.json`.

```bash
gentifi host --dir ./businesses --base-url https://mcp.gentifi.com
```

Each business is served under `/b/<slug>/`: its scan-to-add page, discovery files, `SKILL.md` and its connector at `/b/<slug>/mcp`. The host also serves, across every business:

- `/mcp`: the network connector. Customers add it once to reach every business; `find_businesses` finds them and the other tools take a business id or name.
- `/.well-known/mcp/server-card.json` (the network connector) and `/.well-known/mcp/server-cards.json` (it, then every business's own card).
- `/c/<event>/`: markets, shows and high streets. A settings file at `<dir>/_collections/<event>.json` (`{"name": "…", "kind": "event", "members": ["<business folder>", …], "validFrom": "2026-12-05", "validTo": "2026-12-05"}`; `kind` is event, place, association or marketplace) gives the event a page to add it, its own connector at `/c/<event>/mcp` (the network connector, limited to its members), signs (`badge.svg`, `counter-card.svg`, `signs.html`) and a Business Collections draft 0.2 document at `/c/<event>/collection.json`. Members not hosted yet are listed in the log and left out until they are.
- `/ask?query=…`: NLWeb-style natural-language search over every business's products, answered from the catalogues with no language model (non-streaming list mode; add `site=<slug>` for one business).
- `/.well-known/openai-apps-challenge`: the token in `<dir>/.openai-apps-challenge`, for ChatGPT's plugin directory.
 Every 10 minutes (`--sync-minutes`) the host re-reads each business's published Google Sheet and picks up new or changed folders. A sheet that comes back empty or broken never replaces the last good catalogue, and one broken business never stops the others. `/healthz` reports how many businesses are live.

`deploy/` sets this up on an Ubuntu or Debian VPS: `setup-vps.sh` installs Node.js and Caddy (which handles HTTPS), and runs the host as a locked-down systemd service.

On a VPS that's already set up, `deploy/install-tools.sh` adds three commands and touches nothing else: `gentifi-update` (pull the latest toolkit, restart the host and check it's healthy), `gentifi-stats` (the anonymous counts) and `gentifi-backup` (a copy of the businesses folder, also made nightly by a systemd timer and kept for 14 days in `/srv/gentifi/backups`).

## Payments through the agent (prototype)

`pay_order` lets a customer's agent pay for an order by **Lightning**, **USDC** or **USDT**, using [x402](https://github.com/x402-foundation/x402) over MCP. It runs on test networks, or fully simulated.

```bash
gentifi payments --demo     # simulated Lightning node, USDC and USDT settlement: no real money
gentifi serve
node examples/agent-pay.mjs --item EGG-12:2 --collect Saturday    # in this repository
node examples/agent-pay.mjs --item EGG-12:2 --rail usdt           # pay with USDT instead
GENTIFI_PAYER_NWC='…' node examples/agent-pay.mjs --item EGG-12:2 --nwc   # pay from a wallet over NWC
```

**Wallets over Nostr Wallet Connect (NWC).** A customer's agent can pay from their own Lightning wallet (Alby Hub and others) through an NWC connection string, and the wallet enforces the budget the customer set for that connection. With simulated payments, `gentifi serve` runs a local relay and prints a simulated customer wallet with a 50,000 sat budget. A business can also issue invoices from its own wallet over NWC instead of running LND: `"node": { "type": "nwc", "uriEnv": "GENTIFI_NWC_URI" }`, with `payTo` set to the wallet's node key. A custodial wallet shared by many users won't do, because each business needs its own key.

How it stays safe:

1. **The customer confirms first, in their own app.** `pay_order` answers with an MCP 2026-07-28 confirmation request (an elicitation). Only a confirmed retry, carrying signed request state, gets a payment request. Apps that can't show confirmations get none.
2. **Every payment request is bound to its order.** The Lightning invoice's description hash commits to the exact tool call (x402 `exact` on `lnbtc`, profile `mcp:1`), so a proof can't buy anything else. USDC and USDT terms must be echoed unchanged.
3. **Agents can check who they pay.** The ARD manifest publishes the business's Lightning key and its USDC and USDT addresses; `examples/agent-pay.mjs` refuses any request that pays someone else.
4. **The toolkit never holds money.** Lightning invoices come from the business's own node; USDC and USDT go from the payer straight to the business's address through a facilitator.
5. **Single use.** Each payment settles once, and each confirmation gets one payment request and pays for one order. The record of used payments, the order log and a signing secret live in `.gentifi/`, which ignores itself in git.

**USDT.** USDT has no signed-transfer function like USDC's (EIP-3009), so it uses x402's Permit2 method. The customer's wallet approves the Permit2 contract for USDT once; after that, each payment is a signature naming the business's address and the exact amount, and x402's proxy contract only pays that address. There's no official USDT on test networks, so `payments.usdt.asset` names a test token. Wallets that hold USDT on Lightning (Taproot Assets) can pay the Lightning invoice instead: their edge node converts, and the business receives bitcoin.

Real test networks:

```json
"payments": {
  "rates": { "BTC": "80000", "USD": "1.27" },
  "lightning": { "network": "testnet", "payTo": "<your node's public key>",
                 "node": { "type": "lnd", "url": "https://127.0.0.1:8080", "macaroonEnv": "GENTIFI_LND_MACAROON", "tlsCert": "/path/to/tls.cert" } },
  "usdc": { "network": "eip155:84532", "payTo": "0x<your address>", "facilitator": "https://x402.org/facilitator" },
  "usdt": { "network": "eip155:84532", "asset": "0x<test token>", "payTo": "0x<your address>", "facilitator": "https://x402.org/facilitator" }
}
```

`GENTIFI_LND_MACAROON` holds an *invoice* macaroon (hex): it can create invoices but not spend. Rates are set by hand in this prototype. `gentifi check` runs the whole payment flow against simulated rails, so it never touches a real node.

Not yet: refunds (Lightning `exact` payments are final), receiving USDT over Lightning (Taproot Assets), live exchange rates, sterling stablecoins, and mainnet USDC or USDT.

## Design rules

- **The customer always approves.** Every tool is read-only. Connecting an agent to a business, and every order, is confirmed by the customer in their own app or on the business's own checkout.
- **Information, not instructions.** Generated files say "this business has a connector, here it is". `gentifi check` fails any business text that tries to instruct an agent (prompt injection).
- **Real data only.** Prices, stock and hours come from the business. Missing details are reported, not invented.
- **Open formats.** Everything follows the published spec for that format, so it works without Gentifi.
- **Self-host or not.** `publish --self-host` lays out the files for your own domain; `serve` runs the connector anywhere Node runs.

## gentifi.json

`init` writes the project file every other command reads. Edit it by hand to add an address, a description, an A2A endpoint, or the collections the business belongs to:

```json
{
  "memberOf": [
    { "collection": "https://traders.example/collections/demo-high-street.json", "role": { "category": "farm shop" } }
  ]
}
```

`build` publishes each entry as a `col:memberOf` back-link, which is how a business confirms its membership of a [Business Collection](https://github.com/SelfBankt/collections-spec) (rule 1).

## Develop

```bash
git clone https://github.com/SelfBankt/gentifi-toolkit.git
cd gentifi-toolkit
node bin/gentifi.js --help
npm test
```

```
SKILL.md                Agent Skill for coding agents
bin/gentifi.js          CLI entry point
src/cli.js              argument parsing and command dispatch
src/commands/           init, sync, build, check, serve, publish, payments, collection
src/lib/                catalogue import, outputs, checks, QR codes, Business Collections
src/mcp/                MCP tools, protocol (both eras), HTTP and stdio transports, client
src/payments/           pay_order, x402 (Lightning, USDC and USDT), BOLT 11, secp256k1, keccak
examples/               fictional sample catalogues
test/                   node:test suite
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

[Apache License 2.0](LICENSE)
