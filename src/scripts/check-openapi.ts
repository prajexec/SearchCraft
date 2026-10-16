import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { openapiDocument } from '../http/openapi';

const path = resolve(process.cwd(), 'docs/api/openapi.json');
const checkedIn = JSON.parse(readFileSync(path, 'utf8')) as unknown;
const expected = JSON.stringify(openapiDocument);
const actual = JSON.stringify(checkedIn);

if (actual !== expected) {
  throw new Error(`${path} is stale; run npm run docs:generate`);
}

process.stdout.write(`OpenAPI document is synchronized: ${path}\n`);
