"""The Jira sync: find every link in the room, compute it, store the result.

Runs on a timer in a background thread, and on demand after an edit. Screens
never talk to Jira; they read what this job wrote to the database.
"""
from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone
from typing import Any, Optional

from .config import Config
from .db import Database
from .jira_client import JiraClient, JiraError, JiraUnavailable
from .periods import clean_calendar, pick_pis, sprint_period
from .sources import Engine, normalize_auto, normalize_source, spec_id

log = logging.getLogger("obeya.sync")
WORKERS = 4


def collect_links(room: Any) -> tuple[dict[str, dict], dict[str, str], dict[str, str]]:
    """Walk the room document.

    Returns (specs by sid, item id -> sid, progress panel id -> sid of its auto query).
    """
    specs: dict[str, dict] = {}
    items: dict[str, str] = {}
    autos: dict[str, str] = {}
    walls = room.get("walls") if isinstance(room, dict) else None
    for wall in walls if isinstance(walls, list) else []:
        panels = wall.get("panels") if isinstance(wall, dict) else None
        for panel in panels if isinstance(panels, list) else []:
            if not isinstance(panel, dict) or panel.get("type") not in ("progress", "portfolio"):
                continue
            data = panel.get("data") if isinstance(panel.get("data"), dict) else {}
            for item in data.get("items") if isinstance(data.get("items"), list) else []:
                if not isinstance(item, dict) or not item.get("id"):
                    continue
                spec = normalize_source(item.get("source"))
                if spec:
                    sid = spec_id(spec)
                    specs[sid] = spec
                    items[str(item["id"])] = sid
            if panel.get("type") == "progress" and panel.get("id"):
                spec = normalize_auto(data.get("auto"))
                if spec:
                    sid = spec_id(spec)
                    specs[sid] = spec
                    autos[str(panel["id"])] = sid
    return specs, items, autos


class Syncer:
    def __init__(self, db: Database, cfg: Config):
        self.db = db
        self.cfg = cfg
        self._client: Optional[JiraClient] = None
        self._run_lock = threading.Lock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._full_requested = False
        self._thread: Optional[threading.Thread] = None
        self.running = False

    # ---- Jira ----

    def client(self) -> Optional[JiraClient]:
        if not self.cfg.jira_configured:
            return None
        if self._client is None:
            self._client = JiraClient(self.cfg.jira_base_url, self.cfg.jira_token, self.cfg.jira_auth,
                                      self.cfg.jira_email, self.cfg.jira_ca_bundle, self.cfg.jira_timeout)
        return self._client

    def engine(self, settings: Optional[dict] = None, today: Optional[date] = None) -> Engine:
        client = self.client()
        if client is None:
            raise JiraUnavailable("Jira is not connected. Set JIRA_BASE_URL and JIRA_TOKEN on the server.")
        settings = settings if settings is not None else self.db.get_settings()
        return Engine(client, {**settings, "pis": clean_calendar(settings.get("pis"))}, today)

    # ---- one run ----

    def run(self, full: bool = True) -> dict:
        """Compute links and store results. full=False only fills in links that
        have no result yet (used right after an edit)."""
        with self._run_lock:
            self.running = True
            started = datetime.now(timezone.utc)
            error: Optional[str] = None
            count = 0
            try:
                count = self._run(full)
            except JiraUnavailable as err:
                error = str(err)
                log.warning("Sync stopped: %s", err)
            except Exception as err:  # keep the loop alive whatever happens
                error = f"Sync failed: {err}"
                log.exception("Sync failed")
            finally:
                self.running = False
            finished = datetime.now(timezone.utc)
            if self.cfg.jira_configured and (full or count or error):
                try:
                    self.db.record_sync(started, finished, error is None, error, count)
                except Exception:
                    log.exception("Could not record the sync run")
            return {"ok": error is None, "error": error, "sources": count,
                    "durationMs": int((finished - started).total_seconds() * 1000)}

    def _run(self, full: bool) -> int:
        row = self.db.get_room()
        specs, _, _ = collect_links(row["doc"] if row else None)
        if not self.cfg.jira_configured:
            return 0
        settings = self.db.get_settings()
        if full:
            self._refresh_sprint(settings)
        if not full:
            have = self.db.cached_results(list(specs))
            specs = {sid: s for sid, s in specs.items() if sid not in have}
        if not specs:
            if full:
                self.db.store_results({}, [], date.today(), keep_sids=[])
            return 0
        engine = self.engine(settings)
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            computed = dict(zip(specs, pool.map(engine.compute, specs.values())))
        results = {sid: (specs[sid], result) for sid, result in computed.items()}
        snapshots: list[tuple[str, float, float]] = []
        for sid, result in computed.items():
            if not result.get("ok"):
                continue
            if "bars" in result:
                snapshots.extend((f"{sid}:{b['key']}", b["done"], b["total"]) for b in result["bars"])
            else:
                snapshots.append((sid, result["done"], result["total"]))
        keep = None
        if full:
            all_specs, _, _ = collect_links(row["doc"] if row else None)
            keep = list(all_specs)
        self.db.store_results(results, snapshots, date.today(), keep_sids=keep)
        return len(specs)

    def _refresh_sprint(self, settings: dict) -> None:
        board = (settings.get("jira") or {}).get("boardId")
        client = self.client()
        if not board or client is None:
            self.db.kv_set("sprint", None)
            return
        try:
            self.db.kv_set("sprint", sprint_period(client.active_sprint(int(board))))
        except JiraUnavailable:
            raise
        except (JiraError, ValueError) as err:
            log.warning("Could not read the active sprint of board %s: %s", board, err)
            self.db.kv_set("sprint", None)

    # ---- background loop ----

    def start(self) -> None:
        self._thread = threading.Thread(target=self._loop, name="obeya-sync", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()

    def wake(self, full: bool = False) -> None:
        """Ask for a run soon, without blocking the caller."""
        if full:
            self._full_requested = True
        self._wake.set()

    def _loop(self) -> None:
        full = True
        while not self._stop.is_set():
            try:
                self.run(full=full)
            except Exception:
                log.exception("Sync loop error")
            timed_out = not self._wake.wait(self.cfg.sync_seconds)
            self._wake.clear()
            full = timed_out or self._full_requested
            self._full_requested = False

    # ---- what screens read ----

    def periods(self, settings: dict, today: Optional[date] = None) -> dict:
        today = today or date.today()
        _, cur, nxt = pick_pis(clean_calendar(settings.get("pis")), today)
        return {"today": today.isoformat(), "pi": cur, "nextPi": nxt, "sprint": self.db.kv_get("sprint")}

    def status(self) -> dict:
        last = self.db.last_sync()
        return {
            "jiraConfigured": self.cfg.jira_configured,
            "running": self.running,
            "lastRunAt": last["finished_at"].isoformat(timespec="seconds") if last else None,
            "lastOk": last["ok"] if last else None,
            "lastError": last["error"] if last else None,
            "intervalSeconds": self.cfg.sync_seconds,
        }

    def results_for(self, room: Any) -> tuple[dict[str, dict], dict[str, dict]]:
        """Map cached results onto the items and panels that own the links."""
        specs, items, autos = collect_links(room)
        cache = self.db.cached_results(list(specs))
        hids = [sid for sid in set(items.values()) if sid in cache]
        for sid in set(autos.values()):
            hids.extend(f"{sid}:{b.get('key')}" for b in (cache.get(sid) or {}).get("bars") or [])
        history = self.db.history(hids)
        progress = {}
        for item_id, sid in items.items():
            if sid in cache:
                progress[item_id] = {**cache[sid], "history": history.get(sid, [])}
        auto = {}
        for panel_id, sid in autos.items():
            if sid in cache:
                result = dict(cache[sid])
                result["bars"] = [{**b, "history": history.get(f"{sid}:{b.get('key')}", [])}
                                  for b in result.get("bars") or []]
                auto[panel_id] = result
        return progress, auto
