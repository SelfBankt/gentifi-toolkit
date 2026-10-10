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

The toolkit targets Node.js 20+ and has no runtime dependencies yet. Please add a test with any change and keep new dependencies to a minimum.

## Ground rules

- Generated files must never instruct an agent to install or connect anything silently. The customer approves every connection and every order.
- Use fictional data in examples and tests.
- Write in UK English (catalogue, colour, organisation).

By contributing, you agree that your contributions are licensed under the Apache License 2.0.
