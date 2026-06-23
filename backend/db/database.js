'use strict';
require('dotenv').config();
const fs        = require('fs');
const path      = require('path');
const initSqlJs = require('sql.js');
const bcrypt    = require('bcryptjs');
const { v4: uuid } = require('uuid');

const DB_PATH = path.resolve(process.env.DB_PATH || './helpdesk.db');

// ── Internal state ────────────────────────────────────────────────────────────
let _sql  = null;   // sql.js lib
let _db   = null;   // Database instance
let _ready = false;

// Kick off wasm load immediately
const readyPromise = initSqlJs().then(SQL => {
  _sql = SQL;
  _db  = fs.existsSync(DB_PATH)
    ? new SQL.Database(fs.readFileSync(DB_PATH))
    : new SQL.Database();
  _db.run("PRAGMA foreign_keys = ON;");
  _applySchema();
  _persist();
  _bootstrapAdmin();
  _ready = true;
  console.log(`[DB] Ready → ${DB_PATH}`);
}).catch(err => {
  console.error('[DB] Init failed:', err.message);
  process.exit(1);
});

// ── Persist to disk ───────────────────────────────────────────────────────────
function _persist() {
  if (!_db) return;
  fs.writeFileSync(DB_PATH, Buffer.from(_db.export()));
}

// ── Schema ────────────────────────────────────────────────────────────────────
function _applySchema() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','technician','admin')),
      department    TEXT NOT NULL DEFAULT '',
      phone         TEXT NOT NULL DEFAULT '',
      is_active     INTEGER NOT NULL DEFAULT 1,
      created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      expires_at INTEGER NOT NULL,
      ip_address TEXT,
      user_agent TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS tickets (
      id           TEXT PRIMARY KEY,
      subject      TEXT NOT NULL,
      description  TEXT NOT NULL,
      category     TEXT NOT NULL CHECK(category IN ('Hardware','Software','Network','Access','Email','Security','Other')),
      priority     TEXT NOT NULL CHECK(priority IN ('Low','Medium','High','Critical')),
      status       TEXT NOT NULL DEFAULT 'Open' CHECK(status IN ('Open','In Progress','Pending User','Resolved','Closed')),
      created_by   TEXT NOT NULL REFERENCES users(id),
      assigned_to  TEXT REFERENCES users(id),
      due_at       INTEGER,
      resolved_at  INTEGER,
      closed_at    INTEGER,
      sla_breached INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )`,
    `CREATE TABLE IF NOT EXISTS comments (
      id          TEXT PRIMARY KEY,
      ticket_id   TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      author_id   TEXT NOT NULL REFERENCES users(id),
      body        TEXT NOT NULL,
      is_internal INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )`,
    `CREATE TABLE IF NOT EXISTS attachments (
      id            TEXT PRIMARY KEY,
      ticket_id     TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      uploaded_by   TEXT NOT NULL REFERENCES users(id),
      stored_name   TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type     TEXT NOT NULL,
      size_bytes    INTEGER NOT NULL,
      created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )`,
    `CREATE TABLE IF NOT EXISTS notifications (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ticket_id  TEXT REFERENCES tickets(id) ON DELETE CASCADE,
      type       TEXT NOT NULL,
      title      TEXT NOT NULL,
      body       TEXT NOT NULL,
      is_read    INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )`,
    `CREATE TABLE IF NOT EXISTS audit_log (
      id         TEXT PRIMARY KEY,
      ticket_id  TEXT REFERENCES tickets(id) ON DELETE CASCADE,
      actor_id   TEXT REFERENCES users(id),
      action     TEXT NOT NULL,
      field      TEXT,
      old_value  TEXT,
      new_value  TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )`,
    `CREATE TABLE IF NOT EXISTS email_queue (
      id         TEXT PRIMARY KEY,
      to_address TEXT NOT NULL,
      subject    TEXT NOT NULL,
      html_body  TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'pending',
      attempts   INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      sent_at    INTEGER
    )`,
    // Indexes
    `CREATE INDEX IF NOT EXISTS idx_tickets_status      ON tickets(status)`,
    `CREATE INDEX IF NOT EXISTS idx_tickets_created_by  ON tickets(created_by)`,
    `CREATE INDEX IF NOT EXISTS idx_tickets_assigned_to ON tickets(assigned_to)`,
    `CREATE INDEX IF NOT EXISTS idx_tickets_due_at      ON tickets(due_at)`,
    `CREATE INDEX IF NOT EXISTS idx_comments_ticket     ON comments(ticket_id)`,
    `CREATE INDEX IF NOT EXISTS idx_notifs_user         ON notifications(user_id, is_read)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_ticket        ON audit_log(ticket_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_user       ON sessions(user_id)`,
  ];
  for (const s of statements) {
    try { _db.run(s); } catch(e) { /* already exists */ }
  }
}

// ── Bootstrap admin on first run ──────────────────────────────────────────────
function _bootstrapAdmin() {
  const existing = _queryOne('SELECT id FROM users WHERE role = ?', ['admin']);
  if (existing) return; // admins already exist

  const name  = process.env.INIT_ADMIN_NAME  || 'Administrator';
  const email = process.env.INIT_ADMIN_EMAIL || 'admin@helpdesk.local';
  const pass  = process.env.INIT_ADMIN_PASSWORD || 'Admin1234!';

  _db.run(
    `INSERT INTO users (id, name, email, password_hash, role, department) VALUES (?, ?, ?, ?, 'admin', 'IT')`,
    [uuid(), name, email.toLowerCase(), bcrypt.hashSync(pass, 12)]
  );
  _persist();
  console.log(`[DB] First-run admin created → ${email} / ${pass}`);
  console.log(`[DB] IMPORTANT: Log in and change this password immediately!`);
}

// ── Query helpers (synchronous) ───────────────────────────────────────────────
function _queryAll(sql, params = []) {
  const res = _db.exec(sql, params);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((c, i) => { obj[c] = row[i]; });
    return obj;
  });
}

function _queryOne(sql, params = []) {
  const rows = _queryAll(sql, params);
  return rows[0] || null;
}

// ── Statement class ───────────────────────────────────────────────────────────
class Stmt {
  constructor(sql) {
    this.sql = sql;
    this._write = /^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE)\b/i.test(sql);
  }

  _params(args) {
    if (!args.length) return [];
    if (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0])) {
      // named object — prefix keys with $
      const out = {};
      for (const [k, v] of Object.entries(args[0])) {
        out[/^[$:@]/.test(k) ? k : '$' + k] = v ?? null;
      }
      return out;
    }
    return args.flat().map(v => v ?? null);
  }

  run(...args) {
    if (!_ready) throw new Error('DB not ready');
    _db.run(this.sql, this._params(args));
    if (this._write) _persist();
    return this;
  }

  get(...args) {
    if (!_ready) throw new Error('DB not ready');
    return _queryOne(this.sql, this._params(args));
  }

  all(...args) {
    if (!_ready) throw new Error('DB not ready');
    return _queryAll(this.sql, this._params(args));
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
module.exports = {
  get ready() { return readyPromise; },
  prepare: sql => new Stmt(sql),
  exec(sql) { if (!_ready) throw new Error('DB not ready'); _db.run(sql); _persist(); },
  pragma() {},  // no-op — foreign_keys set at init
  persist: _persist,
};
