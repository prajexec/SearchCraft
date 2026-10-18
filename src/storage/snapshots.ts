import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync, gzipSync } from 'node:zlib';

import { manifestSegmentFiles, readManifest, readSegment } from '../indexing/segment';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

const SNAPSHOT_MAGIC = 'SEARCHCRAFT_SNAPSHOT' as const;
const SNAPSHOT_FORMAT_VERSION = 1 as const;
const DATABASE_FILE_NAME = 'database.sqlite' as const;
const SQLITE_HEADER = Buffer.from('SQLite format 3\u0000', 'utf8');

/** A file stored in the archive, encoded as canonical base64. */
export interface SnapshotArchiveFile {
  readonly path: string;
  readonly data: string;
}

/**
 * The `database` member is the base64 payload of the fixed `database.sqlite`
 * archive member. Index files are relative to the archive root.
 */
export interface SnapshotArchive {
  readonly magic: typeof SNAPSHOT_MAGIC;
  readonly formatVersion: typeof SNAPSHOT_FORMAT_VERSION;
  readonly createdAt: string;
  readonly database: string;
  readonly files: readonly SnapshotArchiveFile[];
}

export interface SnapshotMetadata {
  readonly magic: typeof SNAPSHOT_MAGIC;
  readonly formatVersion: typeof SNAPSHOT_FORMAT_VERSION;
  readonly createdAt: string;
  readonly indexCount: number;
  readonly fileCount: number;
}

interface ValidatedArchive {
  readonly archive: SnapshotArchive;
  readonly database: Buffer;
  readonly indexNames: readonly string[];
}

interface ArchivePathParts {
  readonly indexName: string;
  readonly kind: 'manifest' | 'segment';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidArchive(message: string): never {
  throw new Error(`Invalid snapshot archive: ${message}`);
}

function invalidSource(message: string): never {
  throw new Error(`Cannot create snapshot archive: ${message}`);
}

function isSafeIndexName(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
}

function isSafeRelativeSegmentPath(value: string): boolean {
  if (value.length === 0 || value.includes('\\') || value.startsWith('/')) {
    return false;
  }
  const parts = value.split('/');
  return (
    parts.length >= 2 &&
    parts[0] === 'generations' &&
    parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

function parseArchivePath(value: string): ArchivePathParts {
  if (
    value.length === 0 ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[a-zA-Z]:/.test(value)
  ) {
    invalidArchive(`unsafe relative path "${value}"`);
  }

  const parts = value.split('/');
  if (
    parts.some((part) => part.length === 0 || part === '.' || part === '..') ||
    parts[0] !== 'indexes' ||
    parts.length < 3
  ) {
    invalidArchive(`unsafe relative path "${value}"`);
  }

  const indexName = parts[1];
  if (indexName === undefined || !isSafeIndexName(indexName)) {
    invalidArchive(`unsafe index path "${value}"`);
  }

  if (parts[2] === 'manifest.json' && parts.length === 3) {
    return { indexName, kind: 'manifest' };
  }

  if (parts[2] === 'generations' && parts.length >= 4) {
    return { indexName, kind: 'segment' };
  }

  invalidArchive(`path is outside an active index "${value}"`);
}

function decodeBase64(value: unknown, description: string): Buffer {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    invalidArchive(`${description} is not valid base64`);
  }

  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== value) {
    invalidArchive(`${description} is not valid base64`);
  }
  return decoded;
}

function validateSqlitePayload(payload: Buffer): void {
  if (payload.length < SQLITE_HEADER.length || !payload.subarray(0, 16).equals(SQLITE_HEADER)) {
    invalidArchive('database payload is not a SQLite database');
  }

  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'searchcraft-snapshot-database-'));
  const temporaryDatabasePath = join(temporaryDirectory, DATABASE_FILE_NAME);
  let connection: DatabaseSync | undefined;
  try {
    writeFileSync(temporaryDatabasePath, payload, { flag: 'wx' });
    connection = new DatabaseSync(temporaryDatabasePath, { readOnly: true });
    connection.prepare('PRAGMA schema_version').get();
  } catch {
    invalidArchive('database payload is not a readable SQLite database');
  } finally {
    connection?.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function validateCreatedAt(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function regularFile(path: string, description: string): void {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    invalidSource(`${description} is missing`);
  }
  if (!stats.isFile()) {
    invalidSource(`${description} must be a regular file`);
  }
}

function sourceDirectory(path: string, description: string): boolean {
  try {
    const stats = lstatSync(path);
    if (!stats.isDirectory()) {
      invalidSource(`${description} must be a directory`);
    }
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function sourceFile(path: string, archivePath: string): SnapshotArchiveFile {
  regularFile(path, `active file ${archivePath}`);
  return {
    path: archivePath,
    data: readFileSync(path).toString('base64'),
  };
}

function sourceSegmentPath(indexDirectory: string, segmentFile: string): string {
  let currentPath = indexDirectory;
  const parts = segmentFile.split('/');
  for (const [index, part] of parts.entries()) {
    currentPath = join(currentPath, part);
    let stats;
    try {
      stats = lstatSync(currentPath);
    } catch {
      invalidSource(`active segment "${segmentFile}" is missing`);
    }
    if (stats.isSymbolicLink()) {
      invalidSource(`active segment "${segmentFile}" uses a symbolic link`);
    }
    if (index < parts.length - 1 && !stats.isDirectory()) {
      invalidSource(`active segment parent "${part}" must be a directory`);
    }
  }
  return currentPath;
}

function readActiveIndexFiles(dataDirectory: string): readonly SnapshotArchiveFile[] {
  const indexesDirectory = join(dataDirectory, 'indexes');
  if (!sourceDirectory(indexesDirectory, 'indexes directory')) {
    return [];
  }

  const files: SnapshotArchiveFile[] = [];
  const indexEntries = readdirSync(indexesDirectory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  for (const entry of indexEntries) {
    const indexName = entry.name;
    if (!isSafeIndexName(indexName)) {
      invalidSource(`unsafe index directory "${indexName}"`);
    }

    const indexDirectory = join(indexesDirectory, indexName);
    if (!entry.isDirectory()) {
      invalidSource(`index path "${indexName}" must be a directory`);
    }
    if (!sourceDirectory(indexDirectory, `index directory "${indexName}"`)) {
      invalidSource(`index directory "${indexName}" is missing`);
    }

    const manifestFile = join(indexDirectory, 'manifest.json');
    const manifest = readManifest(manifestFile, indexName);
    if (manifest === undefined) {
      invalidSource(`manifest for index "${indexName}" is missing or invalid`);
    }
    regularFile(manifestFile, `manifest for index "${indexName}"`);
    files.push(sourceFile(manifestFile, `indexes/${indexName}/manifest.json`));

    for (const segmentFile of manifestSegmentFiles(manifest)) {
      if (!isSafeRelativeSegmentPath(segmentFile)) {
        invalidSource(`unsafe active segment path "${segmentFile}"`);
      }
      const segmentPath = sourceSegmentPath(indexDirectory, segmentFile);
      regularFile(segmentPath, `active segment "${segmentFile}"`);
      if (readSegment(segmentPath, indexName) === undefined) {
        invalidSource(`active segment "${segmentFile}" is invalid`);
      }
      files.push(sourceFile(segmentPath, `indexes/${indexName}/${segmentFile}`));
    }
  }

  return files;
}

function validateArchiveFiles(files: readonly SnapshotArchiveFile[]): readonly string[] {
  const paths = new Set<string>();
  const decodedFiles = new Map<string, Buffer>();
  const manifestPaths = new Map<string, string>();

  for (const file of files) {
    if (!isRecord(file) || typeof file.path !== 'string' || typeof file.data !== 'string') {
      invalidArchive('index files must contain path and base64 data');
    }
    if (paths.has(file.path)) {
      invalidArchive(`duplicate path "${file.path}"`);
    }
    const pathParts = parseArchivePath(file.path);
    const data = decodeBase64(file.data, `file "${file.path}"`);
    paths.add(file.path);
    decodedFiles.set(file.path, data);
    if (pathParts.kind === 'manifest') {
      manifestPaths.set(file.path, pathParts.indexName);
    }
  }

  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'searchcraft-snapshot-files-'));
  try {
    for (const [path, data] of decodedFiles) {
      const temporaryPath = join(temporaryDirectory, ...path.split('/'));
      mkdirSync(dirname(temporaryPath), { recursive: true });
      writeFileSync(temporaryPath, data, { flag: 'wx' });
    }

    const expectedPaths = new Set<string>();
    const indexNames = new Set<string>();
    for (const [manifestPath, indexName] of manifestPaths) {
      if (indexNames.has(indexName)) {
        invalidArchive(`duplicate manifest for index "${indexName}"`);
      }
      indexNames.add(indexName);
      expectedPaths.add(manifestPath);

      const manifest = readManifest(
        join(temporaryDirectory, ...manifestPath.split('/')),
        indexName,
      );
      if (manifest === undefined) {
        invalidArchive(`manifest "${manifestPath}" is invalid`);
      }

      for (const segmentFile of manifestSegmentFiles(manifest)) {
        if (!isSafeRelativeSegmentPath(segmentFile)) {
          invalidArchive(`unsafe active segment path "${segmentFile}"`);
        }
        const segmentPath = `indexes/${indexName}/${segmentFile}`;
        if (expectedPaths.has(segmentPath) || !decodedFiles.has(segmentPath)) {
          invalidArchive(`active segment "${segmentPath}" is missing or duplicated`);
        }
        if (
          readSegment(join(temporaryDirectory, ...segmentPath.split('/')), indexName) === undefined
        ) {
          invalidArchive(`active segment "${segmentPath}" is invalid`);
        }
        expectedPaths.add(segmentPath);
      }
    }

    for (const path of paths) {
      if (!expectedPaths.has(path)) {
        invalidArchive(`file "${path}" is not referenced by an active manifest`);
      }
    }

    return [...indexNames].sort();
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function parseAndValidateArchive(value: unknown): ValidatedArchive {
  if (!isRecord(value)) {
    invalidArchive('JSON root must be an object');
  }
  if (value.magic !== SNAPSHOT_MAGIC) {
    invalidArchive('magic is invalid');
  }
  if (value.formatVersion !== SNAPSHOT_FORMAT_VERSION) {
    invalidArchive('formatVersion is unsupported');
  }
  if (!validateCreatedAt(value.createdAt)) {
    invalidArchive('createdAt is invalid');
  }
  if (!Array.isArray(value.files)) {
    invalidArchive('files must be an array');
  }

  const database = decodeBase64(value.database, `${DATABASE_FILE_NAME} payload`);
  validateSqlitePayload(database);

  const files: SnapshotArchiveFile[] = [];
  for (const file of value.files) {
    if (!isRecord(file) || typeof file.path !== 'string' || typeof file.data !== 'string') {
      invalidArchive('index files must contain path and base64 data');
    }
    files.push({ path: file.path, data: file.data });
  }

  const archive: SnapshotArchive = {
    magic: SNAPSHOT_MAGIC,
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    createdAt: value.createdAt,
    database: value.database as string,
    files,
  };
  const indexNames = validateArchiveFiles(archive.files);
  return { archive, database, indexNames };
}

function archiveMetadata(
  archive: SnapshotArchive,
  indexNames: readonly string[],
): SnapshotMetadata {
  return {
    magic: archive.magic,
    formatVersion: archive.formatVersion,
    createdAt: archive.createdAt,
    indexCount: indexNames.length,
    fileCount: archive.files.length,
  };
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

function sqliteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function writeArchiveAtomically(archive: SnapshotArchive, outputPath: string): void {
  const outputDirectory = dirname(outputPath);
  mkdirSync(outputDirectory, { recursive: true });
  const temporaryPath = join(outputDirectory, `.snapshot-${randomUUID()}.tmp`);
  try {
    const compressed = gzipSync(Buffer.from(`${JSON.stringify(archive)}\n`, 'utf8'));
    writeFileSync(temporaryPath, compressed, { flag: 'wx' });
    renameSync(temporaryPath, outputPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function readValidatedSnapshotArchive(archivePath: string): ValidatedArchive {
  try {
    const json = gunzipSync(readFileSync(archivePath)).toString('utf8');
    return parseAndValidateArchive(JSON.parse(json) as unknown);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid snapshot archive:')) {
      throw error;
    }
    throw new Error('Invalid snapshot archive: gzip or JSON payload could not be read', {
      cause: error,
    });
  }
}

function installIndexesAtomically(
  targetDataDirectory: string,
  files: readonly SnapshotArchiveFile[],
): void {
  const stagingDirectory = mkdtempSync(
    join(targetDataDirectory, `.indexes-restore-${randomUUID()}-`),
  );
  const stagingIndexesDirectory = join(stagingDirectory, 'indexes');
  const targetIndexesDirectory = join(targetDataDirectory, 'indexes');
  let backupDirectory: string | undefined;
  let existingMoved = false;
  let stagedInstalled = false;

  try {
    mkdirSync(stagingIndexesDirectory, { recursive: true });
    for (const file of files) {
      const destination = join(stagingDirectory, ...file.path.split('/'));
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, decodeBase64(file.data, `file "${file.path}"`), { flag: 'wx' });
    }

    if (existsSync(targetIndexesDirectory)) {
      const stats = lstatSync(targetIndexesDirectory);
      if (!stats.isDirectory()) {
        throw new Error('Cannot restore snapshot: target indexes path must be a directory');
      }
      backupDirectory = join(targetDataDirectory, `.indexes-before-restore-${randomUUID()}`);
      renameSync(targetIndexesDirectory, backupDirectory);
      existingMoved = true;
    }

    renameSync(stagingIndexesDirectory, targetIndexesDirectory);
    stagedInstalled = true;
    if (backupDirectory !== undefined) {
      rmSync(backupDirectory, { recursive: true, force: true });
      backupDirectory = undefined;
    }
  } catch (error) {
    if (existingMoved && !stagedInstalled && backupDirectory !== undefined) {
      renameSync(backupDirectory, targetIndexesDirectory);
      backupDirectory = undefined;
    }
    throw error;
  } finally {
    if (backupDirectory !== undefined) {
      rmSync(backupDirectory, { recursive: true, force: true });
    }
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

/**
 * Create a gzip-compressed snapshot from the live SQLite connection and the
 * active index files below `dataDirectory`.
 */
export function createSnapshotArchive(
  database: DatabaseSyncType,
  dataDirectory: string,
  outputPath: string,
): SnapshotMetadata {
  const outputDirectory = dirname(outputPath);
  mkdirSync(outputDirectory, { recursive: true });
  const temporaryDirectory = mkdtempSync(
    join(outputDirectory, `.snapshot-vacuum-${randomUUID()}-`),
  );
  const temporaryDatabasePath = join(temporaryDirectory, DATABASE_FILE_NAME);

  try {
    database.exec(`VACUUM INTO ${sqliteLiteral(temporaryDatabasePath)}`);
    const databasePayload = readFileSync(temporaryDatabasePath);
    if (!databasePayload.subarray(0, 16).equals(SQLITE_HEADER)) {
      throw new Error('SQLite VACUUM INTO did not produce a database file');
    }

    const archive: SnapshotArchive = {
      magic: SNAPSHOT_MAGIC,
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      database: databasePayload.toString('base64'),
      files: readActiveIndexFiles(dataDirectory),
    };
    const validated = parseAndValidateArchive(archive);
    writeArchiveAtomically(validated.archive, outputPath);
    return archiveMetadata(validated.archive, validated.indexNames);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function readSnapshotArchive(archivePath: string): SnapshotArchive {
  return readValidatedSnapshotArchive(archivePath).archive;
}

/**
 * Restore a validated snapshot after the caller has stopped the service and
 * closed its SQLite connection. Database replacement is a temp-file rename;
 * active indexes are staged and swapped while unrelated target data remains.
 */
export function restoreSnapshotArchive(
  archivePath: string,
  targetDataDirectory: string,
  targetDatabasePath: string,
): SnapshotMetadata {
  const validated = readValidatedSnapshotArchive(archivePath);

  mkdirSync(targetDataDirectory, { recursive: true });
  const targetDatabaseDirectory = dirname(targetDatabasePath);
  mkdirSync(targetDatabaseDirectory, { recursive: true });
  installIndexesAtomically(targetDataDirectory, validated.archive.files);

  const temporaryDatabasePath = join(
    targetDatabaseDirectory,
    `.database-restore-${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporaryDatabasePath, validated.database, { flag: 'wx' });
    renameSync(temporaryDatabasePath, targetDatabasePath);
    removeIfPresent(`${targetDatabasePath}-wal`);
    removeIfPresent(`${targetDatabasePath}-shm`);
  } finally {
    rmSync(temporaryDatabasePath, { force: true });
  }

  return archiveMetadata(validated.archive, validated.indexNames);
}
