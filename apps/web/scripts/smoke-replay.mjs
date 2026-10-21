// Optional real-browser integration check. Requires installed dependencies and Chrome.
// API_PORT / WEB_PORT override the default 8000 / 5173 (some Windows machines reserve 5173).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const generated = join(root, 'data/generated');
mkdirSync(generated, { recursive: true });
const profile = mkdtempSync(join(generated, 'browser-profile-'));
const chromePath = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
assert.ok(existsSync(chromePath), 'Install Chrome or set CHROME_PATH to its executable.');
const apiPort = Number(process.env.API_PORT ?? 8000);
const webPort = Number(process.env.WEB_PORT ?? 5173);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const children = [];
const logs = [];
let socket;
let send;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (children.some(child => child.exitCode !== null)) throw new Error('A test process exited; inspect data/generated/replay-*.log');
    try { if (await check()) return; } catch { /* Retry while services/browser start. */ }
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function requireFreePort(port) {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, 'localhost', resolve); });
  await new Promise(resolve => server.close(resolve));
}
function start(command, args, cwd, name, env = {}) {
  const log = openSync(join(generated, `replay-${name}.log`), 'w');
  logs.push(log);
  const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, ...env } });
  child.on('error', error => console.error(`${name}: ${error.message}`));
  children.push(child);
  return child;
}
const post = (path, body) => fetch(`${api}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const state = async () => (await fetch(`${api}/api/v1/replay`)).json();

try {
  await requireFreePort(apiPort);
  await requireFreePort(webPort);
  const python = join(root, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
  start(python, ['-m', 'uvicorn', 'app.main:app', '--app-dir', 'services/api', '--host', 'localhost', '--port', String(apiPort)], root, 'api',
    { CORS_ORIGINS: web, OMNIPITCH_DB_PATH: join(generated, `smoke-${Date.now()}.sqlite3`) });
  start(process.execPath, ['node_modules/vite/bin/vite.js', '--host', 'localhost', '--port', String(webPort), '--strictPort'], join(root, 'apps/web'), 'web',
    { VITE_API_BASE_URL: api });
  await until(async () => (await fetch(`${api}/health`)).ok, 'API health');
  await until(async () => (await fetch(web)).ok, 'Vite');
  start(chromePath, ['--headless=new', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], root, 'chrome');
  const portFile = join(profile, 'DevToolsActivePort');
  await until(() => existsSync(portFile), 'Chrome debugging port');
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  const targets = await (await fetch(`http://localhost:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  const runtimeErrors = [];
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails.text);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      clearTimeout(timer);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
    }
  });
  send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(requestId, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const text = () => evaluate('document.body.innerText');
  // Controls can be briefly disabled right after a reload (pre-existing race, about 1 run in 8): retry until usable.
  const clickNow = selector => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el || el.disabled) throw new Error('Unavailable: ' + ${JSON.stringify(selector)}); el.click(); })()`);
  const clickTextNow = label => evaluate(`(() => { const el = [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(${JSON.stringify(label)})); if (!el || el.disabled) throw new Error('Unavailable'); el.click(); })()`);
  const retry = async (attempt, label) => {
    let failure;
    await until(async () => { try { await attempt(); return true; } catch (error) { failure = error; return false; } }, label, 5000)
      .catch(() => { throw failure ?? new Error(`Unavailable: ${label}`); });
  };
  const click = selector => retry(() => clickNow(selector), selector);
  const clickText = label => retry(() => clickTextNow(label), label);
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: web });
  await until(async () => (await text()).includes('Live pitch') && (await text()).includes('0 / '), 'initial paused run');
  const initial = await state();

  // Upload an out-of-order JSONL file through the real file picker.
  const source = await (await fetch(`${api}/api/v1/matches/demo/events`)).json();
  const events = source.events.slice(0, 3).map((event, index) => ({ ...event, match_time_ms: (index + 1) * 2000 }));
  const fixturePath = join(generated, 'browser-replay.jsonl');
  writeFileSync(fixturePath, events.reverse().map(event => JSON.stringify(event)).join('\n'));
  await click('[aria-label="New match"]');
  await until(async () => (await text()).includes('Start a new match'), 'new match popover');
  const document = await send('DOM.getDocument');
  const { nodeId } = await send('DOM.querySelector', { nodeId: document.root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId, files: [resolve(fixturePath)] });
  await until(async () => (await text()).includes('0 / 3 events'), 'JSONL file loaded');
  const loaded = await state();
  assert.notEqual(loaded.state.run_id, initial.state.run_id);
  assert.equal(loaded.replay.source, 'upload');
  await post('/api/v1/replay/control', { run_id: loaded.state.run_id, action: 'speed', speed: 1 });
  await until(async () => (await text()).includes('Uploaded JSONL') && (await state()).replay.speed === 1, 'speed applied');
  await click('[aria-label="Play replay"]');
  await until(async () => (await text()).includes('1 / 3 events'), 'first event arrival');
  await click('[aria-label="Pause replay"]');
  await until(async () => (await state()).state.replay_status === 'paused', 'pause confirmation');
  await sleep(2200);
  assert.equal((await state()).state.latest_event_sequence, 1);
  await click('[aria-label="Resume replay"]');
  await until(async () => (await text()).includes('3 / 3 events'), 'playback completion');
  assert.equal((await state()).state.replay_status, 'finished');
  const beforeRefresh = await state();
  await send('Page.reload');
  await until(async () => (await text()).includes('3 / 3 events'), 'refresh restores replay');
  assert.equal((await state()).state.run_id, beforeRefresh.state.run_id);

  // Generating a seeded match yields moments, analysis and a working evidence drawer.
  await click('[aria-label="New match"]');
  await until(async () => (await text()).includes('Generate match'), 'popover');
  await clickText('Generate match');
  await until(async () => (await state()).replay.source === 'simulator', 'seeded match generated');
  const seeded = await state();
  await post('/api/v1/replay/control', { run_id: seeded.state.run_id, action: 'seek', elapsed_ms: 1_800_000 });
  await until(async () => (await text()).includes('Show evidence'), 'moments rendered');
  await clickText('Analyst view');
  await until(async () => (await text()).includes('illustrative threat added by completed passes'), 'analyst wording');
  await clickText('Show evidence');
  await until(async () => (await text()).includes('Metrics behind it'), 'evidence drawer');
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
  await until(async () => !(await text()).includes('Metrics behind it'), 'drawer closed');
  await click('[aria-label="Reset run (new run ID)"]');
  await until(async () => (await state()).state.run_id !== seeded.state.run_id, 'reset identity');
  assert.deepEqual(runtimeErrors, []);
  const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(generated, 'replay-browser.png'), Buffer.from(screenshot.data, 'base64'));
  console.log('PASS: JSONL upload/order, play/pause/resume/finish, refresh recovery, seeded generation, analyst wording, evidence drawer and reset identity.');
} finally {
  if (send && socket?.readyState === WebSocket.OPEN) {
    try { await send('Browser.close'); } catch { /* Browser may close before replying. */ }
    socket.close();
  }
  for (const child of children.reverse()) {
    if (child.exitCode === null) child.kill();
  }
  for (const log of logs) closeSync(log);
}
