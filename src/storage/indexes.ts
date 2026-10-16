import type { DatabaseSync } from 'node:sqlite';

import type { IndexConfig, IndexMetadata } from '../indexes/index-config';

interface IndexRow {
  readonly name: string;
  readonly config_json: string;
  readonly state: string;
  readonly active_generation: number;
  readonly created_at: string;
  readonly updated_at: string;
}

function toMetadata(row: IndexRow): IndexMetadata {
  return {
    name: row.name,
    config: JSON.parse(row.config_json) as IndexConfig,
    state: row.state,
    activeGeneration: row.active_generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class IndexRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(name: string, config: IndexConfig): IndexMetadata | undefined {
    const now = new Date().toISOString();
    try {
      this.database
        .prepare(
          `INSERT INTO indexes (name, config_json, state, active_generation, created_at, updated_at)
           VALUES (?, ?, 'active', 0, ?, ?)`,
        )
        .run(name, JSON.stringify(config), now, now);
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        return undefined;
      }
      throw error;
    }
    return this.get(name);
  }

  public get(name: string): IndexMetadata | undefined {
    const row = this.database
      .prepare(
        'SELECT name, config_json, state, active_generation, created_at, updated_at FROM indexes WHERE name = ?',
      )
      .get(name) as unknown as IndexRow | undefined;
    return row === undefined ? undefined : toMetadata(row);
  }

  public list(): readonly IndexMetadata[] {
    const rows = this.database
      .prepare(
        'SELECT name, config_json, state, active_generation, created_at, updated_at FROM indexes ORDER BY name',
      )
      .all() as unknown as IndexRow[];
    return rows.map(toMetadata);
  }

  public setActiveGeneration(name: string, generation: number): void {
    this.database
      .prepare('UPDATE indexes SET active_generation = ?, updated_at = ? WHERE name = ?')
      .run(generation, new Date().toISOString(), name);
  }
}
