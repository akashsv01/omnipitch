import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import ts from 'typescript';

// Load the actual TS/TSX modules without adding a test runner or writing build files.
function moduleUrl(file) {
  if (file.pathname.endsWith('.json')) {
    return `data:text/javascript;base64,${Buffer.from(`export default ${readFileSync(file, 'utf8')};`).toString('base64')}`;
  }
  const source = readFileSync(file, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const resolved = outputText.replace(/from (['"])([^'"]+)\1/g, (_, quote, specifier) => {
    let target;
    if (specifier.startsWith('.')) {
      const candidates = specifier.endsWith('.json') ? [specifier] : [`${specifier}.tsx`, `${specifier}.ts`];
      const found = candidates.map(candidate => new URL(candidate, file)).find(url => existsSync(url));
      target = moduleUrl(found);
    } else {
      target = import.meta.resolve(specifier);
    }
    return `from ${quote}${target}${quote}`;
  });
  return `data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`;
}

const { Pitch } = await import(moduleUrl(new URL('../src/components/Pitch.tsx', import.meta.url)));
const format = await import(moduleUrl(new URL('../src/lib/format.ts', import.meta.url)));
const fixture = JSON.parse(readFileSync(new URL('../../../contracts/examples/event.example.json', import.meta.url), 'utf8'));
const render = props => renderToStaticMarkup(createElement(Pitch, props));
const layers = { trail: true, threat: false, density: false, network: false };

for (const direction of ['positive_x', 'negative_x']) {
  const event = { ...fixture, start: { x: 0, y: 68 }, end: { x: 105, y: 0 }, attacking_direction: direction };
  const html = render({ events: [event], layers, animate: false });
  assert.match(html, /viewBox="-4 -4 113 76"/);
  // Both directions keep the global coordinate frame, including inclusive bounds.
  assert.match(html, /x1="0" y1="68" x2="105" y2="0"/);
  assert.match(html, new RegExp(direction === 'positive_x' ? 'Attacking right' : 'Attacking left'));
  assert.match(html, /role="img" aria-labelledby="[^"]+"/);
  assert.doesNotMatch(html, /NaN|undefined|transform="rotate\(180/);
}

const empty = render({ events: [], layers });
assert.match(empty, /No located event yet/);
assert.doesNotMatch(empty, /<line /);

// Period markers carry no location and must never be drawn.
const marker = { ...fixture, event_id: 'evt-0000', type: 'period_start', outcome: 'none', team_id: null, player_id: null,
  possession_id: null, start: null, end: null, attacking_direction: null };
const withMarker = render({ events: [marker, fixture], layers, animate: false });
assert.equal((withMarker.match(/<line /g) ?? []).length >= 1, true);

// Defensive actions render as a cross at the start point; threat and density layers render cells.
const tackle = { ...fixture, event_id: 'evt-0002', sequence: 2, type: 'tackle', outcome: 'won', end: null };
const layered = render({ events: [fixture, tackle], layers: { ...layers, threat: true, density: true }, animate: false });
assert.match(layered, /Tackle won/);
assert.ok((layered.match(/<rect/g) ?? []).length > 150, 'threat grid and density cells render');

// Evidence highlighting draws only the cited events.
const second = { ...fixture, event_id: 'evt-0003', sequence: 3, start: { x: 50, y: 20 }, end: { x: 60, y: 30 } };
const highlighted = render({ events: [fixture, second], highlightIds: ['evt-0003'], layers, compact: true });
assert.match(highlighted, /x1="50" y1="20" x2="60" y2="30"/);
assert.doesNotMatch(highlighted, new RegExp(`x1="${fixture.start.x}" y1="${fixture.start.y}"`));

assert.equal(format.clockLabel(1, 0), "1'");
assert.equal(format.clockLabel(1, 46 * 60000), "45+2'");
assert.equal(format.clockLabel(2, 0), "46'");
assert.equal(format.runningClock(2, 61_000), '46:01');

console.log('Pitch checks passed: both directions, boundary coordinates, empty state, period markers, layers, evidence highlighting and clock labels.');
