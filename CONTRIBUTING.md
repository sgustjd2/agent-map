# Contributing

Issues and pull requests are welcome.

- Keep it dependency-free: Node standard library only, no build step.
- Run the scanner: `node scripts/agent-map.mjs --no-open`
- Run the dashboard: `node scripts/live.mjs --serve` (port 7788, override with `AGENT_MAP_PORT`)
- Screenshots and demos must use fake data, never your own sessions. See `docs/demo/make-demo-home.mjs`.
- UI changes: check the soft, light and dark themes in a real browser (`?theme=soft|light|dark`).
- Releases are automatic. Bump `version` in `.claude-plugin/plugin.json` and push to main.

For security problems, see [SECURITY.md](SECURITY.md) instead of opening a public issue.
