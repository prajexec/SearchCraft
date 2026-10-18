import { existsSync } from 'node:fs';

import { loadConfig } from '../config';
import { createSnapshotArchive, restoreSnapshotArchive } from '../storage/snapshots';
import { initializeDatabase } from '../storage/sqlite';

function usage(): string {
  return [
    'Usage:',
    '  npm run snapshot:create -- --output <archive.gz>',
    '  npm run snapshot:restore -- --archive <archive.gz>',
    '',
    'The SEARCHCRAFT_DATA_DIR and SEARCHCRAFT_DB_PATH environment variables select',
    'the source or restore target. Stop SearchCraft before restoring.',
  ].join('\n');
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function requiredOption(name: string): string {
  const value = option(name);
  if (value === undefined || value === '') {
    throw new Error(`${name} is required\n\n${usage()}`);
  }
  return value;
}

function createSnapshot(outputPath: string): void {
  const config = loadConfig();
  const database = initializeDatabase(config.dbPath);
  try {
    const metadata = createSnapshotArchive(database.connection, config.dataDir, outputPath);
    process.stdout.write(
      `${JSON.stringify({ command: 'snapshot:create', outputPath, ...metadata })}\n`,
    );
  } finally {
    database.connection.close();
  }
}

function restoreSnapshot(archivePath: string): void {
  if (!existsSync(archivePath)) {
    throw new Error(`Snapshot archive does not exist: ${archivePath}`);
  }
  const config = loadConfig();
  const metadata = restoreSnapshotArchive(archivePath, config.dataDir, config.dbPath);
  process.stdout.write(
    `${JSON.stringify({
      command: 'snapshot:restore',
      archivePath,
      dataDir: config.dataDir,
      dbPath: config.dbPath,
      ...metadata,
    })}\n`,
  );
}

function main(): void {
  const command = process.argv[2];
  if (command === '--help' || command === undefined) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (command === 'create') {
    createSnapshot(requiredOption('--output'));
    return;
  }
  if (command === 'restore') {
    restoreSnapshot(requiredOption('--archive'));
    return;
  }
  throw new Error(`Unknown snapshot command "${command}"\n\n${usage()}`);
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
}
