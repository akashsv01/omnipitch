import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
const ajv = new Ajv2020({ allowUnionTypes: true });
addFormats(ajv);
const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const names = ['event', 'insight', 'match-state', 'analysis', 'moment', 'replay', 'recap', 'reconciliation', 'push'];
for (const name of names) ajv.addSchema(read(`../../../contracts/schemas/${name}.schema.json`));
for (const name of ['event', 'insight', 'match-state', 'replay', 'recap']) {
  const schema = read(`../../../contracts/schemas/${name}.schema.json`);
  const fixture = read(`../../../contracts/examples/${name}.example.json`);
  const validate = ajv.getSchema(schema.$id);
  if (!validate(fixture)) throw new Error(`${name}: ${JSON.stringify(validate.errors)}`);
  console.log(`${name} fixture: valid`);
}
const validatePush = ajv.getSchema('https://omnipitch.local/contracts/push.schema.json');
for (const name of ['push', 'push-state', 'push-insight', 'push-period-reconciled']) {
  const fixture = read(`../../../contracts/examples/${name}.example.json`);
  if (!validatePush(fixture)) throw new Error(`${name}: ${JSON.stringify(validatePush.errors)}`);
  console.log(`${name} fixture: valid`);
}
// Invalid examples must be rejected: a shot without on_target/is_goal and a located period marker.
const event = read('../../../contracts/examples/event.example.json');
const validateEvent = ajv.getSchema('https://omnipitch.local/contracts/event.schema.json');
for (const [label, invalid] of [
  ['shot without flags', { ...event, type: 'shot', outcome: 'goal' }],
  ['period marker with team', { ...event, type: 'period_start', outcome: 'none' }],
  ['schema 1.0 tackle', { ...event, schema_version: '1.0', type: 'tackle', outcome: 'won', end: null }],
]) {
  if (validateEvent(invalid)) throw new Error(`invalid example accepted: ${label}`);
  console.log(`invalid ${label}: rejected`);
}
