---
description: Open a map of your local Claude Code setup (plugins, skills, agents, MCP, hooks) / 내 로컬 Claude Code 구성을 지도로 열기
allowed-tools: Bash(node:*)
---
Run the command below once with the Bash tool.

node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-map.mjs"

Summarize the output (counts per group and the HTML path) in one or two lines and give the HTML path as is. The script already opened the browser. Answer in the user's language. Do nothing else.
