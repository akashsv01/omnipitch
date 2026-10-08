import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
const ajv = new Ajv2020();
addFormats(ajv);
for (const name of ['event', 'insight', 'match-state']) {
  const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  const schema = read(`../../../contracts/schemas/${name}.schema.json`);
  const fixture = read(`../../../contracts/examples/${name}.example.json`);
  const validate = ajv.compile(schema);
  if (!validate(fixture)) throw new Error(`${name}: ${JSON.stringify(validate.errors)}`);
  console.log(`${name} fixture: valid`);
}
