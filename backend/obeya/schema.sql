-- Obeya schema. Idempotent: applied on every start.

-- The room is one document: walls, panels, items and display preferences.
CREATE TABLE IF NOT EXISTS room (
    id          TEXT PRIMARY KEY,
    doc         JSONB NOT NULL,
    version     INTEGER NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Previous versions of the room, newest kept, for recovery after a bad edit.
CREATE TABLE IF NOT EXISTS room_history (
    version     INTEGER PRIMARY KEY,
    doc         JSONB NOT NULL,
    saved_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Jira field choices and the PI calendar. No secrets.
CREATE TABLE IF NOT EXISTS settings (
    id          TEXT PRIMARY KEY,
    doc         JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Latest result for each distinct Jira link (sid = hash of the link definition).
CREATE TABLE IF NOT EXISTS progress_cache (
    sid         TEXT PRIMARY KEY,
    spec        JSONB NOT NULL,
    result      JSONB NOT NULL,
    fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One snapshot per link per day: the trend behind each bar.
CREATE TABLE IF NOT EXISTS progress_history (
    sid         TEXT NOT NULL,
    day         DATE NOT NULL,
    done        DOUBLE PRECISION NOT NULL,
    total       DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (sid, day)
);

-- Small cached values, such as the active sprint.
CREATE TABLE IF NOT EXISTS kv (
    key         TEXT PRIMARY KEY,
    value       JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_run (
    id          BIGSERIAL PRIMARY KEY,
    started_at  TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ NOT NULL,
    ok          BOOLEAN NOT NULL,
    error       TEXT,
    sources     INTEGER NOT NULL DEFAULT 0
);
