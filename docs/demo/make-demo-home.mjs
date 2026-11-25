#!/usr/bin/env node
// Builds a FAKE home directory with made-up plugins, skills, projects and Claude Code sessions,
// so screenshots and demos never show anyone's real work.
//
//   node docs/demo/make-demo-home.mjs <empty-dir>
//   USERPROFILE=<empty-dir> AGENT_MAP_PORT=7801 node scripts/live.mjs --serve     (Windows: HOME=... on macOS/Linux)
//
// Nothing here touches the real ~/.claude.
import fs from 'node:fs';
import path from 'node:path';

const H = path.resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('usage: make-demo-home.mjs <empty-dir>'); process.exit(1); }
const C = path.join(H, '.claude');
const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const j = (o) => JSON.stringify(o, null, 2);

/* ---------- config: user skills, agents, commands, MCP ---------- */
const skill = (root, name, desc, extra = '') => w(path.join(root, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n${extra}---\n\n# ${name}\n`);
const agent = (root, name, desc, model = 'sonnet', tools = 'Read, Grep, Glob') => w(path.join(root, 'agents', name + '.md'), `---\nname: ${name}\ndescription: ${desc}\nmodel: ${model}\ntools: ${tools}\n---\n\nYou are ${name}.\n`);
const cmd = (root, name, desc, hint = '') => w(path.join(root, 'commands', name + '.md'), `---\ndescription: ${desc}\n${hint ? 'argument-hint: ' + hint + '\n' : ''}---\n\nRun ${name}.\n`);

skill(C, 'commit-helper', 'Write a clear conventional commit message from the staged diff. Use when the user asks to commit or to summarize changes.');
skill(C, 'api-design', 'Review REST and GraphQL API designs for naming, pagination, error shapes and versioning before implementation starts.');
skill(C, 'release-notes', 'Turn merged pull requests since the last tag into grouped, human-friendly release notes.', 'argument-hint: "[from-tag] [to-tag]"\n');
skill(C, 'sql-explain', 'Explain a slow SQL query plan and suggest indexes. Use for EXPLAIN output or performance questions.');
agent(C, 'planner', 'Breaks a feature request into small, ordered implementation steps with risks and open questions.', 'opus');
agent(C, 'security-reviewer', 'Reviews diffs for injection, secrets, unsafe deserialization and missing authorization checks.', 'sonnet');
cmd(C, 'standup', 'Summarize what changed in this repo since yesterday');
w(path.join(H, '.claude.json'), j({ mcpServers: {
  github: { type: 'http', url: 'https://mcp.example.com/github' },
  postgres: { command: 'npx', args: ['-y', '@example/postgres-mcp'] },
} }));

/* ---------- three fake plugins (one disabled) ---------- */
const plugins = {
  'code-review-kit': { version: '1.2.0', desc: 'Review pull requests with focused sub-agents for tests, types, error handling and style.', enabled: true,
    build: (r) => { agent(r, 'test-coverage-reviewer', 'Checks that new code paths are covered by meaningful tests.', 'sonnet');
      agent(r, 'type-design-reviewer', 'Reviews new types for clear invariants and encapsulation.', 'sonnet');
      agent(r, 'error-handling-reviewer', 'Finds swallowed errors and unsafe fallbacks.', 'opus');
      cmd(r, 'review-pr', 'Run a full pull request review with specialised agents', '[pr-number]');
      w(path.join(r, 'hooks', 'hooks.json'), j({ hooks: { PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/lint-changed.js"', timeout: 30 }] }] } })); } },
  'test-runner': { version: '0.9.4', desc: 'Run the right tests after every change and report failures in plain language.', enabled: true,
    build: (r) => { skill(r, 'run-affected-tests', 'Find and run only the tests affected by the current diff.');
      skill(r, 'flaky-test-triage', 'Investigate a flaky test: reproduce, bisect, and propose a fix.');
      w(path.join(r, 'hooks', 'hooks.json'), j({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/summarize-run.js"' }] }], SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/detect-runner.js"' }] }] } })); } },
  'docs-writer': { version: '2.0.1', desc: 'Draft and refresh documentation from the code that changed.', enabled: false,
    build: (r) => { skill(r, 'changelog-entry', 'Add a changelog entry for the current change.'); cmd(r, 'update-docs', 'Refresh docs for files changed on this branch'); } },
};
const installed = {};
for (const [name, p] of Object.entries(plugins)) {
  const root = path.join(C, 'plugins', 'cache', 'demo', name, p.version);
  w(path.join(root, '.claude-plugin', 'plugin.json'), j({ name, description: p.desc, version: p.version }));
  p.build(root);
  installed[`${name}@demo`] = [{ scope: 'user', installPath: root, version: p.version }];
}
w(path.join(C, 'plugins', 'installed_plugins.json'), j({ version: 2, plugins: installed }));
w(path.join(C, 'settings.json'), j({ enabledPlugins: Object.fromEntries(Object.entries(plugins).map(([n, p]) => [`${n}@demo`, p.enabled])) }));

/* ---------- projects and sessions ---------- */
const now = Date.now();
const MIN = 60e3;
const key = (cwd) => cwd.replace(/[:\\/]/g, '-');
let seq = 0;
// events: [secondsAfterStart, kind, ...]  kinds: P(prompt text) A(assistant text) T(tool, input, durationSec, error?, pending?)
function session(project, sid, title, startAgoMin, events, { mtimeAgoMin = 0, model = 'claude-sonnet-5-5', branch = 'main', ctx = 52000 } = {}) {
  const cwd = path.join(H, 'work', project);
  fs.mkdirSync(cwd, { recursive: true });
  const dir = path.join(C, 'projects', key(cwd));
  fs.mkdirSync(dir, { recursive: true });
  let t0 = now - startAgoMin * MIN;
  const iso = (s) => new Date(t0 + s * 1000).toISOString();
  const base = (type, s, extra) => JSON.stringify({ type, cwd, sessionId: sid, gitBranch: branch, timestamp: iso(s), ...extra });
  const L = [base('custom-title', 0, { customTitle: title })];
  for (const e of events) {
    const [s, kind] = e;
    if (kind === 'P') L.push(base('user', s, { message: { role: 'user', content: e[2] } }));
    else if (kind === 'A') L.push(base('assistant', s, { message: { role: 'assistant', model, stop_reason: 'end_turn', usage: { input_tokens: 800, cache_read_input_tokens: ctx, output_tokens: 240 }, content: [{ type: 'text', text: e[2] }] } }));
    else if (kind === 'T') {
      const [, , name, input, dur, flag] = e; const id = 'tu' + (++seq);
      L.push(base('assistant', s, { message: { role: 'assistant', model, stop_reason: 'tool_use', usage: { input_tokens: 900, cache_read_input_tokens: ctx, output_tokens: 120 }, content: [{ type: 'tool_use', id, name, input }] } }));
      if (flag !== 'pending') L.push(base('user', s + dur, { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: flag === 'error', content: 'ok' }] } }));
    }
  }
  const f = path.join(dir, sid + '.jsonl');
  fs.writeFileSync(f, L.join('\n') + '\n');
  const m = (now - mtimeAgoMin * MIN) / 1000; fs.utimesSync(f, m, m);
}
const F = (p) => ({ file_path: p });
const B = (command, description) => ({ command, description });

// shop-web: one session working right now, one waiting, two old
session('shop-web', 'a1', 'Fix checkout total rounding bug', 4, [
  [0, 'P', 'Customers report the checkout total is off by one cent on discounted carts. Find the cause and fix it, with a regression test.'],
  [6, 'A', 'I will start by finding where the cart total is computed and how discounts are applied.'],
  [9, 'T', 'Grep', { pattern: 'cartTotal' }, 2], [14, 'T', 'Read', F('src/cart/total.ts'), 1], [18, 'T', 'Read', F('src/cart/discount.ts'), 1],
  [26, 'T', 'Read', F('src/cart/total.test.ts'), 1],
  [40, 'A', 'Found it: discounts are rounded per line item, then summed. Rounding once at the end fixes the drift.'],
  [46, 'T', 'Edit', F('src/cart/total.ts'), 4], [58, 'T', 'Edit', F('src/cart/discount.ts'), 3],
  [70, 'T', 'Write', F('src/cart/total.rounding.test.ts'), 6],
  [90, 'T', 'Bash', B('npm test -- cart', 'Run the cart test suite'), 31, 'error'],
  [128, 'A', 'One test still fails: the fixture expects the old rounding. I will update the fixture.'],
  [134, 'T', 'Edit', F('src/cart/__fixtures__/carts.json'), 3],
  [141, 'T', 'Bash', B('npm test -- cart', 'Run the cart test suite again'), 24],
  [172, 'T', 'Bash', B('npm run lint', 'Lint the changed files'), 11],
  [190, 'P', 'Great. Also run the full checkout flow tests before you finish.'],
  [196, 'T', 'Bash', B('npm test -- checkout', 'Run the full checkout test suite'), 0, 'pending'],
], { mtimeAgoMin: 0, branch: 'fix/checkout-rounding', ctx: 61000 });
session('shop-web', 'a2', 'Add dark mode toggle to settings', 52, [
  [0, 'P', 'Add a dark mode toggle to the settings page and remember the choice.'],
  [8, 'T', 'Read', F('src/settings/Settings.tsx'), 1], [14, 'T', 'Write', F('src/theme/useTheme.ts'), 5], [30, 'T', 'Edit', F('src/settings/Settings.tsx'), 4],
  [44, 'T', 'Bash', B('npm run build', 'Type-check and build'), 38],
  [96, 'A', 'The toggle is in place and the preference is stored in localStorage. The build passes.'],
], { mtimeAgoMin: 7, branch: 'feat/dark-mode', ctx: 38000 });
session('shop-web', 'a3', 'Upgrade React Router to v7', 60 * 6, [
  [0, 'P', 'Upgrade React Router to v7 and fix the breaking changes.'], [10, 'T', 'Bash', B('npm outdated', 'List outdated packages'), 4],
  [30, 'T', 'Edit', F('package.json'), 2], [60, 'A', 'Upgraded; two route files needed small changes.'],
], { mtimeAgoMin: 60 * 5, ctx: 30000 });
session('shop-web', 'a4', 'Investigate slow product page', 60 * 30, [
  [0, 'P', 'Why is the product page slow on mobile?'], [12, 'T', 'Read', F('src/product/ProductPage.tsx'), 1], [40, 'A', 'The hero image is not lazy loaded.'],
], { mtimeAgoMin: 60 * 29, ctx: 24000 });

// payments-api: sub-agents and an error
session('payments-api', 'b1', 'Migrate invoices to the new schema', 4.5, [
  [0, 'P', 'Migrate the invoices table to the new schema without downtime. Write the migration and the backfill job.'],
  [9, 'A', 'I will plan the migration in two phases: add new columns, then backfill and switch reads.'],
  [14, 'T', 'Read', F('db/schema.sql'), 1], [20, 'T', 'Read', F('src/invoices/repository.ts'), 1],
  [30, 'T', 'Agent', { subagent_type: 'planner', description: 'Plan a zero-downtime invoice migration' }, 48],
  [84, 'T', 'Write', F('db/migrations/0042_invoice_v2.sql'), 7], [96, 'T', 'Write', F('src/jobs/backfill-invoices.ts'), 9],
  [112, 'T', 'Bash', B('psql -f db/migrations/0042_invoice_v2.sql', 'Apply the migration to the test database'), 6, 'error'],
  [124, 'A', 'The migration failed on a NOT NULL column without a default. Fixing it.'],
  [130, 'T', 'Edit', F('db/migrations/0042_invoice_v2.sql'), 3], [140, 'T', 'Bash', B('psql -f db/migrations/0042_invoice_v2.sql', 'Apply the migration again'), 5],
  [152, 'T', 'Bash', B('npm test -- invoices', 'Run the invoice tests'), 42],
  [210, 'T', 'Agent', { subagent_type: 'security-reviewer', description: 'Review the migration and backfill for risky changes' }, 0, 'pending'],
], { mtimeAgoMin: 0, model: 'claude-opus-5-5', branch: 'feat/invoice-v2', ctx: 88000 });
session('payments-api', 'b2', 'Add rate limiting to the webhook endpoint', 41, [
  [0, 'P', 'Add per-key rate limiting to the webhook endpoint.'], [10, 'T', 'Read', F('src/webhooks/handler.ts'), 1],
  [25, 'T', 'Write', F('src/webhooks/rateLimit.ts'), 6], [44, 'T', 'Edit', F('src/webhooks/handler.ts'), 4],
  [60, 'T', 'Bash', B('npm test -- webhooks', 'Run webhook tests'), 19],
  [100, 'A', 'Rate limiting is implemented with a sliding window and covered by tests.'],
], { mtimeAgoMin: 12, branch: 'feat/webhook-rate-limit', ctx: 47000 });
session('payments-api', 'b3', 'Fix flaky refund test', 60 * 26, [[0, 'P', 'The refund test fails about one run in ten. Find out why.'], [20, 'T', 'Bash', B('npm test -- refund --runInBand', 'Reproduce the flaky test'), 40], [90, 'A', 'A shared clock mock leaks between tests.']], { mtimeAgoMin: 60 * 25, ctx: 26000 });

// docs-site
session('docs-site', 'c1', 'Write the v3 migration guide', 22, [
  [0, 'P', 'Draft a migration guide from v2 to v3 using the changelog.'], [8, 'T', 'Read', F('CHANGELOG.md'), 1], [16, 'T', 'Read', F('docs/guides/index.md'), 1],
  [30, 'T', 'Write', F('docs/guides/migrate-v3.md'), 12], [60, 'T', 'Bash', B('npm run docs:check-links', 'Check links in the docs'), 14],
  [90, 'A', 'The guide is drafted and all links resolve.'],
], { mtimeAgoMin: 15, branch: 'docs/v3-guide', ctx: 33000 });
session('docs-site', 'c2', 'Fix broken sidebar on mobile', 60 * 50, [[0, 'P', 'The sidebar overlaps the content on phones.'], [15, 'T', 'Edit', F('src/components/Sidebar.css'), 3]], { mtimeAgoMin: 60 * 49, ctx: 20000 });

console.log('demo home ready:', H);
