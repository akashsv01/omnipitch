// Optional real-browser integration check. Requires installed dependencies and Chrome.
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
function start(command, args, cwd, name) {
  const log = openSync(join(generated, `replay-${name}.log`), 'w');
  logs.push(log);
  const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', log, log] });
  child.on('error', error => console.error(`${name}: ${error.message}`));
  children.push(child);
  return child;
}

try {
  await requireFreePort(8000);
  await requireFreePort(5173);
  const python = join(root, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
  start(python, ['-m', 'uvicorn', 'app.main:app', '--app-dir', 'services/api', '--host', 'localhost', '--port', '8000'], root, 'api');
  start(process.execPath, ['node_modules/vite/bin/vite.js', '--host', 'localhost'], join(root, 'apps/web'), 'web');
  await until(async () => (await fetch('http://localhost:8000/health')).ok, 'API health');
  await until(async () => (await fetch('http://localhost:5173')).ok, 'Vite');
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
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const text = () => evaluate('document.body.innerText');
  const click = label => evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(label)}); if (!button || button.disabled) throw new Error('Button unavailable'); button.click(); })()`);
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1200, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://localhost:5173' });
  await until(async () => (await text()).includes('0 of 5 passes revealed'), 'initial paused run');
  const initial = await (await fetch('http://localhost:8000/api/v1/replay')).json();

  const source = await (await fetch('http://localhost:8000/api/v1/matches/demo/events')).json();
  const events = source.events.slice(0, 3).map((event, index) => ({ ...event, match_time_ms: (index + 1) * 2000 }));
  const fixturePath = join(generated, 'browser-replay.jsonl');
  writeFileSync(fixturePath, events.reverse().map(event => JSON.stringify(event)).join('\n'));
  const document = await send('DOM.getDocument');
  const { nodeId } = await send('DOM.querySelector', { nodeId: document.root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId, files: [resolve(fixturePath)] });
  await until(async () => (await text()).includes('0 of 3 passes revealed'), 'JSONL file loaded');
  const loaded = await (await fetch('http://localhost:8000/api/v1/replay')).json();
  assert.notEqual(loaded.state.run_id, initial.state.run_id);
  await click('Play');
  await until(async () => (await text()).includes('1 of 3 passes revealed'), 'first pass arrival');
  await click('Pause');
  await until(async () => (await text()).includes('Replay paused'), 'pause confirmation');
  await sleep(2200);
  assert.match(await text(), /1 of 3 passes revealed/);
  await click('Resume');
  await until(async () => (await text()).includes('3 of 3 passes revealed'), 'playback completion');
  assert.match(await text(), /Replay finished/);
  await evaluate("document.querySelector('.event-list button').click()");
  await until(async () => (await text()).includes('Completed pass · #1'), 'event selection');
  assert.equal(await evaluate("document.querySelector('.pass-path line').getAttribute('x1')"), String(source.events[0].start.x));
  const beforeRefresh = await (await fetch('http://localhost:8000/api/v1/replay')).json();
  await send('Page.reload');
  await until(async () => (await text()).includes('3 of 3 passes revealed'), 'refresh restores replay');
  assert.equal((await (await fetch('http://localhost:8000/api/v1/replay')).json()).state.run_id, beforeRefresh.state.run_id);

  const badPath = join(generated, 'browser-invalid.jsonl');
  writeFileSync(badPath, 'not json');
  const nextDocument = await send('DOM.getDocument');
  const nextInput = await send('DOM.querySelector', { nodeId: nextDocument.root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId: nextInput.nodeId, files: [resolve(badPath)] });
  await until(async () => (await text()).includes('Invalid JSON or event contract'), 'invalid upload message');
  assert.equal((await (await fetch('http://localhost:8000/api/v1/replay')).json()).state.run_id, loaded.state.run_id);
  await click('Reset run');
  await until(async () => (await text()).includes('0 of 3 passes revealed'), 'reset clears progress');
  const reset = await (await fetch('http://localhost:8000/api/v1/replay')).json();
  assert.notEqual(reset.state.run_id, loaded.state.run_id);
  assert.equal(await evaluate("document.querySelector('.pass-path') === null"), true);
  assert.deepEqual(runtimeErrors, []);
  const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(generated, 'replay-browser.png'), Buffer.from(screenshot.data, 'base64'));
  console.log('PASS: browser JSONL upload/order, play/pause/resume/finish, selection, refresh, invalid-file recovery, and reset identity.');
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
