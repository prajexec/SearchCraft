import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { openapiDocument } from '../http/openapi';

const target = resolve(process.cwd(), 'docs/api/openapi.json');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(openapiDocument, null, 2)}\n`, 'utf8');
process.stdout.write(`Wrote ${target}\n`);
