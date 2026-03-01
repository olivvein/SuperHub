import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export interface PersistenceConfig {
  enabled: boolean;
  sqlitePath: string;
  auditEnabled: boolean;
  auditTtlDays: number;
}

export interface PersistedPresence {
  serviceName: string;
  clientId: string;
  instanceId: string;
  sessionId: string;
  provides: string[];
  consumes: string[];
  tags: string[];
  version: string;
  lastSeenTs: number;
  online: boolean;
}

export class HubPersistence {
  private db: Database.Database | null = null;

  constructor(private readonly config: PersistenceConfig) {
    if (!config.enabled) {
      return;
    }

    const dir = path.dirname(config.sqlitePath);
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(config.sqlitePath);
    this.migrate();
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  loadSnapshots(): Array<{ path: string; value: unknown }> {
    if (!this.db) {
      return [];
    }

    const rows = this.db.prepare("SELECT path, value_json FROM state_snapshot").all() as Array<{
      path: string;
      value_json: string;
    }>;

    return rows.map((row) => ({
      path: row.path,
      value: JSON.parse(row.value_json)
    }));
  }

  upsertPresence(entry: PersistedPresence): void {
    if (!this.db) {
      return;
    }

    this.db
      .prepare(
        `
      INSERT INTO services_last (
        service_name,
        client_id,
        instance_id,
        session_id,
        provides_json,
        consumes_json,
        tags_json,
        version,
        last_seen_ts,
        online
      ) VALUES (
        @serviceName,
        @clientId,
        @instanceId,
        @sessionId,
        @provides_json,
        @consumes_json,
        @tags_json,
        @version,
        @lastSeenTs,
        @online
      )
      ON CONFLICT(service_name, instance_id)
      DO UPDATE SET
        client_id = excluded.client_id,
        session_id = excluded.session_id,
        provides_json = excluded.provides_json,
        consumes_json = excluded.consumes_json,
        tags_json = excluded.tags_json,
        version = excluded.version,
        last_seen_ts = excluded.last_seen_ts,
        online = excluded.online
    `
      )
      .run({
        ...entry,
        provides_json: JSON.stringify(entry.provides),
        consumes_json: JSON.stringify(entry.consumes),
        tags_json: JSON.stringify(entry.tags),
        online: entry.online ? 1 : 0
      });
  }

  saveStateSnapshot(path: string, value: unknown, updatedTs: number): void {
    if (!this.db) {
      return;
    }

    this.db
      .prepare(
        `
      INSERT INTO state_snapshot(path, value_json, updated_ts)
      VALUES (@path, @value_json, @updated_ts)
      ON CONFLICT(path)
      DO UPDATE SET
        value_json = excluded.value_json,
        updated_ts = excluded.updated_ts
    `
      )
      .run({
        path,
        value_json: JSON.stringify(value),
        updated_ts: updatedTs
      });
  }

  insertAudit(event: string, payload: unknown, ts: number): void {
    if (!this.db || !this.config.auditEnabled) {
      return;
    }

    this.db
      .prepare(
        `
      INSERT INTO audit(ts, event, payload_json)
      VALUES (@ts, @event, @payload_json)
    `
      )
      .run({
        ts,
        event,
        payload_json: JSON.stringify(payload)
      });
  }

  vacuumAudit(nowTs: number): void {
    if (!this.db || !this.config.auditEnabled) {
      return;
    }

    const threshold = nowTs - this.config.auditTtlDays * 24 * 60 * 60 * 1000;
    this.db.prepare("DELETE FROM audit WHERE ts < ?").run(threshold);
  }

  private migrate(): void {
    if (!this.db) {
      return;
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS services_last (
        service_name TEXT NOT NULL,
        client_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        provides_json TEXT NOT NULL,
        consumes_json TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        version TEXT NOT NULL,
        last_seen_ts INTEGER NOT NULL,
        online INTEGER NOT NULL,
        PRIMARY KEY(service_name, instance_id)
      );

      CREATE TABLE IF NOT EXISTS state_snapshot (
        path TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_ts INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        event TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
    `);
  }
}
