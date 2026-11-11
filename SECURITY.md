# Security

## Scenarios are code

`evaluate`, `script` (inline or `file:`), and `expect js` execute JavaScript. `script` runs in Node with your user's rights. Never run a scenario or project you did not write or review, the same as you would not run an unknown shell script. `script file` and `include` paths are confined to the project directory.

## Portal

The portal is for local use. It binds `127.0.0.1`, rejects non-local `Host` headers, and only accepts same-origin `application/json` POSTs. It has no authentication: do not expose it with a proxy or tunnel. Running a scenario that contains JavaScript asks for confirmation.

## AI features (experimental)

`generate` and `--heal` send your description, or a trimmed list of page elements, to the Anthropic API. The key is read from `ANTHROPIC_API_KEY` only. Generated scenarios may contain JavaScript: review before running.

## Reporting a vulnerability

Please use GitHub private vulnerability reporting (Security tab, "Report a vulnerability") rather than a public issue. Include a minimal scenario that reproduces the problem. You should get a first reply within a week.
