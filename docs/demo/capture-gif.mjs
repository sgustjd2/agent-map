// Records the frames of docs/images/demo.gif from the demo home (never your own sessions).
//   node docs/demo/make-demo-home.mjs C:\agentmap-demo
//   USERPROFILE=C:\agentmap-demo AGENT_MAP_PORT=7801 node scripts/live.mjs --serve
//   node docs/demo/capture-gif.mjs <frames-dir>      (needs Edge or Chrome, Node 22+)
//   python docs/demo/assemble-gif.py <frames-dir> docs/images/demo.gif   (DEMO_LANG=ko for the Korean one)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const out = path.resolve(process.argv[2] || 'frames');
const base = process.env.DEMO_URL || 'http://127.0.0.1:7801';
const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => fs.existsSync(p));
if (!edge) throw new Error('Edge or Chrome not found');
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const profile = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'agent-map-edge-'));
const proc = spawn(edge, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--remote-debugging-port=9333', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
let target;
for (let i = 0; i < 80 && !target; i++) { await sleep(250); try { target = (await (await fetch('http://127.0.0.1:9333/json')).json()).find(t => t.type === 'page'); } catch { /* not up yet */ } }
if (!target) throw new Error('could not reach the browser DevTools port 9333 (is another browser using it?)');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const wait = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } });
const cdp = (method, params = {}) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (code) => (await cdp('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true })).result?.result?.value;

await cdp('Emulation.setDeviceMetricsOverride', { width: 1100, height: 680, deviceScaleFactor: 1, mobile: false });
await cdp('Page.enable');

const frames = [];
const shot = async (name, ms) => {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  const f = path.join(out, String(frames.length).padStart(2, '0') + '-' + name + '.png');
  fs.writeFileSync(f, Buffer.from(r.result.data, 'base64')); frames.push({ f, ms });
};
const go = async (url, ms = 2500) => { await cdp('Page.navigate', { url }); await sleep(ms); };
const until = async (cond, ms = 10000) => { for (let t = 0; t < ms; t += 200) { if (await js(cond)) return; await sleep(200); } throw new Error('timed out waiting for ' + cond); };
const click = (sel, nth = 0) => js(`document.querySelectorAll(${JSON.stringify(sel)})[${nth}].click()`);

// 1. the list: working and waiting sessions stand out
await go(`${base}/?theme=light&lang=${process.env.DEMO_LANG || 'en'}#p`, 800); await until(`!!document.querySelector('.r.running')`); await sleep(500);
await shot('list', 2600);
// 2. open the session that is working
await click('.r.running .rm'); await until(`document.querySelectorAll('.tr').length>3`); await sleep(600);
await js(`document.getElementById('main').scrollTop=0`); await sleep(300);
await shot('flow-top', 2400);
// 3. the step trace: an error row and the step that is running now
await js(`document.getElementById('main').scrollTop=document.getElementById('main').scrollHeight`); await sleep(400);
await shot('flow-trace', 2800);
// 4. back to the list, only sessions waiting for input
await click('#back'); await until(`!!document.querySelector('.r')`); await sleep(500);
await click('#sf button', 2); await sleep(700);
await shot('waiting', 2200);
// 5. same page in the dark theme
await click('#sf button', 0); await js(`document.getElementById('th').click()`); await sleep(700);
await shot('dark', 2600);

ws.close(); proc.kill();
fs.writeFileSync(path.join(out, 'frames.json'), JSON.stringify(frames.map(x => ({ file: path.basename(x.f), ms: x.ms }))));
await sleep(500); try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* browser still releasing it */ }
console.log(frames.length + ' frames in ' + out);
