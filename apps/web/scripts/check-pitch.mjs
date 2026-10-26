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

// Regression: a story said "7.2 m" while the key value beside it said "7.3 m" for the same forward_progress
// (7.25). Displayed metrics must use the backend template rule (Python's ties-to-even, :g at 10 and above).
assert.equal(format.metricText('forward_progress', 7.25), '7.2');
assert.equal(format.metricText('forward_progress', 7.35), '7.3');   // 7.35 is stored just below the tie
assert.equal(format.metricText('elapsed', 4.8), '4.8');
assert.equal(format.metricText('elapsed', 3), '3');
assert.equal(format.metricText('pass_distance', 27.05), '27.05');
assert.equal(format.metricText('forward_progress', 0.05), '0.1');    // 0.05 is stored just above the tie; Python agrees
assert.equal(format.metricText('threat_delta', 0.211), '0.211');
assert.equal(format.metricText('ppda', 4.5), '4.5');
assert.equal(format.fixedEven(2.5, 0), '2');
assert.equal(format.fixedEven(3.5, 0), '4');

// Regression (walkthrough review): "why it matters" follows the evidence, not the rule name.
const evidence = await import(moduleUrl(new URL('../src/lib/evidence.ts', import.meta.url)));
const mk = (rule, metrics, facts, team = 'vale') => ({ rule, team_id: team, metrics: metrics.map(([name, value, unit]) => ({ name, value, unit })), facts,
  evidence_ids: ['e1', 'e2'], insight: { limitations: [], generation_mode: 'fallback' } });
const shortShot = mk('transition', [['forward_progress', 3.7, 'm'], ['elapsed', 6.5, 's'], ['actions', 3, 'events']], { ended_in_shot: true });
assert.equal(evidence.transitionBranch(shortShot), 'shot');
assert.match(evidence.whyItMatters(shortShot, 'fan'), /shot came 6\.5 s after winning the ball/);
assert.doesNotMatch(evidence.whyItMatters(shortShot, 'fan'), /long way/);
const longNoShot = mk('transition', [['forward_progress', 42.2, 'm'], ['elapsed', 4.8, 's'], ['actions', 3, 'events']], { ended_in_shot: false });
assert.equal(evidence.transitionBranch(longNoShot), 'progress');
assert.match(evidence.whyItMatters(longNoShot, 'fan'), /No shot followed/);
assert.doesNotMatch(evidence.whyItMatters(longNoShot, 'fan'), /42\.2 m/);   // adds context instead of repeating the story
assert.match(evidence.whyItMatters(longNoShot, 'analyst'), /ends without a shot/);
const opener = mk('goal', [['shot_distance', 10.6, 'm']], { score: { harbor: 0, vale: 1 } });
assert.equal(evidence.goalContext(opener).kind, 'opening');
assert.match(evidence.whyItMatters(opener, 'fan'), /first goal of the match/);
const leveller = mk('goal', [['shot_distance', 8, 'm']], { score: { harbor: 1, vale: 1 } }, 'harbor');
assert.equal(evidence.goalContext(leveller).kind, 'equaliser');
assert.doesNotMatch(evidence.whyItMatters(leveller, 'fan'), /every one is a key moment/);
// Cards and prose quote the same text for the same quantity.
const tie = mk('transition', [['forward_progress', 7.25, 'm'], ['elapsed', 3, 's']], { ended_in_shot: true });
assert.equal(evidence.keyValues(tie, 'fan')[0].value, '7.2');
assert.match(evidence.whyItMatters(tie, 'fan'), /only 7\.2 m gained/);
// Generation labels never present a template as AI output.
assert.equal(evidence.generation(mk('goal', [], {}), 'off'), 'rule');
assert.equal(evidence.generation(mk('goal', [], {}), 'cosmos'), 'pending');
assert.equal(evidence.generation({ ...mk('goal', [], {}), insight: { generation_mode: 'fallback', limitations: ['AI narration unavailable (timeout); …'] } }, 'cosmos'), 'fallback');

// Spanish rule-based stories follow the same branches and numbers; AI text is never machine-translated.
const i18n = await import(moduleUrl(new URL('../src/lib/i18n.ts', import.meta.url)));
const roster = [{ player_id: 'p1', name: 'Dario Wren' }];
const es = moment => ({ ...moment, player_id: 'p1', period: 1, match_time_ms: 24 * 60000, insight: { headline: 'H', casual_text: 'C', analyst_text: 'A', generation_mode: 'fallback', limitations: [] } });
const shotEs = i18n.storyEs(es(shortShot), roster);
assert.match(shotEs.casual, /disparan 6,5 segundos después/);
assert.doesNotMatch(shotEs.casual, /avanzan/);
assert.match(i18n.storyEs(es(longNoShot), roster).casual, /42,2 m en 4,8 segundos\. La jugada no termina en disparo/);
assert.equal(i18n.storyEs(es(opener), roster).headline, 'Vale Owls abren el marcador');
assert.match(i18n.whyEs(es(leveller), 'fan'), /igualado 1–1/);
const aiMoment = { ...es(opener), insight: { headline: 'AI headline', casual_text: 'AI text', analyst_text: 'AI analyst', generation_mode: 'ai', limitations: [] } };
assert.deepEqual([i18n.localStory(aiMoment, roster, 'es').casual, i18n.localStory(aiMoment, roster, 'es').englishOnly], ['AI text', true]);
assert.equal(i18n.localStory(es(opener), roster, 'en').headline, 'H');

console.log('Pitch checks passed: both directions, boundary coordinates, empty state, period markers, layers, evidence highlighting, clock labels, metric display rounding and evidence-led explanations.');
