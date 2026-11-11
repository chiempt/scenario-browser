# Contributing

Thanks for helping. This is a small project; keep changes small and tested.

## Setup

```bash
npm install
npm run browser:install   # Chromium for the tests
npm run check             # typecheck + build + tests + validate examples
```

Node 23.6+ runs the TypeScript sources directly (`node src/cli.ts ...`). `npm run build` compiles to `dist/` for the published bin.

## Guidelines

- Add a test for every behavior change. Tests use a local fixture page and a mocked Anthropic API; they must not need network access or an API key.
- The scenario format is strict on purpose (unknown keys are errors). If you add a step, update `src/schema.ts`, the Markdown parser if it applies, the README, and regenerate the schemas with `npm run schema`.
- Keep scenarios-as-code honest: anything that runs JavaScript must stay visible in the README and the portal warning.
- Commit messages: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`.

## Out of scope

This project does not accept features that solve captchas, evade bot detection, or spoof browser fingerprints. It is for automating sites you own or are allowed to automate.
