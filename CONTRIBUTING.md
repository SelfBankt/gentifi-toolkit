# Contributing

Thanks for your interest in the Gentifi Toolkit. It's at a very early stage, so the most useful contributions right now are:

- **Issues** describing a catalogue source, booking system or agent you'd want supported.
- **Feedback on the generated formats**, especially where a spec is ambiguous.
- **Pull requests** for a single command or source, kept small.

## Development

```bash
node bin/gentifi.js --help
npm test
```

The toolkit targets Node.js 20+ and has no runtime dependencies, so it is quick to audit before running it against a business's data. Please add a test with any change and keep it that way.

Useful places to start:

- **A catalogue source:** add an importer next to `src/lib/catalogue.js` that returns the same item shape, and wire it into `src/commands/init.js` (Shopify, WooCommerce and booking systems are wanted).
- **A tool:** add it to `src/mcp/tools.js`. Every tool needs a title, an input schema and `readOnlyHint` or `destructiveHint`. Anything that changes state must end with the customer confirming it.
- **A format:** add a generator to `src/lib/outputs.js` and a validator to `src/lib/validate.js`, so `gentifi check` can test it.
- **A wallet or payment rail (prototype):** add an adapter next to `src/payments/lightning.js` or a facilitator in `src/payments/x402.js`. Test it against simulated rails in `gentifi check`, never a real node.

`test/fixtures/qr-reference.json` holds QR matrices from an independent encoder; `test/qr.test.js` compares against them. `test/payments.test.js` checks the payment code against the published BOLT 11 and x402 test vectors, and the Permit2 (USDT) signatures against values computed with an independent EIP-712 implementation.

## Ground rules

- Generated files must never instruct an agent to install or connect anything silently. The customer approves every connection and every order.
- Tools never place an order the customer hasn't confirmed in their own app. `prepare_order` hands over to the business's own checkout. `pay_order` (prototype) asks first, and pays only the business's published payee.
- Payment code never holds customer funds. Money goes straight from the customer's wallet to the business's own node or address.
- Use fictional data in examples and tests.
- Write in UK English (catalogue, colour, organisation).

By contributing, you agree that your contributions are licensed under the Apache License 2.0.
