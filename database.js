const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function json(value, fallback = null) {
  if (value === undefined) return fallback;
  return JSON.stringify(value);
}

class AppDatabase {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.db = new DatabaseSync(this.filePath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.migrate();
    this.prepareStatements();
  }

  tableExists(name) {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(name));
  }

  createSchemaV2() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS environments (
        id TEXT PRIMARY KEY,
        name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        environment_id TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_interaction_id TEXT,
        last_prompt TEXT,
        last_output TEXT,
        last_steps_json TEXT,
        FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_environment_updated
        ON sessions(environment_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS interactions (
        interaction_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        prompt TEXT NOT NULL DEFAULT '',
        output_text TEXT NOT NULL DEFAULT '',
        steps_json TEXT,
        status TEXT,
        model TEXT,
        usage_json TEXT,
        request_json TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_interactions_session_created
        ON interactions(session_id, created_at);

      CREATE TABLE IF NOT EXISTS artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        environment_id TEXT NOT NULL,
        interaction_id TEXT,
        file_path TEXT NOT NULL,
        filename TEXT NOT NULL,
        provider TEXT,
        size_bytes INTEGER,
        download_url TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(environment_id, file_path),
        FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS task_errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        environment_id TEXT,
        previous_interaction_id TEXT,
        code TEXT,
        http_status INTEGER,
        message TEXT NOT NULL,
        request_json TEXT,
        error_json TEXT,
        created_at INTEGER NOT NULL
      );
    `);
  }

  migrateV1ToV2() {
    this.db.exec('PRAGMA foreign_keys = OFF;');
    try {
      this.db.exec(`
        BEGIN IMMEDIATE;

        ALTER TABLE sessions RENAME TO sessions_v1;
        ALTER TABLE interactions RENAME TO interactions_v1;
        ALTER TABLE artifacts RENAME TO artifacts_v1;
        ALTER TABLE task_errors RENAME TO task_errors_v1;

        CREATE TABLE environments (
          id TEXT PRIMARY KEY,
          name TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          environment_id TEXT NOT NULL,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_interaction_id TEXT,
          last_prompt TEXT,
          last_output TEXT,
          last_steps_json TEXT,
          FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE
        );

        CREATE TABLE interactions (
          interaction_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          prompt TEXT NOT NULL DEFAULT '',
          output_text TEXT NOT NULL DEFAULT '',
          steps_json TEXT,
          status TEXT,
          model TEXT,
          usage_json TEXT,
          request_json TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );

        CREATE TABLE artifacts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          environment_id TEXT NOT NULL,
          interaction_id TEXT,
          file_path TEXT NOT NULL,
          filename TEXT NOT NULL,
          provider TEXT,
          size_bytes INTEGER,
          download_url TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(environment_id, file_path),
          FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE
        );

        CREATE TABLE task_errors (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          environment_id TEXT,
          previous_interaction_id TEXT,
          code TEXT,
          http_status INTEGER,
          message TEXT NOT NULL,
          request_json TEXT,
          error_json TEXT,
          created_at INTEGER NOT NULL
        );

        INSERT INTO environments(id, name, created_at, updated_at)
        SELECT environment_id, '沙盒 ' || substr(environment_id, -6), MIN(created_at), MAX(updated_at)
        FROM sessions_v1
        GROUP BY environment_id;

        INSERT INTO sessions
        SELECT * FROM sessions_v1;

        INSERT INTO interactions
        SELECT * FROM interactions_v1;

        INSERT INTO artifacts(
          id, environment_id, interaction_id, file_path, filename,
          provider, size_bytes, download_url, created_at, updated_at
        )
        SELECT a.id, s.environment_id, a.interaction_id, a.file_path, a.filename,
               a.provider, a.size_bytes, a.download_url, a.created_at, a.updated_at
        FROM artifacts_v1 a
        JOIN sessions_v1 s ON s.id = a.session_id;

        INSERT INTO task_errors(
          id, environment_id, previous_interaction_id, code, http_status,
          message, request_json, error_json, created_at
        )
        SELECT e.id, COALESCE(s.environment_id, e.session_id), e.previous_interaction_id,
               e.code, e.http_status, e.message, e.request_json, e.error_json, e.created_at
        FROM task_errors_v1 e
        LEFT JOIN sessions_v1 s ON s.id = e.session_id;

        DROP TABLE interactions_v1;
        DROP TABLE artifacts_v1;
        DROP TABLE task_errors_v1;
        DROP TABLE sessions_v1;

        CREATE INDEX idx_sessions_environment_updated
          ON sessions(environment_id, updated_at DESC);
        CREATE INDEX idx_interactions_session_created
          ON interactions(session_id, created_at);

        INSERT INTO schema_migrations(version, applied_at)
        VALUES (2, unixepoch('now') * 1000);

        COMMIT;
      `);
    } catch (error) {
      try { this.db.exec('ROLLBACK;'); } catch {}
      throw error;
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON;');
    }
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);

    if (!this.tableExists('sessions')) {
      this.createSchemaV2();
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, ?)').run(Date.now());
      return;
    }

    const versionRow = this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();
    const version = Number(versionRow?.version || 1);
    if (version < 2 || !this.tableExists('environments')) {
      this.migrateV1ToV2();
    }
    this.createSchemaV2();
  }

  prepareStatements() {
    this.upsertEnvironmentStmt = this.db.prepare(`
      INSERT INTO environments(id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = COALESCE(environments.name, excluded.name),
        updated_at = MAX(environments.updated_at, excluded.updated_at)
    `);

    this.upsertSessionStmt = this.db.prepare(`
      INSERT INTO sessions (
        id, environment_id, name, created_at, updated_at,
        last_interaction_id, last_prompt, last_output, last_steps_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        environment_id = excluded.environment_id,
        name = excluded.name,
        updated_at = MAX(sessions.updated_at, excluded.updated_at),
        last_interaction_id = CASE WHEN excluded.last_interaction_id IS NOT NULL AND excluded.updated_at >= sessions.updated_at THEN excluded.last_interaction_id ELSE sessions.last_interaction_id END,
        last_prompt = CASE WHEN excluded.last_interaction_id IS NOT NULL AND excluded.updated_at >= sessions.updated_at THEN excluded.last_prompt ELSE sessions.last_prompt END,
        last_output = CASE WHEN excluded.last_interaction_id IS NOT NULL AND excluded.updated_at >= sessions.updated_at THEN excluded.last_output ELSE sessions.last_output END,
        last_steps_json = CASE WHEN excluded.last_interaction_id IS NOT NULL AND excluded.updated_at >= sessions.updated_at THEN excluded.last_steps_json ELSE sessions.last_steps_json END
    `);

    this.upsertInteractionStmt = this.db.prepare(`
      INSERT INTO interactions (
        interaction_id, session_id, prompt, output_text, steps_json,
        status, model, usage_json, request_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(interaction_id) DO UPDATE SET
        session_id = excluded.session_id,
        prompt = excluded.prompt,
        output_text = excluded.output_text,
        steps_json = excluded.steps_json,
        status = excluded.status,
        model = COALESCE(excluded.model, interactions.model),
        usage_json = COALESCE(excluded.usage_json, interactions.usage_json),
        request_json = COALESCE(excluded.request_json, interactions.request_json)
    `);
  }

  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = callback();
      this.db.exec('COMMIT;');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  ensureEnvironment(environmentId, details = {}) {
    if (!environmentId) return null;
    const id = String(environmentId);
    const now = Number(details.updatedAt || Date.now());
    this.upsertEnvironmentStmt.run(
      id,
      details.name || `沙盒 ${id.slice(-6)}`,
      Number(details.createdAt || now),
      now
    );
    return id;
  }

  ensureSession(environmentId, sessionId, details = {}) {
    if (!environmentId) return null;
    const envId = this.ensureEnvironment(environmentId, details);
    const requestedSession = sessionId
      ? this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId)
      : null;
    const existing = requestedSession?.environment_id === envId ? requestedSession : null;
    // Never move an existing session to another environment when a stale or
    // mismatched localSessionId is supplied. Generate a new session instead.
    const id = existing?.id || (sessionId && !requestedSession ? sessionId : null) || `session-${crypto.randomUUID()}`;
    const now = Number(details.updatedAt || Date.now());
    const name = details.name || existing?.name || `会话 ${new Date(now).toLocaleString('zh-CN', { hour12: false })}`;
    this.upsertSessionStmt.run(
      id,
      envId,
      name,
      Number(existing?.created_at || details.createdAt || now),
      now,
      details.lastInteractionId || null,
      details.lastPrompt ?? null,
      details.lastOutput ?? null,
      json(details.steps)
    );
    return id;
  }

  saveInteraction({ environmentId, sessionId, previousInteractionId, interactionId, prompt, outputText, steps, status, model, usage, request, timestamp, sessionName }) {
    if (!environmentId) return null;
    const createdAt = Number(timestamp || Date.now());
    const id = interactionId || `local-${crypto.randomUUID()}`;

    return this.transaction(() => {
      const previousSession = !sessionId && previousInteractionId
        ? this.db.prepare('SELECT session_id FROM interactions WHERE interaction_id = ?').get(previousInteractionId)
        : null;
      const resolvedSessionId = this.ensureSession(environmentId, sessionId || previousSession?.session_id, {
        name: sessionName,
        updatedAt: createdAt,
        lastInteractionId: id,
        lastPrompt: prompt || '',
        lastOutput: outputText || '',
        steps
      });

      this.upsertInteractionStmt.run(
        id,
        resolvedSessionId,
        prompt || '',
        outputText || '',
        json(steps, '[]'),
        status || null,
        model || null,
        json(usage),
        json(request),
        createdAt
      );
      return { interactionId: id, sessionId: resolvedSessionId };
    });
  }

  importLegacySessions(sessions) {
    if (!Array.isArray(sessions)) return { sessions: 0, turns: 0 };
    let sessionCount = 0;
    let turnCount = 0;

    this.transaction(() => {
      for (const session of sessions) {
        if (!session || typeof session !== 'object') continue;
        const environmentId = session.envId || session.environmentId || session.id;
        if (!environmentId) continue;
        const turns = Array.isArray(session.turns) && session.turns.length
          ? session.turns
          : (session.lastInteractionId || session.lastPrompt || session.lastOutput)
            ? [{
                interactionId: session.lastInteractionId,
                prompt: session.lastPrompt,
                outputText: session.lastOutput,
                steps: session.steps,
                timestamp: session.updatedAt
              }]
            : [];

        const resolvedSessionId = this.ensureSession(environmentId, session.id, {
          name: session.name,
          createdAt: session.createdAt || session.updatedAt,
          updatedAt: session.updatedAt,
          lastInteractionId: session.lastInteractionId,
          lastPrompt: session.lastPrompt,
          lastOutput: session.lastOutput,
          steps: session.steps
        });
        sessionCount++;

        turns.forEach((turn, index) => {
          const timestamp = Number(turn.timestamp || session.updatedAt || Date.now());
          const interactionId = turn.interactionId || `legacy-${environmentId}-${timestamp}-${index}`;
          this.upsertInteractionStmt.run(
            interactionId,
            resolvedSessionId,
            turn.prompt || '',
            turn.outputText || '',
            json(turn.steps, '[]'),
            turn.status || null,
            turn.model || null,
            json(turn.usage),
            null,
            timestamp
          );
          turnCount++;
        });
      }
    });
    return { sessions: sessionCount, turns: turnCount };
  }

  listSessions() {
    const sessions = this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all();
    const turnsForSession = this.db.prepare(`
      SELECT * FROM interactions WHERE session_id = ? ORDER BY created_at ASC
    `);

    return sessions.map((session) => {
      const turns = turnsForSession.all(session.id).map((turn) => ({
        interactionId: turn.interaction_id,
        prompt: turn.prompt,
        outputText: turn.output_text,
        steps: parseJson(turn.steps_json, []),
        status: turn.status,
        model: turn.model,
        usage: parseJson(turn.usage_json, null),
        timestamp: Number(turn.created_at)
      }));
      return {
        id: session.id,
        name: session.name,
        envId: session.environment_id,
        lastInteractionId: session.last_interaction_id,
        lastPrompt: session.last_prompt,
        lastOutput: session.last_output,
        steps: parseJson(session.last_steps_json, []),
        createdAt: Number(session.created_at),
        updatedAt: Number(session.updated_at),
        turns
      };
    });
  }

  deleteSession(sessionId) {
    return this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId).changes > 0;
  }

  recordArtifact({ environmentId, interactionId, filePath, filename, provider, sizeBytes, downloadUrl }) {
    if (!environmentId || !filePath) return;
    const now = Date.now();
    this.ensureEnvironment(environmentId, { updatedAt: now });
    this.db.prepare(`
      INSERT INTO artifacts (
        environment_id, interaction_id, file_path, filename, provider,
        size_bytes, download_url, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(environment_id, file_path) DO UPDATE SET
        interaction_id = COALESCE(excluded.interaction_id, artifacts.interaction_id),
        filename = excluded.filename,
        provider = COALESCE(excluded.provider, artifacts.provider),
        size_bytes = COALESCE(excluded.size_bytes, artifacts.size_bytes),
        download_url = COALESCE(excluded.download_url, artifacts.download_url),
        updated_at = excluded.updated_at
    `).run(
      environmentId,
      interactionId || null,
      filePath,
      filename || path.basename(filePath),
      provider || null,
      Number.isFinite(sizeBytes) ? sizeBytes : null,
      downloadUrl || null,
      now,
      now
    );
  }

  recordError({ environmentId, previousInteractionId, code, httpStatus, message, request, error }) {
    this.db.prepare(`
      INSERT INTO task_errors (
        environment_id, previous_interaction_id, code, http_status,
        message, request_json, error_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      environmentId || null,
      previousInteractionId || null,
      code || null,
      Number.isFinite(httpStatus) ? httpStatus : null,
      message || 'Unknown error',
      json(request),
      json(error),
      Date.now()
    );
  }

  stats() {
    return {
      environments: Number(this.db.prepare('SELECT COUNT(*) AS count FROM environments').get().count),
      sessions: Number(this.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count),
      interactions: Number(this.db.prepare('SELECT COUNT(*) AS count FROM interactions').get().count),
      artifacts: Number(this.db.prepare('SELECT COUNT(*) AS count FROM artifacts').get().count),
      errors: Number(this.db.prepare('SELECT COUNT(*) AS count FROM task_errors').get().count)
    };
  }

  close() {
    this.db.close();
  }
}

module.exports = { AppDatabase };
