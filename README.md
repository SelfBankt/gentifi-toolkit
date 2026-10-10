# Gentifi Toolkit

**Turn any business catalogue into everything AI agents need to find, price, book and buy.**

The Gentifi Toolkit is free and open source. Point it at a catalogue (Shopify, CSV, WooCommerce or a booking system) and it generates the files and server an AI agent needs to work with the business: an MCP server, UCP profile, SKILL.md, A2A agent card and ai-catalog.json.

It works for consumers (B2C) and business buyers (B2B) on the same rails.

> **Status: early concept.** The command-line interface and project layout are in place; the commands themselves are not implemented yet. Each one prints what it will do. Issues and ideas are welcome.

## Commands

```bash
gentifi init --from shopify     # or csv, woocommerce, a booking system
gentifi build                   # generate every agent format
gentifi check                   # the Gentified test: can agents find and buy?
gentifi publish                 # self-host, or publish to the Gentifi network
```

## What it generates

| Input | Output |
| --- | --- |
| Catalogue, prices, stock | MCP server with search, price, availability and order tools |
| Bookings or services | UCP profile and booking or quote tools |
| Business details | A2A agent card and ai-catalog.json for discovery |
| Everything above | SKILL.md for headless agents |
| Business identity | Gentified badge with a scannable "add to your agent" code |

## Standards it builds on

The toolkit uses existing open standards rather than inventing new formats.

| Layer | Standard |
| --- | --- |
| Tools and data | [Model Context Protocol (MCP)](https://modelcontextprotocol.io) |
| Agent instructions | [Agent Skills (SKILL.md)](https://agentskills.io) |
| Agent to agent | [A2A](https://a2a-protocol.org) |
| Discovery | Agentic Resource Discovery (ai-catalog.json) |
| Commerce | UCP and ACP |
| Payments | x402, L402, AP2 |

## Design rules

- **The customer always approves.** Connecting an agent to a business, and every order, is confirmed by the customer in their own app. Generated files offer metadata ("this business has a connector, here it is"), never hidden instructions telling an agent to install something.
- **Open formats.** Everything the toolkit writes follows the published spec for that format, so it works without Gentifi.
- **Self-host or not.** `gentifi publish` can lay out files for your own domain, including `/.well-known/`, for businesses that want to run it themselves.

## Try it

Requires Node.js 20 or later. No dependencies yet.

```bash
git clone https://github.com/SelfBankt/gentifi-toolkit.git
cd gentifi-toolkit
node bin/gentifi.js --help
npm test
```

`examples/demo-farm-shop.csv` is a small fictional catalogue to develop against.

## Project layout

```
bin/gentifi.js          CLI entry point
src/cli.js              argument parsing and command dispatch
src/commands/           init, build, check, publish
examples/               fictional sample catalogues
test/                   node:test suite
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

[Apache License 2.0](LICENSE)
