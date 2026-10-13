import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import ts from 'typescript';

// Load the actual TSX components without adding a test runner or writing build files.
function componentUrl(file) {
  const source = readFileSync(file, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const resolved = outputText.replace(/from (['"])([^'"]+)\1/g, (_, quote, specifier) => {
    const target = specifier.startsWith('.')
      ? componentUrl(new URL(`${specifier}.tsx`, file))
      : import.meta.resolve(specifier);
    return `from ${quote}${target}${quote}`;
  });
  return `data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`;
}

const { Pitch } = await import(componentUrl(new URL('../src/components/Pitch.tsx', import.meta.url)));
const { PassExplorer } = await import(componentUrl(new URL('../src/components/PassExplorer.tsx', import.meta.url)));
const fixture = JSON.parse(readFileSync(new URL('../../../contracts/examples/event.example.json', import.meta.url), 'utf8'));
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));

for (const direction of ['positive_x', 'negative_x']) {
  const event = { ...fixture, start: { x: 0, y: 68 }, end: { x: 105, y: 0 }, attacking_direction: direction };
  const html = render(Pitch, { event });
  assert.match(html, /viewBox="-5 -5 115 78"/);
  // Both directions retain the global coordinate frame, including inclusive bounds.
  assert.match(html, /x1="0" y1="68" x2="105" y2="0"/);
  assert.match(html, new RegExp(direction === 'positive_x' ? 'Attacking right' : 'Attacking left'));
  assert.match(html, /role="img" aria-labelledby="[^"]+"/);
  assert.doesNotMatch(html, /NaN|undefined|transform="rotate/);
}

const empty = render(PassExplorer, { events: [] });
assert.match(empty, /No completed passes available/);
assert.doesNotMatch(empty, /class="pass-path"/);

// A run may reuse event IDs. Its newest event is selected initially and both cards remain distinct.
const next = { ...fixture, run_id: 'another-run', sequence: 2, start: { x: 50, y: 20 }, end: { x: 60, y: 30 } };
const html = render(PassExplorer, { events: [fixture, next] });
assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1);
assert.match(html, /x1="50" y1="20" x2="60" y2="30"/);
assert.match(html, /Selected event/);
assert.match(html, /Static|static/);

console.log('Pitch checks passed: both attack directions, boundary coordinates, empty state, and initial event selection.');
