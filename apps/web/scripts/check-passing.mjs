import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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

const { passDifficulty, band, attacks, passingSummary } = await import(moduleUrl(new URL('../src/lib/passing.ts', import.meta.url)));

let seq = 0;
const pass = (start, end, extra = {}) => ({ event_id: `e${++seq}`, sequence: seq, type: 'pass', outcome: 'completed', team_id: 'harbor', player_id: 'h1',
  possession_id: 'p1', period: 1, match_time_ms: seq * 3000, attacking_direction: 'positive_x', start, end, ...extra });

// A short sideways pass in midfield is easy; a long ball into the box is hard.
const easy = passDifficulty(pass({ x: 40, y: 30 }, { x: 42, y: 40 }));
const hard = passDifficulty(pass({ x: 45, y: 34 }, { x: 95, y: 34 }));
assert.equal(band(easy.difficulty), 'easy');
assert.equal(band(hard.difficulty), 'hard');
assert.ok(hard.difficulty <= 100 && easy.difficulty >= 0);

// The outcome never changes the rating.
assert.equal(passDifficulty(pass({ x: 45, y: 34 }, { x: 95, y: 34 }, { outcome: 'incomplete' })).difficulty, hard.difficulty);

// The same pass attacking the other way, mirrored, rates the same.
assert.equal(passDifficulty(pass({ x: 60, y: 34 }, { x: 10, y: 34 }, { attacking_direction: 'negative_x' })).difficulty, hard.difficulty);

// Non-passes and passes without locations are not rated.
assert.equal(passDifficulty({ ...pass({ x: 1, y: 1 }, { x: 2, y: 2 }), type: 'shot' }), null);
assert.equal(passDifficulty(pass(null, null)), null);

// Speed of attack: 30 m forward in 3 s within one possession = 10 m/s; a one-action possession does not count.
seq = 0;
const run = [pass({ x: 30, y: 34 }, { x: 45, y: 34 }), pass({ x: 45, y: 34 }, { x: 60, y: 30 }), pass({ x: 60, y: 30 }, { x: 60, y: 40 }, { possession_id: 'p2', match_time_ms: 99000 })];
const found = attacks(run);
assert.equal(found.length, 1);
assert.equal(found[0].gain, 30);
assert.equal(found[0].seconds, 3);
assert.equal(found[0].speed, 10);

const summary = passingSummary(run, ['harbor', 'vale']);
assert.equal(summary.teams.harbor.attempted, 3);
assert.equal(summary.teams.vale.attempted, 0);
assert.equal(summary.teams.vale.meanDifficulty, null);
console.log('passing checks passed');
