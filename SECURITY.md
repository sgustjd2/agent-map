# Security

agent-map runs a local web server that can open folders and move or delete session files, so reports are taken seriously.

**Report privately** through GitHub: Security tab, "Report a vulnerability". Please do not open a public issue for security problems.

Design limits worth knowing:
- The server binds to `127.0.0.1` unless you pass `--lan`. With `--lan` it accepts only same-subnet private addresses and is read-only for other devices.
- Without `--token`, anyone on that network can read project paths and session titles. Use `--lan --token` on networks you do not fully trust.
- Cleanup touches only files under `~/.claude/projects` and never sessions active in the last 30 minutes.
