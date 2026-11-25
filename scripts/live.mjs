#!/usr/bin/env node
// Live view. A tiny local-only server (127.0.0.1) that reads SESSION METADATA from ~/.claude/projects.
// Privacy: it never sends prompt text, command arguments, URLs with paths, or tool output to the page.
// Only: project folder, session title, timestamps, tool names, file base names, executable names, hostnames.
//   node live.mjs           start (or reuse) the server and open the browser
//   node live.mjs --stop    stop the server
//   node live.mjs --serve   run the server in the foreground (used internally)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const PROJ = path.join(HOME, '.claude', 'projects');
const BASE = 7788, PORTS = 10, TAIL = 512 * 1024, IDLE_EXIT = 30 * 60 * 1000, SIG = 'agent-map-live';
const argv = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));

// ---------- metadata extraction ----------
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const baseName = (p) => path.basename(String(p || '').replace(/\\/g, '/')).slice(0, 60);
const exeName = (c) => {
  const t = (String(c || '').match(/"[^"]*"|'[^']*'|\S+/g) || []).map(x => x.replace(/^["']|["']$/g, '')).find(x => !x.includes('=') && !x.startsWith('-'));
  return baseName(t).slice(0, 30);
};
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
function target(name, input) {
  const i = input || {};
  if (FILE_TOOLS.has(name)) return baseName(i.file_path || i.notebook_path);
  if (name === 'Bash' || name === 'PowerShell') return exeName(i.command);
  if (name === 'Agent' || name === 'Task') return String(i.subagent_type || '').slice(0, 60);
  if (name === 'Skill') return String(i.skill || '').slice(0, 60);
  if (name === 'WebFetch') return hostOf(i.url);
  return '';
}

function tailLines(file, size) {
  const n = Math.min(size, TAIL), buf = Buffer.alloc(n), fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, n, size - n); } finally { fs.closeSync(fd); }
  let s = buf.toString('utf8');
  if (size > n) s = s.slice(s.indexOf('\n') + 1); // first line is cut
  return s.split('\n').filter(Boolean);
}

function analyze(lines) {
  const recs = [];
  for (const l of lines) { try { recs.push(JSON.parse(l)); } catch { /* partial line */ } }
  const ev = [], byId = new Map();
  let cwd = '', branch = '', model = '', title = '', agentName = '';
  for (const r of recs) {
    if (r.cwd) cwd = r.cwd;
    if (r.gitBranch) branch = r.gitBranch;
    if (r.type === 'custom-title' && r.customTitle) title = String(r.customTitle).slice(0, 80);
    if (r.type === 'agent-name' && r.agentName) agentName = String(r.agentName).slice(0, 60);
    if (r.type === 'assistant' && r.message) {
      if (r.message.model) model = r.message.model;
      for (const c of r.message.content || []) {
        if (c.type === 'tool_use') {
          const e = { k: (c.name === 'Agent' || c.name === 'Task') ? 'agent' : 'tool', id: c.id, name: c.name, target: target(c.name, c.input), t: r.timestamp, s: 'run', side: !!r.isSidechain };
          ev.push(e); byId.set(c.id, e);
        } else if (c.type === 'text' && c.text) ev.push({ k: 'text', name: '응답', target: '', t: r.timestamp, s: 'done', side: !!r.isSidechain });
      }
    } else if (r.type === 'user' && r.message && !r.isMeta) {
      const c = r.message.content;
      if (Array.isArray(c)) {
        let text = false;
        for (const b of c) {
          if (b.type === 'tool_result') { const e = byId.get(b.tool_use_id); if (e) { e.s = b.is_error ? 'err' : 'done'; e.t2 = r.timestamp; } }
          else if (b.type === 'text') text = true;
        }
        if (text && !r.isSidechain) ev.push({ k: 'prompt', name: '프롬프트', target: '', t: r.timestamp, s: 'done', side: false });
      } else if (typeof c === 'string' && !r.isSidechain) ev.push({ k: 'prompt', name: '프롬프트', target: '', t: r.timestamp, s: 'done', side: false });
    }
  }
  const events = ev.slice(-150);
  const tools = new Map(), skills = new Set();
  let agents = 0, nTools = 0;
  for (const e of events) {
    if (e.k === 'tool' || e.k === 'agent') { nTools++; tools.set(e.name, (tools.get(e.name) || 0) + 1); }
    if (e.k === 'agent') agents++;
    if (e.name === 'Skill' && e.target) skills.add(e.target);
  }
  const last = [...events].reverse().find(e => e.k === 'tool' || e.k === 'agent');
  const lastRec = recs.length ? recs[recs.length - 1] : null;
  return {
    cwd, branch, model, title: title || agentName, events, nTools, agents, skills: [...skills].slice(0, 8),
    top: [...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
    last: last ? { name: last.name, target: last.target, s: last.s } : null,
    lastTs: (recs.filter(r => r.timestamp).pop() || {}).timestamp || '',
    lastKind: lastRec ? lastRec.type : '',
  };
}

// ---------- scan with cache ----------
const cache = new Map(); // file -> { key, info }
function info(file, st) {
  const key = st.mtimeMs + ':' + st.size, c = cache.get(file);
  if (c && c.key === key) return c.info;
  let i;
  try { i = analyze(tailLines(file, st.size)); } catch { i = null; }
  if (i) cache.set(file, { key, info: i });
  return i;
}

function statusOf(i, st, now) {
  const age = now - st.mtimeMs;
  const pending = i.events.some(e => (e.k === 'tool' || e.k === 'agent') && e.s === 'run' && now - Date.parse(e.t) < 10 * 60 * 1000);
  if (age < 30 * 1000 || (pending && age < 10 * 60 * 1000)) return 'running';
  if (age < 30 * 60 * 1000) return 'idle';
  return 'dormant';
}

const SCRATCH = /scratch-workspaces|[\\/]Temp[\\/]claude[\\/]/i;
function sessionsOf(dir, now, days, limit) {
  const full = path.join(PROJ, dir);
  let files = [];
  try {
    files = fs.readdirSync(full).filter(f => f.endsWith('.jsonl')).map(f => ({ f, st: fs.statSync(path.join(full, f)) }))
      .filter(x => now - x.st.mtimeMs < days * 864e5).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).slice(0, limit);
  } catch { return []; }
  const out = [];
  for (const { f, st } of files) {
    const i = info(path.join(full, f), st); if (!i) continue;
    out.push({ sid: f.replace(/\.jsonl$/, ''), i, st });
  }
  return out;
}

function state(days) {
  const now = Date.now(), projects = [];
  let dirs = []; try { dirs = fs.readdirSync(PROJ); } catch { /* no projects yet */ }
  for (const dir of dirs) {
    const ss = sessionsOf(dir, now, days, 12); if (!ss.length) continue;
    const cwd = (ss.find(s => s.i.cwd) || { i: {} }).i.cwd || '';
    const sessions = ss.map(({ sid, i, st }) => ({
      sid, title: i.title || sid.slice(0, 8), branch: i.branch, model: i.model, status: statusOf(i, st, now),
      lastTs: new Date(st.mtimeMs).toISOString(), nTools: i.nTools, agents: i.agents, last: i.last, top: i.top, skills: i.skills,
    }));
    const tools = new Map(), skills = new Set();
    for (const s of sessions) { for (const [n, c] of s.top) tools.set(n, (tools.get(n) || 0) + c); s.skills.forEach(x => skills.add(x)); }
    projects.push({
      dir, cwd: cwd.replace(HOME, '~').replace(/\\/g, '/'), name: path.basename(cwd.replace(/\\/g, '/')) || dir,
      scratch: SCRATCH.test(cwd || dir), lastTs: sessions[0].lastTs, running: sessions.filter(s => s.status === 'running').length,
      sessions, top: [...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6), skills: [...skills].slice(0, 8),
    });
  }
  projects.sort((a, b) => (b.running - a.running) || (Date.parse(b.lastTs) - Date.parse(a.lastTs)));
  return { now, projects };
}

function flow(dir, sid) {
  const file = path.join(PROJ, dir, sid + '.jsonl');
  if (path.dirname(file) !== path.join(PROJ, dir) || !file.startsWith(PROJ + path.sep)) return null;
  let st; try { st = fs.statSync(file); } catch { return null; }
  const i = info(file, st); if (!i) return null;
  const now = Date.now();
  return { sid, title: i.title || sid.slice(0, 8), branch: i.branch, model: i.model, cwd: i.cwd.replace(HOME, '~').replace(/\\/g, '/'),
    status: statusOf(i, st, now), lastTs: new Date(st.mtimeMs).toISOString(), nTools: i.nTools, agents: i.agents,
    events: i.events.slice(-100).map(({ id, ...e }) => e) };
}

// ---------- server ----------
function serve() {
  const page = path.join(here, 'live.html'); // read per request so edits show up without a restart
  let timer; const bump = () => { clearTimeout(timer); timer = setTimeout(() => process.exit(0), IDLE_EXIT); }; bump();
  const SAFE = /^[\w.-]+$/;
  const server = http.createServer((req, res) => {
    bump();
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    if (host !== '127.0.0.1' && host !== 'localhost') { res.writeHead(403).end(); return; } // DNS-rebinding guard
    const u = new URL(req.url, 'http://x');
    const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
    if (req.method === 'POST' && u.pathname === '/api/stop' && req.headers['x-agent-map']) { json({ ok: true }); setTimeout(() => process.exit(0), 50); return; }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(fs.readFileSync(page, 'utf8')); return; }
    if (u.pathname === '/api/ping') return json({ sig: SIG });
    if (u.pathname === '/api/state') return json(state(Math.min(30, Math.max(1, +u.searchParams.get('days') || 3))));
    if (u.pathname === '/api/flow') {
      const dir = u.searchParams.get('dir') || '', sid = u.searchParams.get('sid') || '';
      if (!SAFE.test(dir) || !SAFE.test(sid)) return json({ error: 'bad request' }, 400);
      const f = flow(dir, sid); return f ? json(f) : json({ error: 'not found' }, 404);
    }
    res.writeHead(404).end();
  });
  let port = BASE;
  server.on('error', (e) => { if (e.code === 'EADDRINUSE' && port < BASE + PORTS - 1) server.listen(++port, '127.0.0.1'); else process.exit(1); });
  server.listen(port, '127.0.0.1');
}

// ---------- launcher ----------
const ping = (port) => new Promise((resolve) => {
  const q = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 800 }, (res) => {
    let b = ''; res.on('data', d => b += d); res.on('end', () => { try { resolve(JSON.parse(b).sig === SIG ? port : 0); } catch { resolve(0); } });
  });
  q.on('error', () => resolve(0)); q.on('timeout', () => { q.destroy(); resolve(0); });
});
const findRunning = async () => { for (let p = BASE; p < BASE + PORTS; p++) { if (await ping(p)) return p; } return 0; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

if (argv.includes('--serve')) serve();
else {
  let port = await findRunning();
  if (argv.includes('--stop')) {
    if (!port) console.log('실행 중인 live 서버가 없습니다');
    else { await new Promise(r => { const q = http.request({ host: '127.0.0.1', port, path: '/api/stop', method: 'POST', headers: { 'x-agent-map': '1' } }, r); q.on('error', r); q.end(); }); console.log('live 서버를 종료했습니다'); }
    process.exit(0);
  }
  if (!port) {
    spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    for (let n = 0; n < 25 && !port; n++) { await sleep(200); port = await findRunning(); }
  }
  if (!port) { console.log('live 서버를 시작하지 못했습니다'); process.exit(1); }
  const url = `http://127.0.0.1:${port}/`;
  if (!argv.includes('--no-open')) {
    const [cmd, a] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try { spawn(cmd, a, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* ignore */ }
  }
  console.log('agent-map live: ' + url + '  (이 컴퓨터에서만 접속됩니다. 종료: node live.mjs --stop, 30분 동안 접속이 없으면 자동 종료)');
  process.exit(0);
}
