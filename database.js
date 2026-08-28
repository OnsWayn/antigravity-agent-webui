const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { pacificDayKey } = require('./gateway/pacific-time');

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
      this.createSchemaV3();
      this.createSchemaV4();
      this.createSchemaV5();
      this.createSchemaV6();
      this.createSchemaV7();
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, ?)').run(Date.now());
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, ?)').run(Date.now());
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (4, ?)').run(Date.now());
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (5, ?)').run(Date.now());
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (6, ?)').run(Date.now());
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (7, ?)').run(Date.now());
      return;
    }

    const versionRow = this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();
    const version = Number(versionRow?.version || 1);
    if (version < 2 || !this.tableExists('environments')) {
      this.migrateV1ToV2();
    }
    this.createSchemaV2();
    this.createSchemaV3();
    if (version < 3) {
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, ?)').run(Date.now());
    }
    this.createSchemaV4();
    if (version < 4) {
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (4, ?)').run(Date.now());
    }
    this.createSchemaV5();
    if (version < 5) {
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (5, ?)').run(Date.now());
    }
    this.createSchemaV6();
    if (version < 6) {
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (6, ?)').run(Date.now());
    }
    this.createSchemaV7();
    if (version < 7) {
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (7, ?)').run(Date.now());
    }
  }

  columnExists(table, name) {
    if (!this.tableExists(table)) return false;
    return this.db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === name);
  }

  ensureColumn(table, name, spec) {
    if (this.columnExists(table, name)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${spec}`);
  }

  createSchemaV5() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_request_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL UNIQUE,
        token_id TEXT,
        token_name TEXT,
        upstream_key_id TEXT,
        upstream_key_name TEXT,
        endpoint TEXT,
        protocol TEXT,
        downstream_request_json TEXT,
        downstream_headers_json TEXT,
        upstream_request_json TEXT,
        upstream_response_json TEXT,
        upstream_response_status INTEGER,
        conversation_key TEXT,
        conversation_mode TEXT,
        previous_interaction_id TEXT,
        response_interaction_id TEXT,
        response_environment_id TEXT,
        model TEXT,
        backend_model TEXT,
        stream INTEGER DEFAULT 0,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        duration_ms INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        error_message TEXT,
        error_code TEXT,
        key_switch_count INTEGER DEFAULT 0,
        retry_count INTEGER DEFAULT 0,
        upstream_transition TEXT,
        context_rebuild_reason TEXT,
        fork_reason TEXT,
        source_conversation_key TEXT,
        target_conversation_key TEXT,
        source_upstream_key_id TEXT,
        upstream_previous_interaction_id TEXT,
        raw_call_marker_detected INTEGER NOT NULL DEFAULT 0,
        raw_call_marker_count INTEGER NOT NULL DEFAULT 0,
        tool_trace_status TEXT,
        diagnostics_json TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_gateway_request_logs_created 
        ON gateway_request_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_gateway_request_logs_token 
        ON gateway_request_logs(token_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_gateway_request_logs_status 
        ON gateway_request_logs(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_gateway_request_logs_conversation 
        ON gateway_request_logs(conversation_key, created_at DESC);
    `);

    if (this.tableExists('client_tokens')) {
      this.ensureColumn('client_tokens', 'allowed_models', 'TEXT');
      this.ensureColumn('client_tokens', 'default_model', 'TEXT');
      this.ensureColumn('client_tokens', 'tool_code_execution', 'INTEGER NOT NULL DEFAULT 1');
      this.ensureColumn('client_tokens', 'tool_google_search', 'INTEGER NOT NULL DEFAULT 1');
      this.ensureColumn('client_tokens', 'tool_url_context', 'INTEGER NOT NULL DEFAULT 1');
    }
  }

  createSchemaV6() {
    if (this.tableExists('gateway_conversations')) {
      this.ensureColumn('gateway_conversations', 'parent_conversation_key', 'TEXT');
      this.ensureColumn('gateway_conversations', 'parent_interaction_id', 'TEXT');
      this.ensureColumn('gateway_conversations', 'parent_environment_id', 'TEXT');
      this.ensureColumn('gateway_conversations', 'parent_upstream_key_id', 'TEXT');
    }
    if (this.tableExists('gateway_request_logs')) {
      this.ensureColumn('gateway_request_logs', 'upstream_transition', 'TEXT');
      this.ensureColumn('gateway_request_logs', 'context_rebuild_reason', 'TEXT');
      this.ensureColumn('gateway_request_logs', 'fork_reason', 'TEXT');
      this.ensureColumn('gateway_request_logs', 'source_conversation_key', 'TEXT');
      this.ensureColumn('gateway_request_logs', 'target_conversation_key', 'TEXT');
      this.ensureColumn('gateway_request_logs', 'source_upstream_key_id', 'TEXT');
      this.ensureColumn('gateway_request_logs', 'upstream_previous_interaction_id', 'TEXT');
      this.ensureColumn('gateway_request_logs', 'raw_call_marker_detected', 'INTEGER NOT NULL DEFAULT 0');
      this.ensureColumn('gateway_request_logs', 'raw_call_marker_count', 'INTEGER NOT NULL DEFAULT 0');
      this.ensureColumn('gateway_request_logs', 'tool_trace_status', 'TEXT');
      this.ensureColumn('gateway_request_logs', 'diagnostics_json', 'TEXT');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  createSchemaV7() {
    if (!this.tableExists('upstream_keys')) return;
    this.ensureColumn('upstream_keys', 'rpd_pacific_day', 'TEXT');
    this.ensureColumn('upstream_keys', 'rpd_count', 'INTEGER NOT NULL DEFAULT 0');
  }

  createSchemaV4() {
    if (!this.tableExists('upstream_keys') || !this.tableExists('gateway_conversations')) return;
    this.ensureColumn('upstream_keys', 'cooldown_until', 'INTEGER');
    this.ensureColumn('gateway_conversations', 'upstream_key_id', 'TEXT');
    this.ensureColumn('gateway_conversations', 'transcript_json', 'TEXT');
    this.ensureColumn('gateway_conversations', 'context_version', 'INTEGER NOT NULL DEFAULT 1');
    this.ensureColumn('gateway_conversations', 'created_at', 'INTEGER');
  }

  createSchemaV3() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS upstream_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_ciphertext TEXT NOT NULL,
        key_iv TEXT NOT NULL,
        key_tag TEXT NOT NULL,
        key_suffix TEXT NOT NULL,
        proxy_url TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        fail_count INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS client_tokens (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        token_prefix TEXT NOT NULL,
        quota_tokens INTEGER NOT NULL DEFAULT -1,
        used_tokens INTEGER NOT NULL DEFAULT 0,
        rpm INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        expires_at INTEGER,
        allowed_models TEXT,
        default_model TEXT,
        tool_code_execution INTEGER NOT NULL DEFAULT 1,
        tool_google_search INTEGER NOT NULL DEFAULT 1,
        tool_url_context INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_client_tokens_hash ON client_tokens(token_hash);

      CREATE TABLE IF NOT EXISTS usage_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_id TEXT,
        endpoint TEXT,
        model TEXT,
        interaction_id TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        status INTEGER,
        duration_ms INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_usage_logs_token_created
        ON usage_logs(token_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS gateway_conversations (
        token_id TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        interaction_id TEXT,
        environment_id TEXT,
        prefix_hash TEXT,
        model TEXT,
        context_version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (token_id, conversation_key)
      );

      CREATE TABLE IF NOT EXISTS gateway_tool_calls (
        openai_call_id TEXT PRIMARY KEY,
        google_call_id TEXT NOT NULL,
        name TEXT,
        token_id TEXT,
        interaction_id TEXT,
        created_at INTEGER NOT NULL
      );
    `);
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

  insertUpstreamKey({ id, name, ciphertext, iv, tag, suffix, proxyUrl }) {
    const now = Date.now();
    const keyId = id || `uk-${crypto.randomUUID()}`;
    this.db.prepare(`
      INSERT INTO upstream_keys (
        id, name, key_ciphertext, key_iv, key_tag, key_suffix, proxy_url,
        enabled, fail_count, last_used_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, ?, ?)
    `).run(keyId, name || 'Gemini Key', ciphertext, iv, tag, suffix || '', proxyUrl || null, now, now);
    return this.getUpstreamKey(keyId);
  }

  getUpstreamKey(id) {
    return this.db.prepare('SELECT * FROM upstream_keys WHERE id = ?').get(id) || null;
  }

  listUpstreamKeys() {
    return this.db.prepare('SELECT * FROM upstream_keys ORDER BY created_at DESC').all();
  }

  listEnabledUpstreamKeys() {
    return this.db.prepare('SELECT * FROM upstream_keys WHERE enabled = 1 ORDER BY last_used_at ASC, created_at ASC').all();
  }

  updateUpstreamKey(id, fields = {}) {
    const existing = this.getUpstreamKey(id);
    if (!existing) return null;
    const now = Date.now();
    this.db.prepare(`
      UPDATE upstream_keys SET
        name = ?,
        key_ciphertext = ?,
        key_iv = ?,
        key_tag = ?,
        key_suffix = ?,
        proxy_url = ?,
        enabled = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      fields.name !== undefined ? fields.name : existing.name,
      fields.ciphertext !== undefined ? fields.ciphertext : existing.key_ciphertext,
      fields.iv !== undefined ? fields.iv : existing.key_iv,
      fields.tag !== undefined ? fields.tag : existing.key_tag,
      fields.suffix !== undefined ? fields.suffix : existing.key_suffix,
      fields.proxyUrl !== undefined ? fields.proxyUrl : existing.proxy_url,
      fields.enabled !== undefined ? (fields.enabled ? 1 : 0) : existing.enabled,
      now,
      id
    );
    return this.getUpstreamKey(id);
  }

  deleteUpstreamKey(id) {
    return this.db.prepare('DELETE FROM upstream_keys WHERE id = ?').run(id).changes > 0;
  }

  incrementUpstreamKeyRequest(id, ts = Date.now()) {
    const existing = this.getUpstreamKey(id);
    if (!existing) return null;
    const day = pacificDayKey(ts);
    const now = Number(ts);
    if (existing.rpd_pacific_day !== day) {
      this.db.prepare(`
        UPDATE upstream_keys SET rpd_pacific_day = ?, rpd_count = 1, updated_at = ? WHERE id = ?
      `).run(day, now, id);
    } else {
      this.db.prepare(`
        UPDATE upstream_keys SET rpd_count = rpd_count + 1, updated_at = ? WHERE id = ?
      `).run(now, id);
    }
    return this.getUpstreamKey(id);
  }

  getLatestSuccessTotalTokens(conversationKey) {
    if (!conversationKey || !this.tableExists('gateway_request_logs')) return null;
    const row = this.db.prepare(`
      SELECT total_tokens FROM gateway_request_logs
      WHERE conversation_key = ? AND status = 'success' AND total_tokens IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `).get(conversationKey);
    const n = Number(row?.total_tokens);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  markUpstreamKeyUsed(id, { failed = false, rateLimited = false, cooldownMs = 60000 } = {}) {
    const now = Date.now();
    if (rateLimited) {
      this.db.prepare(`
        UPDATE upstream_keys SET
          fail_count = fail_count + 1,
          cooldown_until = CASE WHEN fail_count + 1 >= 3 THEN ? ELSE cooldown_until END,
          updated_at = ?
        WHERE id = ?
      `).run(now + Number(cooldownMs || 60000), now, id);
      return;
    }
    if (failed) {
      this.db.prepare(`
        UPDATE upstream_keys SET fail_count = fail_count + 1, updated_at = ? WHERE id = ?
      `).run(now, id);
      return;
    }
    this.db.prepare(`
      UPDATE upstream_keys SET fail_count = 0, cooldown_until = NULL, last_used_at = ?, updated_at = ? WHERE id = ?
    `).run(now, now, id);
  }

  insertClientToken({
    id,
    name,
    tokenHash,
    tokenPrefix,
    quotaTokens,
    rpm,
    expiresAt,
    allowedModels = null,
    defaultModel = null,
    toolCodeExecution = 1,
    toolGoogleSearch = 1,
    toolUrlContext = 1
  }) {
    const now = Date.now();
    const tokenId = id || `tk-${crypto.randomUUID()}`;
    const allowed = Array.isArray(allowedModels) ? json(allowedModels) : (allowedModels || null);
    this.db.prepare(`
      INSERT INTO client_tokens (
        id, name, token_hash, token_prefix, quota_tokens, used_tokens,
        rpm, enabled, expires_at, allowed_models, default_model,
        tool_code_execution, tool_google_search, tool_url_context,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tokenId,
      name || 'API Token',
      tokenHash,
      tokenPrefix,
      Number.isFinite(quotaTokens) ? quotaTokens : -1,
      Number.isFinite(rpm) ? rpm : null,
      expiresAt || null,
      allowed,
      defaultModel || null,
      toolCodeExecution === 0 ? 0 : 1,
      toolGoogleSearch === 0 ? 0 : 1,
      toolUrlContext === 0 ? 0 : 1,
      now,
      now
    );
    return this.getClientToken(tokenId);
  }

  getClientToken(id) {
    return this.db.prepare('SELECT * FROM client_tokens WHERE id = ?').get(id) || null;
  }

  getClientTokenByHash(tokenHash) {
    return this.db.prepare('SELECT * FROM client_tokens WHERE token_hash = ?').get(tokenHash) || null;
  }

  listClientTokens() {
    return this.db.prepare('SELECT * FROM client_tokens ORDER BY created_at DESC').all();
  }

  updateClientToken(id, fields = {}) {
    const existing = this.getClientToken(id);
    if (!existing) return null;
    const now = Date.now();
    const allowed = fields.allowedModels !== undefined
      ? (Array.isArray(fields.allowedModels) ? json(fields.allowedModels) : fields.allowedModels)
      : existing.allowed_models;
    this.db.prepare(`
      UPDATE client_tokens SET
        name = ?,
        quota_tokens = ?,
        rpm = ?,
        enabled = ?,
        expires_at = ?,
        allowed_models = ?,
        default_model = ?,
        tool_code_execution = ?,
        tool_google_search = ?,
        tool_url_context = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      fields.name !== undefined ? fields.name : existing.name,
      fields.quotaTokens !== undefined ? fields.quotaTokens : existing.quota_tokens,
      fields.rpm !== undefined ? fields.rpm : existing.rpm,
      fields.enabled !== undefined ? (fields.enabled ? 1 : 0) : existing.enabled,
      fields.expiresAt !== undefined ? fields.expiresAt : existing.expires_at,
      allowed,
      fields.defaultModel !== undefined ? fields.defaultModel : existing.default_model,
      fields.toolCodeExecution !== undefined ? (fields.toolCodeExecution ? 1 : 0) : existing.tool_code_execution,
      fields.toolGoogleSearch !== undefined ? (fields.toolGoogleSearch ? 1 : 0) : existing.tool_google_search,
      fields.toolUrlContext !== undefined ? (fields.toolUrlContext ? 1 : 0) : existing.tool_url_context,
      now,
      id
    );
    return this.getClientToken(id);
  }

  deleteClientToken(id) {
    return this.db.prepare('DELETE FROM client_tokens WHERE id = ?').run(id).changes > 0;
  }

  addClientTokenUsage(id, tokens) {
    const amount = Number(tokens) || 0;
    if (amount <= 0) return this.getClientToken(id);
    this.db.prepare(`
      UPDATE client_tokens SET used_tokens = used_tokens + ?, updated_at = ? WHERE id = ?
    `).run(amount, Date.now(), id);
    return this.getClientToken(id);
  }

  insertUsageLog(entry = {}) {
    this.db.prepare(`
      INSERT INTO usage_logs (
        token_id, endpoint, model, interaction_id, prompt_tokens, completion_tokens,
        total_tokens, status, duration_ms, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.tokenId || null,
      entry.endpoint || null,
      entry.model || null,
      entry.interactionId || null,
      Number.isFinite(entry.promptTokens) ? entry.promptTokens : null,
      Number.isFinite(entry.completionTokens) ? entry.completionTokens : null,
      Number.isFinite(entry.totalTokens) ? entry.totalTokens : null,
      Number.isFinite(entry.status) ? entry.status : null,
      Number.isFinite(entry.durationMs) ? entry.durationMs : null,
      entry.error || null,
      Date.now()
    );
  }

  listUsageLogs({ tokenId, limit = 100 } = {}) {
    const cap = Math.min(Math.max(Number(limit) || 100, 1), 500);
    if (tokenId) {
      return this.db.prepare(`
        SELECT * FROM usage_logs WHERE token_id = ? ORDER BY created_at DESC LIMIT ?
      `).all(tokenId, cap);
    }
    return this.db.prepare(`
      SELECT * FROM usage_logs ORDER BY created_at DESC LIMIT ?
    `).all(cap);
  }

  getGatewayConversation(tokenId, conversationKey) {
    if (!tokenId || !conversationKey) return null;
    return this.db.prepare(`
      SELECT * FROM gateway_conversations WHERE token_id = ? AND conversation_key = ?
    `).get(tokenId, conversationKey) || null;
  }

  listGatewayConversationsForSource(tokenId, sourceKey) {
    if (!tokenId || !sourceKey) return [];
    return this.db.prepare(`
      SELECT * FROM gateway_conversations
      WHERE token_id = ?
        AND (conversation_key = ? OR conversation_key LIKE ?)
      ORDER BY updated_at DESC
    `).all(tokenId, sourceKey, `${sourceKey}:fork:%`);
  }

  getGatewaySettingsMap() {
    if (!this.tableExists('gateway_settings')) return {};
    const rows = this.db.prepare('SELECT key, value FROM gateway_settings').all();
    const out = {};
    for (const row of rows) {
      try {
        out[row.key] = JSON.parse(row.value);
      } catch {
        out[row.key] = row.value;
      }
    }
    return out;
  }

  setGatewaySettings(values = {}) {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO gateway_settings(key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;
      stmt.run(key, JSON.stringify(value), now);
    }
    return this.getGatewaySettingsMap();
  }

  upsertGatewayConversation({
    tokenId,
    conversationKey,
    interactionId,
    environmentId,
    prefixHash,
    model,
    upstreamKeyId,
    transcript,
    parentConversationKey,
    parentInteractionId,
    parentEnvironmentId,
    parentUpstreamKeyId,
    expectedInteractionId,
    expectedUpstreamKeyId,
    expectedEnvironmentId
  }) {
    if (!tokenId || !conversationKey) {
      return { ok: false, conflict: false, skipped: true };
    }
    const now = Date.now();
    const transcriptJson = transcript == null ? null : json(transcript);

    if (expectedInteractionId != null || expectedUpstreamKeyId != null || expectedEnvironmentId != null) {
      const result = this.db.prepare(`
        UPDATE gateway_conversations SET
          interaction_id = ?,
          environment_id = ?,
          prefix_hash = ?,
          model = COALESCE(?, model),
          updated_at = ?,
          upstream_key_id = ?,
          transcript_json = COALESCE(?, transcript_json),
          context_version = COALESCE(context_version, 0) + 1,
          parent_conversation_key = COALESCE(?, parent_conversation_key),
          parent_interaction_id = COALESCE(?, parent_interaction_id),
          parent_environment_id = COALESCE(?, parent_environment_id),
          parent_upstream_key_id = COALESCE(?, parent_upstream_key_id)
        WHERE token_id = ?
          AND conversation_key = ?
          AND (interaction_id IS ? OR interaction_id = ?)
          AND (upstream_key_id IS ? OR upstream_key_id = ?)
          AND (environment_id IS ? OR environment_id = ?)
      `).run(
        interactionId || null,
        environmentId || null,
        prefixHash || null,
        model || null,
        now,
        upstreamKeyId || null,
        transcriptJson,
        parentConversationKey || null,
        parentInteractionId || null,
        parentEnvironmentId || null,
        parentUpstreamKeyId || null,
        tokenId,
        conversationKey,
        expectedInteractionId ?? null,
        expectedInteractionId ?? null,
        expectedUpstreamKeyId ?? null,
        expectedUpstreamKeyId ?? null,
        expectedEnvironmentId ?? null,
        expectedEnvironmentId ?? null
      );
      return { ok: result.changes === 1, conflict: result.changes !== 1, changes: result.changes };
    }

    this.db.prepare(`
      INSERT INTO gateway_conversations (
        token_id, conversation_key, interaction_id, environment_id, prefix_hash, model,
        updated_at, upstream_key_id, transcript_json, context_version, created_at,
        parent_conversation_key, parent_interaction_id, parent_environment_id, parent_upstream_key_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(token_id, conversation_key) DO UPDATE SET
        interaction_id = excluded.interaction_id,
        environment_id = excluded.environment_id,
        prefix_hash = excluded.prefix_hash,
        model = COALESCE(excluded.model, gateway_conversations.model),
        updated_at = excluded.updated_at,
        upstream_key_id = excluded.upstream_key_id,
        transcript_json = COALESCE(excluded.transcript_json, gateway_conversations.transcript_json),
        context_version = COALESCE(gateway_conversations.context_version, 0) + 1,
        created_at = COALESCE(gateway_conversations.created_at, excluded.created_at),
        parent_conversation_key = COALESCE(excluded.parent_conversation_key, gateway_conversations.parent_conversation_key),
        parent_interaction_id = COALESCE(excluded.parent_interaction_id, gateway_conversations.parent_interaction_id),
        parent_environment_id = COALESCE(excluded.parent_environment_id, gateway_conversations.parent_environment_id),
        parent_upstream_key_id = COALESCE(excluded.parent_upstream_key_id, gateway_conversations.parent_upstream_key_id)
    `).run(
      tokenId,
      conversationKey,
      interactionId || null,
      environmentId || null,
      prefixHash || null,
      model || null,
      now,
      upstreamKeyId || null,
      transcriptJson,
      now,
      parentConversationKey || null,
      parentInteractionId || null,
      parentEnvironmentId || null,
      parentUpstreamKeyId || null
    );
    return { ok: true, conflict: false };
  }

  saveGatewayToolCall({ openaiCallId, googleCallId, name, tokenId, interactionId }) {
    if (!openaiCallId || !googleCallId) return;
    this.db.prepare(`
      INSERT OR REPLACE INTO gateway_tool_calls (
        openai_call_id, google_call_id, name, token_id, interaction_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(openaiCallId, googleCallId, name || null, tokenId || null, interactionId || null, Date.now());
  }

  getGatewayToolCall(openaiCallId) {
    if (!openaiCallId) return null;
    return this.db.prepare('SELECT * FROM gateway_tool_calls WHERE openai_call_id = ?').get(openaiCallId) || null;
  }

  resolveGoogleCallId(openaiCallId) {
    const row = this.getGatewayToolCall(openaiCallId);
    return row?.google_call_id || openaiCallId;
  }

  insertGatewayRequestLog(entry) {
    if (!entry?.requestId) return null;
    const now = Number(entry.createdAt || Date.now());
    this.db.prepare(`
      INSERT INTO gateway_request_logs (
        request_id, token_id, token_name, upstream_key_id, upstream_key_name,
        endpoint, protocol, downstream_request_json, downstream_headers_json,
        upstream_request_json, upstream_response_json, upstream_response_status,
        conversation_key, conversation_mode, previous_interaction_id,
        response_interaction_id, response_environment_id,
        model, backend_model, stream, prompt_tokens, completion_tokens,
        total_tokens, duration_ms, status, error_message, error_code,
        key_switch_count, retry_count,
        upstream_transition, context_rebuild_reason, fork_reason,
        source_conversation_key, target_conversation_key, source_upstream_key_id,
        upstream_previous_interaction_id, raw_call_marker_detected, raw_call_marker_count,
        tool_trace_status, diagnostics_json,
        created_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?
      )
    `).run(
      entry.requestId,
      entry.tokenId || null,
      entry.tokenName || null,
      entry.upstreamKeyId || null,
      entry.upstreamKeyName || null,
      entry.endpoint || null,
      entry.protocol || null,
      typeof entry.downstreamRequestJson === 'string' ? entry.downstreamRequestJson : json(entry.downstreamRequestJson),
      typeof entry.downstreamHeadersJson === 'string' ? entry.downstreamHeadersJson : json(entry.downstreamHeadersJson),
      typeof entry.upstreamRequestJson === 'string' ? entry.upstreamRequestJson : json(entry.upstreamRequestJson),
      typeof entry.upstreamResponseJson === 'string' ? entry.upstreamResponseJson : json(entry.upstreamResponseJson),
      entry.upstreamResponseStatus != null ? Number(entry.upstreamResponseStatus) : null,
      entry.conversationKey || null,
      entry.conversationMode || null,
      entry.previousInteractionId || null,
      entry.responseInteractionId || null,
      entry.responseEnvironmentId || null,
      entry.model || null,
      entry.backendModel || null,
      entry.stream ? 1 : 0,
      entry.promptTokens != null ? Number(entry.promptTokens) : null,
      entry.completionTokens != null ? Number(entry.completionTokens) : null,
      entry.totalTokens != null ? Number(entry.totalTokens) : null,
      entry.durationMs != null ? Number(entry.durationMs) : null,
      entry.status || 'pending',
      entry.errorMessage || null,
      entry.errorCode || null,
      Number(entry.keySwitchCount || 0),
      Number(entry.retryCount || 0),
      entry.upstreamTransition || null,
      entry.contextRebuildReason || null,
      entry.forkReason || null,
      entry.sourceConversationKey || null,
      entry.targetConversationKey || null,
      entry.sourceUpstreamKeyId || null,
      entry.upstreamPreviousInteractionId !== undefined ? (entry.upstreamPreviousInteractionId || null) : null,
      entry.rawCallMarkerDetected ? 1 : 0,
      Number(entry.rawCallMarkerCount || 0),
      entry.toolTraceStatus || null,
      entry.diagnosticsJson == null ? null : (typeof entry.diagnosticsJson === 'string' ? entry.diagnosticsJson : json(entry.diagnosticsJson)),
      now
    );
    return this.getGatewayRequestLog(entry.requestId);
  }

  updateGatewayRequestLog(requestId, updates = {}) {
    if (!requestId) return null;
    const existing = this.getGatewayRequestLog(requestId);
    if (!existing) return null;

    const fields = [];
    const params = [];

    const fieldMap = {
      tokenId: 'token_id',
      tokenName: 'token_name',
      upstreamKeyId: 'upstream_key_id',
      upstreamKeyName: 'upstream_key_name',
      endpoint: 'endpoint',
      protocol: 'protocol',
      downstreamRequestJson: 'downstream_request_json',
      downstreamHeadersJson: 'downstream_headers_json',
      upstreamRequestJson: 'upstream_request_json',
      upstreamResponseJson: 'upstream_response_json',
      upstreamResponseStatus: 'upstream_response_status',
      conversationKey: 'conversation_key',
      conversationMode: 'conversation_mode',
      previousInteractionId: 'previous_interaction_id',
      responseInteractionId: 'response_interaction_id',
      responseEnvironmentId: 'response_environment_id',
      model: 'model',
      backendModel: 'backend_model',
      stream: 'stream',
      promptTokens: 'prompt_tokens',
      completionTokens: 'completion_tokens',
      totalTokens: 'total_tokens',
      durationMs: 'duration_ms',
      status: 'status',
      errorMessage: 'error_message',
      errorCode: 'error_code',
      keySwitchCount: 'key_switch_count',
      retryCount: 'retry_count',
      upstreamTransition: 'upstream_transition',
      contextRebuildReason: 'context_rebuild_reason',
      forkReason: 'fork_reason',
      sourceConversationKey: 'source_conversation_key',
      targetConversationKey: 'target_conversation_key',
      sourceUpstreamKeyId: 'source_upstream_key_id',
      upstreamPreviousInteractionId: 'upstream_previous_interaction_id',
      rawCallMarkerDetected: 'raw_call_marker_detected',
      rawCallMarkerCount: 'raw_call_marker_count',
      toolTraceStatus: 'tool_trace_status',
      diagnosticsJson: 'diagnostics_json'
    };

    for (const [key, col] of Object.entries(fieldMap)) {
      if (updates[key] !== undefined) {
        fields.push(`${col} = ?`);
        let val = updates[key];
        if (col.endsWith('_json') && typeof val !== 'string' && val !== null) {
          val = json(val);
        } else if (col === 'stream' || col === 'raw_call_marker_detected') {
          val = val ? 1 : 0;
        }
        params.push(val);
      }
    }

    if (!fields.length) return existing;

    params.push(requestId);
    this.db.prepare(`
      UPDATE gateway_request_logs SET ${fields.join(', ')} WHERE request_id = ?
    `).run(...params);

    return this.getGatewayRequestLog(requestId);
  }

  getGatewayRequestLog(requestId) {
    if (!requestId) return null;
    return this.db.prepare('SELECT * FROM gateway_request_logs WHERE request_id = ?').get(requestId) || null;
  }

  listGatewayRequestLogs({
    limit = 50,
    offset = 0,
    status,
    tokenId,
    conversationKey,
    startTime,
    endTime,
    search
  } = {}) {
    const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const off = Math.max(Number(offset) || 0, 0);
    const conditions = [];
    const params = [];

    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    if (tokenId) {
      conditions.push('token_id = ?');
      params.push(tokenId);
    }
    if (conversationKey) {
      conditions.push('conversation_key = ?');
      params.push(conversationKey);
    }
    if (startTime) {
      conditions.push('created_at >= ?');
      params.push(Number(startTime));
    }
    if (endTime) {
      conditions.push('created_at <= ?');
      params.push(Number(endTime));
    }
    if (search) {
      conditions.push('(request_id LIKE ? OR token_name LIKE ? OR upstream_key_name LIKE ? OR endpoint LIKE ? OR model LIKE ? OR error_message LIKE ? OR conversation_key LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s, s, s, s, s);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const countRow = this.db.prepare(`SELECT COUNT(*) AS total FROM gateway_request_logs ${whereClause}`).get(...params);
    const total = Number(countRow?.total || 0);

    const rows = this.db.prepare(`
      SELECT * FROM gateway_request_logs
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, cap, off);

    return {
      total,
      limit: cap,
      offset: off,
      logs: rows
    };
  }

  clearGatewayRequestLogs() {
    return this.db.prepare('DELETE FROM gateway_request_logs').run().changes;
  }

  cleanOldGatewayRequestLogs({ maxDays = 5, maxDailyBytes = 20 * 1024 * 1024 } = {}) {
    const cutoff = Date.now() - (Number(maxDays) || 5) * 86400 * 1000;
    this.db.prepare('DELETE FROM gateway_request_logs WHERE created_at < ?').run(cutoff);

    // Group by day for remaining window and prune oldest logs if over maxDailyBytes
    const dayRows = this.db.prepare(`
      SELECT
        CAST(created_at / 86400000 AS INT) AS day_idx,
        SUM(
          COALESCE(LENGTH(downstream_request_json), 0) +
          COALESCE(LENGTH(upstream_request_json), 0) +
          COALESCE(LENGTH(upstream_response_json), 0)
        ) AS total_bytes
      FROM gateway_request_logs
      GROUP BY day_idx
      HAVING total_bytes > ?
    `).all(Number(maxDailyBytes) || 20 * 1024 * 1024);

    for (const day of dayRows) {
      const dayStart = day.day_idx * 86400000;
      const dayEnd = dayStart + 86400000;
      const logs = this.db.prepare(`
        SELECT id,
          (COALESCE(LENGTH(downstream_request_json), 0) +
           COALESCE(LENGTH(upstream_request_json), 0) +
           COALESCE(LENGTH(upstream_response_json), 0)) AS row_bytes
        FROM gateway_request_logs
        WHERE created_at >= ? AND created_at < ?
        ORDER BY created_at ASC
      `).all(dayStart, dayEnd);

      let currentBytes = day.total_bytes;
      const idsToDelete = [];
      for (const log of logs) {
        if (currentBytes <= maxDailyBytes) break;
        idsToDelete.push(log.id);
        currentBytes -= (log.row_bytes || 0);
      }

      if (idsToDelete.length) {
        for (let i = 0; i < idsToDelete.length; i += 500) {
          const chunk = idsToDelete.slice(i, i + 500);
          this.db.prepare(`DELETE FROM gateway_request_logs WHERE id IN (${chunk.map(() => '?').join(',')})`).run(...chunk);
        }
      }
    }
  }

  close() {
    this.db.close();
  }
}

module.exports = { AppDatabase };
