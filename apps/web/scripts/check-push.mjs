import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

// Web PubSub client logic (src/lib/push.ts) against a fake socket, with real contract examples.
const source = readFileSync(new URL('../src/lib/push.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { PushClient, PUSH_PROTOCOL } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const ajv = new Ajv2020({ allowUnionTypes: true });
addFormats(ajv);
for (const name of ['event', 'insight', 'match-state', 'analysis', 'moment', 'reconciliation']) ajv.addSchema(read(`../../../contracts/schemas/${name}.schema.json`));
const validate = ajv.compile(read('../../../contracts/schemas/push.schema.json'));
const example = name => read(`../../../contracts/examples/${name}.example.json`);
const RUN = 'gate-20261020-b';
const state = example('push-state');
const moment = example('push');
const insight = example('push-insight');
const reconciled = { ...example('push-period-reconciled'), run_id: RUN, message_id: `${RUN}:period_reconciled:1`,
  payload: { ...example('push-period-reconciled').payload, run_id: RUN, reconciliation_id: `${RUN}:p1` } };
for (const envelope of [state, moment, insight, reconciled]) assert.ok(validate(envelope), JSON.stringify(validate.errors));

function harness(negotiate) {
  const sockets = [], timers = [], signals = [], statuses = [];
  let negotiations = 0;
  const deps = {
    negotiate: async runId => { negotiations += 1; return negotiate(runId, negotiations); },
    openSocket: (url, protocol) => {
      const socket = { url, protocol, closed: false, onopen: null, onmessage: null, onclose: null, onerror: null, close() { this.closed = true; } };
      sockets.push(socket);
      return socket;
    },
    validate,
    setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: timer => { timer.cleared = true; },
  };
  const client = new PushClient(deps, signal => signals.push(signal), status => statuses.push(status));
  const frame = envelope => ({ data: JSON.stringify({ type: 'message', from: 'group', group: `run-${RUN}`, dataType: 'json', data: envelope }) });
  return { client, sockets, timers, signals, statuses, frame, last: () => statuses.at(-1), negotiations: () => negotiations };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const NEGOTIATED = { url: 'wss://example.webpubsub.azure.com/client/hubs/omnipitch?access_token=test', group: `run-${RUN}` };

// 1. No push configured: polling only, no socket and no retries.
{
  const h = harness(() => null);
  h.client.start(RUN);
  await tick();
  assert.equal(h.last().state, 'unavailable');
  assert.equal(h.sockets.length, 0);
  assert.equal(h.timers.length, 0);
}

// 2. Connect, order, dedup, kinds; snapshot recovery on (re)connect; renegotiation; stale callbacks ignored.
{
  const h = harness(() => NEGOTIATED);
  h.client.start(RUN);
  await tick();
  const [socket] = h.sockets;
  assert.equal(socket.protocol, PUSH_PROTOCOL);
  socket.onopen();
  assert.equal(h.last().state, 'live');
  assert.deepEqual(h.signals.map(s => [s.kind, s.reason]), [['full', 'connected']]);

  socket.onmessage(h.frame(state));                                   // state 400
  socket.onmessage(h.frame(state));                                   // retried publication: same message_id
  socket.onmessage(h.frame({ ...state, message_id: `${RUN}:state:399`, state_version: 399 }));  // out of order
  socket.onmessage(h.frame(moment));                                  // state_version 340 < 400 but not a state: kept
  socket.onmessage(h.frame(insight));
  socket.onmessage(h.frame(reconciled));
  socket.onmessage({ data: JSON.stringify({ type: 'message', from: 'group', dataType: 'text', data: JSON.stringify({ ...state, message_id: `${RUN}:state:401`, state_version: 401 }) }) });
  socket.onmessage(h.frame({ ...state, run_id: 'another-run', message_id: 'another-run:state:500' }));  // other run
  socket.onmessage(h.frame({ ...state, message_id: `${RUN}:state:402`, state_version: 402, payload: {} }));  // invalid
  socket.onmessage({ data: '{"type":"system","event":"connected","connectionId":"c1"}' });  // system frame: no data
  socket.onmessage({ data: 'not json' });
  assert.deepEqual(h.signals.slice(1).map(s => [s.kind, s.reason]),
    [['refresh', 'state'], ['refresh', 'moment'], ['full', 'insight'], ['full', 'period_reconciled'], ['refresh', 'state']]);
  assert.equal(h.last().received, 5);
  assert.equal(h.last().ignored, 5);
  assert.equal(h.last().lastType, 'state');

  socket.onclose({ code: 1006 });                                     // dropped connection
  assert.equal(h.last().state, 'retrying');
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 1000);
  h.timers[0].fn();
  await tick();
  assert.equal(h.negotiations(), 2, 'reconnect negotiates a fresh token');
  h.sockets[1].onopen();
  assert.equal(h.last().state, 'live');
  assert.deepEqual(h.signals.at(-1), { kind: 'full', reason: 'connected', envelope: null }, 'snapshot recovery after reconnect');
  h.sockets[1].onmessage(h.frame(state));                             // already seen before the drop
  assert.equal(h.last().received, 5);

  h.client.start('other-run');                                        // a new replay source
  assert.ok(h.sockets[1].closed);
  const before = h.signals.length;
  h.sockets[1].onmessage?.(h.frame({ ...state, message_id: `${RUN}:state:900`, state_version: 900 }));
  assert.equal(h.signals.length, before, 'old socket callbacks are ignored');
  h.client.stop();
  assert.equal(h.last().state, 'off');
}

// 3. Negotiation failures back off and keep trying; stop cancels the pending retry.
{
  const h = harness(() => { throw new Error('HTTP 502'); });
  h.client.start(RUN);
  await tick();
  assert.equal(h.last().state, 'retrying');
  assert.match(h.last().error, /HTTP 502/);
  h.timers[0].fn();
  await tick();
  assert.deepEqual(h.timers.map(t => t.ms), [1000, 2000]);
  h.client.stop();
  assert.ok(h.timers[1].cleared);
}
console.log('Push client checks passed: unavailable, ordering, dedup, stale and foreign runs, invalid frames, reconnect with fresh token and snapshot recovery, backoff, run switch.');
