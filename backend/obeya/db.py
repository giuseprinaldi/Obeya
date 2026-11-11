"""Storage. SQLite by default (one file, no dependencies); Postgres when
DATABASE_URL starts with postgresql://.

One short-lived connection per operation: the load is a handful of screens
polling, so a pool is not worth the complexity.
"""
from __future__ import annotations

import json
import re
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

HERE = Path(__file__).parent
ROOM_ID = "main"
ROOM_HISTORY_KEEP = 100
HISTORY_DAYS = 180
CHUNK = 400  # ids per IN (...) list; old SQLite builds allow 999 parameters

DEFAULT_SETTINGS = {
    "jira": {"piField": "", "storyPointsField": "", "boardId": None, "showSummaries": True,
             "showAssignees": True,
             "blocked": {"flagged": True, "statuses": [], "labels": [], "links": False}},
    "pis": [],
}


def _dict_row(cursor: sqlite3.Cursor, row: tuple) -> dict:
    return {col[0]: value for col, value in zip(cursor.description, row)}


class _Conn:
    """The one call both drivers share: execute(sql, params) with ? placeholders."""

    def __init__(self, raw: Any, postgres: bool):
        self.raw = raw
        self.postgres = postgres

    def execute(self, sql: str, params: tuple = ()) -> Any:
        if self.postgres:
            return self.raw.execute(sql.replace("?", "%s"), params or None)
        return self.raw.execute(sql, params)


class Database:
    def __init__(self, url: str, schema: str = ""):
        self.url = url
        self.postgres = url.startswith(("postgres://", "postgresql://"))
        self.schema = schema
        if self.postgres:
            if schema and not re.fullmatch(r"[a-z_][a-z0-9_]*", schema):
                raise ValueError("Invalid schema name")
        else:
            path = url[len("sqlite:///"):] if url.startswith("sqlite:///") else url
            self.path = Path(path).expanduser()

    def describe(self) -> str:
        """For the start-up log; never includes a password."""
        if self.postgres:
            return "Postgres at " + re.sub(r"//[^@/]*@", "//", self.url)
        return f"SQLite file {self.path}"

    # ---- connections ----

    @contextmanager
    def connect(self, write: bool = True) -> Iterator[_Conn]:
        """One connection, one transaction. Commits on success, rolls back on error."""
        if self.postgres:
            import psycopg
            from psycopg.rows import dict_row
            # autocommit, so the block below is the one and only transaction.
            raw = psycopg.connect(self.url, row_factory=dict_row, connect_timeout=5, autocommit=True)
            try:
                if self.schema:
                    raw.execute(f'SET search_path TO "{self.schema}"')
                with raw.transaction():
                    yield _Conn(raw, True)
            finally:
                raw.close()
            return
        raw = sqlite3.connect(str(self.path), timeout=15, isolation_level=None)
        raw.row_factory = _dict_row
        try:
            # IMMEDIATE takes the write lock up front, so a writer never fails half way.
            raw.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            try:
                yield _Conn(raw, False)
            except BaseException:
                raw.execute("ROLLBACK")
                raise
            raw.execute("COMMIT")
        finally:
            raw.close()

    def init_schema(self) -> None:
        if self.postgres:
            with self.connect() as conn:
                if self.schema:
                    conn.execute(f'CREATE SCHEMA IF NOT EXISTS "{self.schema}"')
                conn.execute((HERE / "schema.sql").read_text(encoding="utf-8"))
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        raw = sqlite3.connect(str(self.path), timeout=15)
        try:
            # WAL lets screens keep reading while the sync writes.
            raw.execute("PRAGMA journal_mode=WAL")
            raw.executescript((HERE / "schema_sqlite.sql").read_text(encoding="utf-8"))
        finally:
            raw.close()

    def destroy(self) -> None:
        """For tests only: remove the throwaway schema or file."""
        if self.postgres:
            if not self.schema:
                raise RuntimeError("Refusing to drop the default schema")
            with self.connect() as conn:
                conn.execute(f'DROP SCHEMA IF EXISTS "{self.schema}" CASCADE')
            return
        for suffix in ("", "-wal", "-shm"):
            Path(str(self.path) + suffix).unlink(missing_ok=True)

    # ---- value conversion ----

    def _json(self, value: Any) -> Any:
        if self.postgres:
            from psycopg.types.json import Jsonb
            return Jsonb(value)
        return json.dumps(value, separators=(",", ":"))

    @staticmethod
    def _load(value: Any) -> Any:
        return json.loads(value) if isinstance(value, str) else value

    def _now(self) -> Any:
        now = datetime.now(timezone.utc)
        return now if self.postgres else now.isoformat(timespec="seconds")

    def _day(self, day: date) -> Any:
        return day if self.postgres else day.isoformat()

    @staticmethod
    def _ts(value: Any) -> datetime:
        return datetime.fromisoformat(value) if isinstance(value, str) else value

    # ---- room ----

    def get_room(self) -> Optional[dict]:
        with self.connect(write=False) as conn:
            row = conn.execute("SELECT doc, version, updated_at FROM room WHERE id = ?", (ROOM_ID,)).fetchone()
        if not row:
            return None
        return {"doc": self._load(row["doc"]), "version": row["version"], "updated_at": self._ts(row["updated_at"])}

    def save_room(self, doc: dict, base_version: int) -> Optional[dict]:
        """Save if nobody else saved since base_version. Returns the new
        {version, updated_at}, or None on a conflict."""
        now = self._now()
        version = base_version + 1
        with self.connect() as conn:
            if base_version == 0:
                cur = conn.execute(
                    "INSERT INTO room (id, doc, version, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT (id) DO NOTHING",
                    (ROOM_ID, self._json(doc), now))
            else:
                cur = conn.execute(
                    "UPDATE room SET doc = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?",
                    (self._json(doc), version, now, ROOM_ID, base_version))
            if cur.rowcount != 1:
                return None
            conn.execute(
                "INSERT INTO room_history (version, doc, saved_at) VALUES (?, ?, ?) ON CONFLICT (version) DO NOTHING",
                (version, self._json(doc), now))
            conn.execute("DELETE FROM room_history WHERE version <= ?", (version - ROOM_HISTORY_KEEP,))
        return {"version": version, "updated_at": self._ts(now)}

    def room_versions(self) -> list[dict]:
        """Every kept version of the room, newest first: {version, doc, saved_at}."""
        with self.connect(write=False) as conn:
            rows = conn.execute("SELECT version, doc, saved_at FROM room_history ORDER BY version DESC").fetchall()
        return [{"version": r["version"], "doc": self._load(r["doc"]), "saved_at": self._ts(r["saved_at"])} for r in rows]

    def room_version(self, version: int) -> Optional[dict]:
        """One kept version, or None when it was never saved or is no longer kept."""
        with self.connect(write=False) as conn:
            row = conn.execute("SELECT version, doc, saved_at FROM room_history WHERE version = ?", (version,)).fetchone()
        if not row:
            return None
        return {"version": row["version"], "doc": self._load(row["doc"]), "saved_at": self._ts(row["saved_at"])}

    # ---- settings ----

    def get_settings(self) -> dict:
        with self.connect(write=False) as conn:
            row = conn.execute("SELECT doc FROM settings WHERE id = ?", (ROOM_ID,)).fetchone()
        return self._load(row["doc"]) if row else json.loads(json.dumps(DEFAULT_SETTINGS))

    def save_settings(self, doc: dict) -> None:
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO settings (id, doc, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT (id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at",
                (ROOM_ID, self._json(doc), self._now()))

    # ---- progress cache and history ----

    def cached_results(self, sids: Optional[list[str]] = None) -> dict[str, dict]:
        out: dict[str, dict] = {}
        with self.connect(write=False) as conn:
            if sids is None:
                rows = conn.execute("SELECT sid, result FROM progress_cache").fetchall()
            else:
                rows = []
                for chunk in _chunks(sids):
                    marks = ", ".join("?" * len(chunk))
                    rows.extend(conn.execute(
                        f"SELECT sid, result FROM progress_cache WHERE sid IN ({marks})", tuple(chunk)).fetchall())
        for r in rows:
            out[r["sid"]] = self._load(r["result"])
        return out

    def store_results(self, results: dict[str, tuple[dict, dict]], snapshots: list[tuple[str, float, float]],
                      today: date, keep_sids: Optional[list[str]] = None) -> None:
        """results: sid -> (spec, result). snapshots: (history id, done, total).
        keep_sids, when given, is the full set still in use; other rows are removed."""
        now = self._now()
        with self.connect() as conn:
            for sid, (spec, result) in results.items():
                conn.execute(
                    "INSERT INTO progress_cache (sid, spec, result, fetched_at) VALUES (?, ?, ?, ?) "
                    "ON CONFLICT (sid) DO UPDATE SET spec = excluded.spec, result = excluded.result, "
                    "fetched_at = excluded.fetched_at",
                    (sid, self._json(spec), self._json(result), now))
            for hid, done, total in snapshots:
                conn.execute(
                    "INSERT INTO progress_history (sid, day, done, total) VALUES (?, ?, ?, ?) "
                    "ON CONFLICT (sid, day) DO UPDATE SET done = excluded.done, total = excluded.total",
                    (hid, self._day(today), float(done), float(total)))
            if keep_sids is not None:
                keep = set(keep_sids)
                stale = [r["sid"] for r in conn.execute("SELECT sid FROM progress_cache").fetchall()
                         if r["sid"] not in keep]
                for chunk in _chunks(stale):
                    marks = ", ".join("?" * len(chunk))
                    conn.execute(f"DELETE FROM progress_cache WHERE sid IN ({marks})", tuple(chunk))
                conn.execute("DELETE FROM progress_history WHERE day < ?",
                             (self._day(today - timedelta(days=HISTORY_DAYS)),))

    def fill_history(self, hid: str, rows: list[tuple[date, float, float]]) -> None:
        """Add (day, done, total) rows for days that have no snapshot yet. A day
        that already has one keeps it: what was seen on the day beats a replay."""
        with self.connect() as conn:
            for day, done, total in rows:
                conn.execute(
                    "INSERT INTO progress_history (sid, day, done, total) VALUES (?, ?, ?, ?) "
                    "ON CONFLICT (sid, day) DO NOTHING",
                    (hid, self._day(day), float(done), float(total)))

    def history(self, hids: list[str], days: int = 60) -> dict[str, list[dict]]:
        out: dict[str, list[dict]] = {}
        since = self._day(date.today() - timedelta(days=days))
        with self.connect(write=False) as conn:
            for chunk in _chunks(hids):
                marks = ", ".join("?" * len(chunk))
                rows = conn.execute(
                    f"SELECT sid, day, done, total FROM progress_history "
                    f"WHERE sid IN ({marks}) AND day >= ? ORDER BY sid, day", (*chunk, since)).fetchall()
                for r in rows:
                    day = r["day"] if isinstance(r["day"], str) else r["day"].isoformat()
                    out.setdefault(r["sid"], []).append({"d": day, "done": _n(r["done"]), "total": _n(r["total"])})
        return out

    # ---- kv ----

    def kv_get(self, key: str) -> Any:
        with self.connect(write=False) as conn:
            row = conn.execute("SELECT value FROM kv WHERE key = ?", (key,)).fetchone()
        return self._load(row["value"]) if row else None

    def kv_set(self, key: str, value: Any) -> None:
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                (key, self._json(value), self._now()))

    # ---- sync runs ----

    def record_sync(self, started: datetime, finished: datetime, ok: bool, error: Optional[str], sources: int) -> None:
        def stamp(value: datetime) -> Any:
            return value if self.postgres else value.isoformat(timespec="seconds")
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO sync_run (started_at, finished_at, ok, error, sources) VALUES (?, ?, ?, ?, ?)",
                (stamp(started), stamp(finished), bool(ok) if self.postgres else int(ok), error, sources))
            conn.execute("DELETE FROM sync_run WHERE id <= (SELECT max(id) FROM sync_run) - 500")

    def last_sync(self) -> Optional[dict]:
        with self.connect(write=False) as conn:
            row = conn.execute("SELECT finished_at, ok, error FROM sync_run ORDER BY id DESC LIMIT 1").fetchone()
        if not row:
            return None
        return {"finished_at": self._ts(row["finished_at"]), "ok": bool(row["ok"]), "error": row["error"]}


def _chunks(items: list[str]) -> Iterator[list[str]]:
    for i in range(0, len(items), CHUNK):
        yield items[i:i + CHUNK]


def _n(value: float) -> Any:
    return int(value) if float(value).is_integer() else round(float(value), 2)
