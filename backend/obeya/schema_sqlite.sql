-- Obeya schema for SQLite. Mirrors schema.sql (Postgres). Idempotent: applied on every start.
-- JSON documents are stored as text; timestamps and dates as ISO 8601 text.

CREATE TABLE IF NOT EXISTS room (
    id          TEXT PRIMARY KEY,
    doc         TEXT NOT NULL,
    version     INTEGER NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS room_history (
    version     INTEGER PRIMARY KEY,
    doc         TEXT NOT NULL,
    saved_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    id          TEXT PRIMARY KEY,
    doc         TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS progress_cache (
    sid         TEXT PRIMARY KEY,
    spec        TEXT NOT NULL,
    result      TEXT NOT NULL,
    fetched_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS progress_history (
    sid         TEXT NOT NULL,
    day         TEXT NOT NULL,
    done        REAL NOT NULL,
    total       REAL NOT NULL,
    PRIMARY KEY (sid, day)
);

CREATE TABLE IF NOT EXISTS kv (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_run (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    ok          INTEGER NOT NULL,
    error       TEXT,
    sources     INTEGER NOT NULL DEFAULT 0
);
