import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export interface PersistenceConfig {
  enabled: boolean;
  sqlitePath: string;
  auditEnabled: boolean;
  auditTtlDays: number;
  stateSnapshotFlushMs?: number;
  maxPendingStateSnapshots?: number;
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
  private upsertPresenceStmt: Database.Statement | null = null;
  private upsertStateSnapshotStmt: Database.Statement | null = null;
  private insertAuditStmt: Database.Statement | null = null;
  private vacuumAuditStmt: Database.Statement | null = null;
  private flushStateSnapshotsTx: ((rows: Array<{ path: string; value_json: string; updated_ts: number }>) => void) | null = null;
  private stateSnapshotFlushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pendingStateSnapshots = new Map<string, { value_json: string; updated_ts: number }>();
  private readonly stateSnapshotFlushMs: number;
  private readonly maxPendingStateSnapshots: number;

  constructor(private readonly config: PersistenceConfig) {
    this.stateSnapshotFlushMs = Math.max(25, config.stateSnapshotFlushMs ?? 250);
    this.maxPendingStateSnapshots = Math.max(100, config.maxPendingStateSnapshots ?? 5000);

    if (!config.enabled) {
      return;
    }

    const dir = path.dirname(config.sqlitePath);
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(config.sqlitePath);
    this.configureDatabase();
    this.migrate();
    this.prepareStatements();

    this.stateSnapshotFlushTimer = setInterval(() => {
      this.flushStateSnapshots(false);
    }, this.stateSnapshotFlushMs);
    this.stateSnapshotFlushTimer.unref?.();
  }

  close(): void {
    if (this.stateSnapshotFlushTimer) {
      clearInterval(this.stateSnapshotFlushTimer);
      this.stateSnapshotFlushTimer = null;
    }

    this.flushStateSnapshots(true);
    this.db?.close();
    this.db = null;
    this.upsertPresenceStmt = null;
    this.upsertStateSnapshotStmt = null;
    this.insertAuditStmt = null;
    this.vacuumAuditStmt = null;
    this.flushStateSnapshotsTx = null;
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
    if (!this.db || !this.upsertPresenceStmt) {
      return;
    }

    this.upsertPresenceStmt.run({
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

    this.pendingStateSnapshots.set(path, {
      value_json: JSON.stringify(value),
      updated_ts: updatedTs
    });

    if (this.pendingStateSnapshots.size >= this.maxPendingStateSnapshots) {
      this.flushStateSnapshots(false);
    }
  }

  insertAudit(event: string, payload: unknown, ts: number): void {
    if (!this.db || !this.config.auditEnabled || !this.insertAuditStmt) {
      return;
    }

    this.insertAuditStmt.run({
      ts,
      event,
      payload_json: JSON.stringify(payload)
    });
  }

  vacuumAudit(nowTs: number): void {
    if (!this.db || !this.config.auditEnabled || !this.vacuumAuditStmt) {
      return;
    }

    const threshold = nowTs - this.config.auditTtlDays * 24 * 60 * 60 * 1000;
    this.vacuumAuditStmt.run(threshold);
  }

  private configureDatabase(): void {
    if (!this.db) {
      return;
    }

    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
    } catch {
      // Keep defaults when pragmas are not available.
    }
  }

  private prepareStatements(): void {
    if (!this.db) {
      return;
    }

    this.upsertPresenceStmt = this.db.prepare(
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
    );

    this.upsertStateSnapshotStmt = this.db.prepare(
      `
      INSERT INTO state_snapshot(path, value_json, updated_ts)
      VALUES (@path, @value_json, @updated_ts)
      ON CONFLICT(path)
      DO UPDATE SET
        value_json = excluded.value_json,
        updated_ts = excluded.updated_ts
    `
    );

    this.flushStateSnapshotsTx = this.db.transaction((rows: Array<{ path: string; value_json: string; updated_ts: number }>) => {
      if (!this.upsertStateSnapshotStmt) {
        return;
      }
      for (const row of rows) {
        this.upsertStateSnapshotStmt.run(row);
      }
    });

    this.insertAuditStmt = this.db.prepare(
      `
      INSERT INTO audit(ts, event, payload_json)
      VALUES (@ts, @event, @payload_json)
    `
    );

    this.vacuumAuditStmt = this.db.prepare("DELETE FROM audit WHERE ts < ?");
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

  private flushStateSnapshots(throwOnError: boolean): void {
    if (!this.db || !this.flushStateSnapshotsTx || this.pendingStateSnapshots.size === 0) {
      return;
    }

    const rows = Array.from(this.pendingStateSnapshots.entries()).map(([path, value]) => ({
      path,
      value_json: value.value_json,
      updated_ts: value.updated_ts
    }));
    this.pendingStateSnapshots.clear();

    try {
      this.flushStateSnapshotsTx(rows);
    } catch (error) {
      for (const row of rows) {
        this.pendingStateSnapshots.set(row.path, {
          value_json: row.value_json,
          updated_ts: row.updated_ts
        });
      }
      if (throwOnError) {
        throw error;
      }
    }
  }
}
