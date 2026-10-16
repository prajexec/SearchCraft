/* global process */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.cwd());
const requiredFiles = [
  'README.md',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  'docs/PROJECT_PLAN.md',
  'docs/api/openapi.json',
  'docs/architecture/ARCHITECTURE.md',
  'docs/architecture/SEARCH_ALGORITHMS.md',
  'docs/architecture/STORAGE_FORMAT.md',
  'docs/architecture/FAILURE_MODES.md',
  'docs/architecture/SECURITY.md',
  'docs/development/SETUP.md',
  'docs/development/TESTING.md',
  'docs/development/BENCHMARKING.md',
  'docs/operations/RUNBOOK.md',
  'docs/operations/RECOVERY.md',
  'docs/decisions/ADR-0001-lightweight-architecture.md',
];

for (const relativePath of requiredFiles) {
  const absolutePath = join(root, relativePath);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    throw new Error(`Required documentation file is missing: ${relativePath}`);
  }
}

const diagramDirectory = join(root, 'docs/architecture/diagrams');
const diagrams = readdirSync(diagramDirectory).filter((file) => file.endsWith('.mmd'));
if (diagrams.length < 4) {
  throw new Error('At least four foundational Mermaid diagrams are required');
}

for (const diagram of diagrams) {
  const contents = readFileSync(join(diagramDirectory, diagram), 'utf8').trim();
  if (contents.length === 0) {
    throw new Error(`Mermaid diagram is empty: ${diagram}`);
  }
}

const readme = readFileSync(join(root, 'README.md'), 'utf8');
if (!readme.includes('Current status') || !readme.includes('Known limitations')) {
  throw new Error('README must distinguish implemented functionality from limitations');
}

process.stdout.write(`Documentation check passed (${diagrams.length} Mermaid diagrams)\n`);
