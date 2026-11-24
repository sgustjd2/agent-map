#!/usr/bin/env node
// Scans local Claude Code config -> self-contained HTML map. Zero deps. Secrets (args/env/headers) are never read into output.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const HOME = os.homedir();
const CLAUDE = path.join(HOME, '.claude');
const CWD = process.cwd();
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const ls = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } };

function front(file) {
  let t; try { t = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out = {};
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(name|description|model|tools):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[>|][+-]?$/.test(v)) { v = ''; while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) v += ' ' + lines[++i].trim(); }
    out[kv[1]] = v.replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

const hookEvents = (h) => Object.entries(h || {}).map(([ev, arr]) => ({
  name: ev, desc: (Array.isArray(arr) ? arr : []).flatMap(x => x.hooks || []).map(x => x.command || x.type).filter(Boolean).join(' | ').slice(0, 200),
}));
const mcpList = (s) => Object.entries(s || {}).map(([n, c]) => ({ name: n, desc: c.url || c.command || '', type: c.type || (c.url ? 'http' : 'stdio') }));

function scanDir(root) {
  const skills = ls(path.join(root, 'skills')).filter(d => d.isDirectory() || d.isSymbolicLink())
    .map(d => ({ name: d.name, ...front(path.join(root, 'skills', d.name, 'SKILL.md')) }))
    .filter(s => fs.existsSync(path.join(root, 'skills', s.name, 'SKILL.md')))
    .map(s => ({ name: s.name, desc: s.description || '' }));
  const md = (sub) => ls(path.join(root, sub)).filter(f => f.name.endsWith('.md')).map(f => {
    const fm = front(path.join(root, sub, f.name));
    return { name: fm.name || f.name.replace(/\.md$/, ''), desc: fm.description || '', extra: fm.model || '' };
  });
  const pj = readJson(path.join(root, '.claude-plugin', 'plugin.json')) || {};
  const hooks = hookEvents((readJson(path.join(root, 'hooks', 'hooks.json')) || pj).hooks);
  const mcp = mcpList((readJson(path.join(root, '.mcp.json')) || {}).mcpServers || pj.mcpServers);
  return { skills, agents: md('agents'), commands: md('commands'), hooks, mcp, description: pj.description || '' };
}

const settings = readJson(path.join(CLAUDE, 'settings.json')) || {};
const enabled = settings.enabledPlugins || {};
const groups = [];

const user = scanDir(CLAUDE);
user.hooks = hookEvents(settings.hooks);
user.mcp = mcpList((readJson(path.join(HOME, '.claude.json')) || {}).mcpServers);
groups.push({ kind: 'user', name: '사용자 (~/.claude)', ...user });

const proj = scanDir(path.join(CWD, '.claude'));
proj.mcp = mcpList((readJson(path.join(CWD, '.mcp.json')) || {}).mcpServers);
proj.hooks = hookEvents((readJson(path.join(CWD, '.claude', 'settings.json')) || {}).hooks);
if (fs.existsSync(path.join(CWD, '.claude')) || proj.mcp.length) groups.push({ kind: 'project', name: '프로젝트 (' + path.basename(CWD) + ')', ...proj });

const installed = (readJson(path.join(CLAUDE, 'plugins', 'installed_plugins.json')) || {}).plugins || {};
for (const [id, list] of Object.entries(installed)) {
  const e = list[list.length - 1]; if (!e) continue;
  groups.push({ kind: 'plugin', name: id.split('@')[0], source: id.split('@')[1] || '', version: e.version, enabled: !!enabled[id], ...scanDir(e.installPath) });
}

const KINDS = ['skills', 'agents', 'commands', 'hooks', 'mcp'];
const totals = Object.fromEntries(KINDS.map(k => [k, groups.reduce((n, g) => n + g[k].length, 0)]));
const data = { generatedAt: new Date().toISOString(), totals, groups };

const html = fs.readFileSync(new URL('./template.html', import.meta.url), 'utf8')
  .replace('/*DATA*/null', () => JSON.stringify(data).replace(/</g, '\u003c'));
const out = path.join(os.tmpdir(), 'agent-map.html');
fs.writeFileSync(out, html);

const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', out]] : process.platform === 'darwin' ? ['open', [out]] : ['xdg-open', [out]];
if (!process.argv.includes('--no-open')) { try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch {} }

console.log(`agent-map: ${groups.length}개 그룹 · ` + KINDS.map(k => `${k} ${totals[k]}`).join(' · '));
for (const g of groups) console.log(`- [${g.kind}] ${g.name}${g.enabled === false ? ' (비활성)' : ''}: ` + KINDS.map(k => `${k[0]}${g[k].length}`).join(' '));
console.log('HTML: ' + out);
