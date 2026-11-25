#!/usr/bin/env node
// Live view. A tiny local-only server (127.0.0.1) that reads SESSION METADATA from ~/.claude/projects.
// Privacy: it never sends prompt text, command arguments, URLs with paths, or tool output to the page.
// Only: project folder, session title, timestamps, tool names, file base names, executable names, hostnames.
//   node live.mjs           start (or reuse) the server and open the browser
//   node live.mjs --stop    stop the server
//   node live.mjs --lan     also listen on the local network: token required, read-only for everyone but this computer
//   node live.mjs --serve   run the server in the foreground (used internally)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const PROJ = path.join(HOME, '.claude', 'projects');
const BASE = +process.env.AGENT_MAP_PORT || 7788, PORTS = 10, TAIL = 512 * 1024, IDLE_EXIT = 30 * 60 * 1000, SIG = 'agent-map-live';
const TRASH = path.join(HOME, '.claude', 'agent-map-trash'); // cleanup moves sessions here (recoverable), never deletes directly
const FRESH_MS = 30 * 60 * 1000;                              // sessions used within 30 minutes are never touched
const SAFE_ID = /^(?!\.+$)[\w.-]+$/; // no "." or ".." (path traversal); used for every id that becomes part of a path
const inProjects = (p) => path.resolve(p).startsWith(PROJ + path.sep);
const argv = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));

// ---------- metadata extraction ----------
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const baseName = (p) => path.basename(String(p || '').replace(/\\/g, '/')).slice(0, 60);
const exeName = (c) => {
  // "cd dir && git status" -> git: skip leading cd segments so the executable is the informative part
  const segs = String(c || '').split(/&&|\|\||;|\n/).map(s => s.trim()).filter(Boolean);
  const pick = segs.find(s => !/^cd(\s|$)/.test(s)) || segs[0] || '';
  const t = (pick.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(x => x.replace(/^["']|["']$/g, '')).find(x => !x.includes('=') && !x.startsWith('-'));
  return baseName(t).slice(0, 30);
};
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
const oneLine = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
// First real text of a user message; blocks that start with "<" are injected context (system reminders, command wrappers), not what the user typed.
const promptText = (c) => {
  const parts = typeof c === 'string' ? [c] : (Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => b.text) : []);
  const t = parts.find(s => typeof s === 'string' && s.trim() && !s.trimStart().startsWith('<'));
  return t ? oneLine(t, 200) : '';
};
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
  let cwd = '', branch = '', model = '', title = '', agentName = '', usage = null, stop = '';
  for (const r of recs) {
    if (r.cwd) cwd = r.cwd;
    if (r.gitBranch) branch = r.gitBranch;
    if (r.type === 'custom-title' && r.customTitle) title = String(r.customTitle).slice(0, 80);
    if (r.type === 'agent-name' && r.agentName) agentName = String(r.agentName).slice(0, 60);
    if (r.type === 'assistant' && r.message) {
      if (r.message.model) model = r.message.model;
      if (r.message.usage) usage = r.message.usage;
      if (r.message.stop_reason) stop = r.message.stop_reason;
      for (const c of r.message.content || []) {
        if (c.type === 'tool_use') {
          const e = { k: (c.name === 'Agent' || c.name === 'Task') ? 'agent' : 'tool', id: c.id, name: c.name, target: target(c.name, c.input), d: oneLine((c.input || {}).description, 120), t: r.timestamp, s: 'run', side: !!r.isSidechain };
          ev.push(e); byId.set(c.id, e);
        } else if (c.type === 'text' && c.text) ev.push({ k: 'text', name: '응답', target: '', x: oneLine(c.text, 200), t: r.timestamp, s: 'done', side: !!r.isSidechain });
      }
    } else if (r.type === 'user' && r.message && !r.isMeta) {
      const c = r.message.content;
      if (Array.isArray(c)) {
        let text = false;
        for (const b of c) {
          if (b.type === 'tool_result') { const e = byId.get(b.tool_use_id); if (e) { e.s = b.is_error ? 'err' : 'done'; e.t2 = r.timestamp; } }
          else if (b.type === 'text') text = true;
        }
        if (text && !r.isSidechain) ev.push({ k: 'prompt', name: '프롬프트', target: '', x: promptText(c), t: r.timestamp, s: 'done', side: false });
      } else if (typeof c === 'string' && !r.isSidechain) ev.push({ k: 'prompt', name: '프롬프트', target: '', x: promptText(c), t: r.timestamp, s: 'done', side: false });
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
    ctx: usage ? (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) : 0, // prompt size of the latest call = how full the context is
    stop,
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
      lastTs: new Date(st.mtimeMs).toISOString(), nTools: i.nTools, agents: i.agents, last: i.last, top: i.top, skills: i.skills, size: st.size, errs: i.events.filter(e => e.s === 'err').length, stop: i.stop,
    }));
    const tools = new Map(), skills = new Set();
    for (const s of sessions) { for (const [n, c] of s.top) tools.set(n, (tools.get(n) || 0) + c); s.skills.forEach(x => skills.add(x)); }
    projects.push({
      dir, full: cwd, exists: !!cwd && fs.existsSync(cwd), cwd: cwd.replace(HOME, '~').replace(/\\/g, '/'), name: path.basename(cwd.replace(/\\/g, '/')) || dir,
      scratch: SCRATCH.test(cwd || dir), lastTs: sessions[0].lastTs, running: sessions.filter(s => s.status === 'running').length,
      sessions, top: [...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6), skills: [...skills].slice(0, 8),
    });
  }
  projects.sort((a, b) => (b.running - a.running) || (Date.parse(b.lastTs) - Date.parse(a.lastTs)));
  return { now, projects };
}

function flow(dir, sid, withText) {
  const file = path.join(PROJ, dir, sid + '.jsonl');
  if (path.dirname(file) !== path.join(PROJ, dir) || !file.startsWith(PROJ + path.sep)) return null;
  let st; try { st = fs.statSync(file); } catch { return null; }
  const i = info(file, st); if (!i) return null;
  const now = Date.now();
  return { sid, title: i.title || sid.slice(0, 8), branch: i.branch, model: i.model, cwd: i.cwd.replace(HOME, '~').replace(/\\/g, '/'),
    status: statusOf(i, st, now), lastTs: new Date(st.mtimeMs).toISOString(), nTools: i.nTools, agents: i.agents, ctx: i.ctx, stop: i.stop,
    events: i.events.slice(-100).map(({ id, x, d, ...e }) => (withText ? { ...e, x, d } : e)) };
}

// ---------- actions (POST only, see the router) ----------
function nearestExisting(p) {
  for (let d = p, n = 0; d && n < 12; n++) {
    try { if (fs.statSync(d).isDirectory()) return d; } catch { /* gone, try the parent */ }
    const up = path.dirname(d); if (up === d) return '';
    d = up;
  }
  return '';
}
function openFolder(dir) { // the page sends only the project key; the folder comes from the session records, never from the request
  if (!SAFE_ID.test(dir)) return { error: 'bad request' };
  let cwd = (sessionsOf(dir, Date.now(), 36500, 3).find(s => s.i.cwd) || { i: {} }).i.cwd || '';
  if (!path.isAbsolute(cwd)) cwd = ''; // never hand a relative or option-like value to the file manager
  const target = cwd ? nearestExisting(cwd) : '';
  if (!target) return { error: '폴더를 찾을 수 없습니다' };
  const [cmd, a] = process.platform === 'win32' ? ['explorer.exe', [target]] : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
  try { spawn(cmd, a, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { return { error: '열지 못했습니다' }; }
  return { ok: true, opened: target, fallback: target !== cwd };
}

function trashSessions(dir, sids, permanent) { // moves <sid>.jsonl and its <sid>/ folder; nothing is deleted
  if (!SAFE_ID.test(dir) || !sids.length) return { error: 'bad request' };
  const now = Date.now(), dest = path.join(TRASH, new Date(now).toISOString().replace(/[:.]/g, '-'), dir);
  let moved = 0; const skipped = [];
  for (const sid of sids) {
    if (!SAFE_ID.test(sid)) { skipped.push({ sid, reason: 'bad id' }); continue; }
    const f = path.join(PROJ, dir, sid + '.jsonl');
    if (!inProjects(f)) { skipped.push({ sid, reason: 'bad id' }); continue; }
    let st; try { st = fs.statSync(f); } catch { skipped.push({ sid, reason: 'missing' }); continue; }
    if (now - st.mtimeMs < FRESH_MS) { skipped.push({ sid, reason: 'active' }); continue; }
    try {
      const side = path.join(PROJ, dir, sid);
      if (permanent) { // explicit "delete for good": only these two paths, both verified to be inside the projects folder
        if (!inProjects(side)) { skipped.push({ sid, reason: 'bad id' }); continue; }
        fs.rmSync(f, { force: true });
        if (fs.existsSync(side) && fs.statSync(side).isDirectory()) fs.rmSync(side, { recursive: true, force: true });
      } else {
        fs.mkdirSync(dest, { recursive: true });
        fs.renameSync(f, path.join(dest, sid + '.jsonl'));
        if (fs.existsSync(side) && fs.statSync(side).isDirectory()) fs.renameSync(side, path.join(dest, sid));
      }
      cache.delete(f); moved++;
    } catch { skipped.push({ sid, reason: 'error' }); }
  }
  return { moved, skipped, permanent: !!permanent, trash: TRASH.replace(HOME, '~').replace(/\\/g, '/') };
}

function trashStats() {
  let count = 0, bytes = 0;
  const walk = (d, depth) => {
    let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 6) walk(p, depth + 1); }
      else { try { bytes += fs.statSync(p).size; } catch { /* vanished */ } if (depth === 2 && e.name.endsWith('.jsonl')) count++; }
    }
  };
  walk(TRASH, 0);
  return { count, bytes, dir: TRASH.replace(HOME, '~').replace(/\\/g, '/') };
}

function emptyTrash(confirmed) { // the only permanent delete, limited to the trash folder, needs an explicit confirm flag
  if (confirmed !== true) return { error: 'confirm required' };
  try { fs.rmSync(TRASH, { recursive: true, force: true }); } catch { return { error: '비우지 못했습니다' }; }
  return { ok: true };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ''; req.on('data', d => { b += d; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { reject(e); } });
  });
}

// ---------- server ----------
// Default: loopback only. With --lan the server listens on all interfaces, but only for requests that carry a random
// access token (given as ?t=... once, then kept in an HttpOnly cookie), and those requests are READ-ONLY.
const LAN = argv.includes('--lan');
const STATE_FILE = path.join(HOME, '.claude', 'agent-map', 'live.json'); // port + access token of a running LAN server
const isLoopback = (a) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
// A connection from one of this computer's own addresses is this computer (another device cannot fake that source address).
const isOwnAddr = (a) => { const x = String(a || '').replace(/^::ffff:/, ''); return isLoopback(a) || Object.values(os.networkInterfaces()).flat().some(n => n && n.address === x); };
const lanIps = () => Object.values(os.networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
const NEED_TOKEN = LAN && argv.includes('--token'); // optional extra: a random access token on top of "same network only"
// "Same network": a private address that sits in the same subnet as one of this computer's own network interfaces.
const ipToInt = (ip) => ip.split('.').reduce((a, b) => ((a << 8) | +b) >>> 0, 0);
const isPrivate = (a) => /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
const sameNet = (addr) => {
  const a = String(addr || '').replace(/^::ffff:/, '');
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(a) || !isPrivate(a)) return false;
  return Object.values(os.networkInterfaces()).flat().some(n => n && n.family === 'IPv4' && !n.internal
    && ((ipToInt(a) & ipToInt(n.netmask)) >>> 0) === ((ipToInt(n.address) & ipToInt(n.netmask)) >>> 0));
};

function serve() {
  const page = path.join(here, 'live.html'); // read per request so edits show up without a restart
  let timer; const bump = () => { clearTimeout(timer); timer = setTimeout(() => process.exit(0), IDLE_EXIT); }; bump();
  const SAFE = SAFE_ID;
  const token = NEED_TOKEN ? crypto.randomBytes(16).toString('hex') : '';
  const tokenOk = (g) => { // compare bytes, not characters: multibyte input has the same length in characters but more bytes, and timingSafeEqual throws on that
    if (!NEED_TOKEN) return false;
    const a = Buffer.from(g), b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  let lastMap = 0;
  const fails = new Map(); // remote ip -> { n, t }: slows down token guessing
  const handle = (req, res) => {
    bump();
    // no framing (clickjacking on the delete buttons), no sniffing, no referrer
    res.setHeader("x-frame-options", "DENY"); res.setHeader("x-content-type-options", "nosniff"); res.setHeader("referrer-policy", "no-referrer");
    const u = new URL(req.url, 'http://x');
    const remote = !isOwnAddr(req.socket.remoteAddress);
    const host = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    const hostOk = host === '127.0.0.1' || host === 'localhost' || (LAN && (lanIps().includes(host) || host === os.hostname().toLowerCase()));
    if (!hostOk) { res.writeHead(403).end(); return; } // DNS-rebinding guard
    const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
    if (remote) { // anyone who is not on this computer
      if (!LAN || !sameNet(req.socket.remoteAddress)) { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('같은 네트워크에서만 접속할 수 있습니다'); return; }
      if (NEED_TOKEN) {
      const ip = req.socket.remoteAddress, f = fails.get(ip) || { n: 0, t: Date.now() };
      if (fails.size > 500) fails.clear(); // bounded memory
      if (Date.now() - f.t > 5 * 60 * 1000) { f.n = 0; f.t = Date.now(); }
      if (f.n >= 10) { res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8' }).end('too many attempts'); return; }
      const qt = u.searchParams.get('t') || '', ck = /(?:^|;\s*)am_t=([0-9a-f]+)/.exec(req.headers.cookie || '');
      if (!tokenOk(qt || (ck ? ck[1] : ''))) {
        f.n++; fails.set(ip, f);
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }).end('접근 토큰이 필요합니다. live 서버를 실행한 컴퓨터에 표시된 주소(?t=...)로 접속하세요');
        return;
      }
      if (qt) { res.writeHead(302, { 'set-cookie': `am_t=${token}; HttpOnly; SameSite=Strict; Path=/`, location: u.pathname, 'cache-control': 'no-store' }).end(); return; }
      }
      if (req.method !== 'GET') { json({ error: '읽기 전용 접속입니다' }, 403); return; }
    }
    if (req.method === 'POST') { // state-changing: needs a custom header, which another website cannot send without a preflight we never answer
      if (!req.headers['x-agent-map']) { res.writeHead(403).end(); return; }
      if (u.pathname === '/api/stop') { json({ ok: true }); setTimeout(() => process.exit(0), 50); return; }
      readBody(req).then((b) => {
        if (u.pathname === '/api/open') return json(openFolder(String(b.dir || '')));
        if (u.pathname === '/api/trash') return json(trashSessions(String(b.dir || ''), Array.isArray(b.sids) ? b.sids.slice(0, 200).map(String) : [], b.permanent === true));
        if (u.pathname === '/api/trash/empty') return json(emptyTrash(b.confirm));
        json({ error: 'not found' }, 404);
      }).catch(() => json({ error: 'bad request' }, 400));
      return;
    }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (u.pathname === '/api/mode') return json({ readonly: remote, lan: LAN });
    if (u.pathname === '/api/trash-info') return json(trashStats());
    const htmlHead = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" };
    if (u.pathname === '/') { res.writeHead(200, htmlHead); res.end(fs.readFileSync(page, 'utf8')); return; }
    if (u.pathname === '/map') { // config map (MCP addresses, hooks): this computer only; regenerated at most every 3 seconds so repeated requests cannot stall the server
      if (remote) { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('구성 지도는 이 컴퓨터에서만 볼 수 있습니다'); return; }
      try {
        if (Date.now() - lastMap > 3000) { execFileSync(process.execPath, [path.join(here, 'agent-map.mjs'), '--no-open'], { timeout: 15000, stdio: 'ignore' }); lastMap = Date.now(); }
        res.writeHead(200, htmlHead); res.end(fs.readFileSync(path.join(HOME, '.claude', 'agent-map', 'agent-map.html'), 'utf8'));
      } catch { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end('구성 지도를 만들지 못했습니다'); }
      return;
    }
    if (u.pathname === '/api/ping') return json({ sig: SIG, lan: LAN, tok: NEED_TOKEN });
    if (u.pathname === '/api/state') return json(state(Math.min(30, Math.max(1, +u.searchParams.get('days') || 3))));
    if (u.pathname === '/api/flow') {
      const dir = u.searchParams.get('dir') || '', sid = u.searchParams.get('sid') || '';
      if (!SAFE.test(dir) || !SAFE.test(sid)) return json({ error: 'bad request' }, 400);
      const f = flow(dir, sid, !remote && u.searchParams.get('text') === '1'); return f ? json(f) : json({ error: 'not found' }, 404);
    }
    res.writeHead(404).end();
  };
  // one bad request must never take the server down
  const server = http.createServer((req, res) => { try { handle(req, res); } catch { try { res.writeHead(500).end(); } catch { /* socket already gone */ } } });
  const bind =LAN ? '0.0.0.0' : '127.0.0.1';
  let port = BASE;
  server.on('error', (e) => { if (e.code === 'EADDRINUSE' && port < BASE + PORTS - 1) server.listen(++port, bind); else process.exit(1); });
  server.on('listening', () => {
    if (!LAN) return;
    try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify({ port: server.address().port, token, pid: process.pid }), { mode: 0o600 }); }
    catch { /* the launcher then cannot print the token */ }
  });
  process.on('exit', () => { if (LAN) { try { fs.unlinkSync(STATE_FILE); } catch { /* already gone */ } } });
  server.listen(port, bind);
}

// ---------- launcher ----------
const ping = (port) => new Promise((resolve) => {
  const q = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 800 }, (res) => {
    let b = ''; res.on('data', d => b += d);
    res.on('end', () => { try { const j = JSON.parse(b); resolve(j.sig === SIG ? { port, lan: !!j.lan, tok: !!j.tok } : null); } catch { resolve(null); } });
  });
  q.on('error', () => resolve(null)); q.on('timeout', () => { q.destroy(); resolve(null); });
});
const findRunning = async () => { for (let p = BASE; p < BASE + PORTS; p++) { const r = await ping(p); if (r) return r; } return null; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const stopServer = (port) => new Promise(r => { const q = http.request({ host: '127.0.0.1', port, path: '/api/stop', method: 'POST', headers: { 'x-agent-map': '1' } }, r); q.on('error', r); q.end(); });

if (argv.includes('--serve')) serve();
else {
  let run = await findRunning();
  if (argv.includes('--stop')) {
    if (!run) console.log('실행 중인 live 서버가 없습니다');
    else { await stopServer(run.port); console.log('live 서버를 종료했습니다'); }
    process.exit(0);
  }
  if (run && LAN && (!run.lan || run.tok !== NEED_TOKEN)) { await stopServer(run.port); await sleep(600); run = null; } // LAN requested, but the running one is local-only or has another token setting
  if (!run) {
    spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve', ...(LAN ? ['--lan'] : []), ...(NEED_TOKEN ? ['--token'] : [])], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    for (let n = 0; n < 25 && !run; n++) { await sleep(200); run = await findRunning(); }
  }
  if (!run) { console.log('live 서버를 시작하지 못했습니다'); process.exit(1); }
  const url = `http://127.0.0.1:${run.port}/`;
  if (!argv.includes('--no-open')) {
    const [cmd, a] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try { spawn(cmd, a, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* ignore */ }
  }
  console.log('agent-map live: ' + url + '  (종료: node live.mjs --stop, 30분 동안 접속이 없으면 자동 종료)');
  if (run.lan) {
    let s = null; try { s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* no state file */ }
    if (!(s && s.port === run.port)) s = null;
    if (!run.tok) s = s || { token: '' }; // no token in use: the state file is not needed to print the addresses
    if (s) {
      console.log(`LAN 접속 (읽기 전용, 같은 네트워크만${s.token ? ', 접근 토큰 필요' : ''}):`);
      for (const ip of lanIps()) console.log(`  http://${ip}:${run.port}/${s.token ? '?t=' + s.token : ''}`);
      console.log('주의: 같은 네트워크에 있는 누구나' + (s.token ? '(주소를 아는 사람)' : '') + ' 프로젝트 경로와 세션 제목을 볼 수 있습니다. 믿을 수 있는 네트워크에서만 쓰고, 끝나면 node live.mjs --stop 으로 종료하세요. HTTPS가 아니라서 공용 와이파이에서는 쓰지 마세요.' + (s.token ? '' : ' 접근 토큰을 추가하려면 --lan --token 으로 실행하세요.'));
    } else console.log('LAN 모드로 실행 중이지만 접근 토큰을 읽지 못했습니다. node live.mjs --stop 후 --lan 으로 다시 실행하세요');
  } else console.log('이 컴퓨터에서만 접속됩니다. 같은 네트워크의 다른 기기에서 보려면 --lan 옵션으로 실행하세요');
  process.exit(0);
}
