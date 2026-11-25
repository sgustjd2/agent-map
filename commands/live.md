---
description: Open the live dashboard of Claude Code sessions per project (this computer only) / 프로젝트별 작업과 흐름을 실시간으로 보는 대시보드 열기
allowed-tools: Bash(node:*)
---
Run the command below once with the Bash tool.

node "${CLAUDE_PLUGIN_ROOT}/scripts/live.mjs" $ARGUMENTS

Pass on the printed address as is. If it was run with `--lan`, relay the printed LAN addresses (including the token) and the warning in full, and say that anyone who knows the address can view it read-only. Add one line saying that session content (prompts, command arguments, output) is not read, only project names, session titles, times and tool names are shown, and that it can be stopped with `node "${CLAUDE_PLUGIN_ROOT}/scripts/live.mjs" --stop`. Answer in the user's language. Do nothing else.
