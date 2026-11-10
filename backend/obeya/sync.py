"""The Jira sync: find every link in the room, compute it, store the result.

Runs on a timer in a background thread, and on demand after an edit. Screens
never talk to Jira; they read what this job wrote to the database.
"""
from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, Optional

from .config import Config
from .db import Database
from .jira_client import JiraClient, JiraError, JiraUnavailable
from .periods import clean_calendar, pick_pis, sprint_period
from .sources import (Engine, is_lookback, normalize_auto, normalize_board, normalize_metric,
                      normalize_source, spec_id)

log = logging.getLogger("obeya.sync")
WORKERS = 4
# Look-back metrics read issue histories, which is the heaviest call, and they
# move slowly. Recompute them at most this often unless someone asks.
LOOKBACK_TTL_SECONDS = 1800


@dataclass
class Links:
    """Every Jira link in a room, and which item or panel owns it."""
    specs: dict[str, dict] = field(default_factory=dict)     # sid -> spec
    items: dict[str, str] = field(default_factory=dict)      # progress bar / portfolio item id -> sid
    autos: dict[str, str] = field(default_factory=dict)      # progress panel id -> sid
    boards: dict[str, str] = field(default_factory=dict)     # flow board panel id -> sid
    metrics: dict[str, str] = field(default_factory=dict)    # KPI item id -> sid

    def add(self, owners: dict[str, str], owner_id: Any, spec: Optional[dict]) -> None:
        if spec and owner_id:
            sid = spec_id(spec)
            self.specs[sid] = spec
            owners[str(owner_id)] = sid


def collect_links(room: Any) -> Links:
    """Walk the room document and pick out everything that points at Jira."""
    links = Links()
    walls = room.get("walls") if isinstance(room, dict) else None
    for wall in walls if isinstance(walls, list) else []:
        panels = wall.get("panels") if isinstance(wall, dict) else None
        for panel in panels if isinstance(panels, list) else []:
            if not isinstance(panel, dict):
                continue
            kind = panel.get("type")
            data = panel.get("data") if isinstance(panel.get("data"), dict) else {}
            items = [i for i in (data.get("items") if isinstance(data.get("items"), list) else [])
                     if isinstance(i, dict)]
            if kind in ("progress", "portfolio"):
                for item in items:
                    links.add(links.items, item.get("id"), normalize_source(item.get("source")))
            if kind == "progress":
                links.add(links.autos, panel.get("id"), normalize_auto(data.get("auto")))
            if kind == "kanban":
                links.add(links.boards, panel.get("id"), normalize_board(data.get("jira")))
            if kind == "kpi":
                for item in items:
                    links.add(links.metrics, item.get("id"), normalize_metric(item.get("metric")))
    return links


class Syncer:
    def __init__(self, db: Database, cfg: Config):
        self.db = db
        self.cfg = cfg
        self._client: Optional[JiraClient] = None
        self._run_lock = threading.Lock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._full_requested = False
        self._force_requested = False
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

    def run(self, full: bool = True, force: bool = False) -> dict:
        """Compute links and store results. full=False only fills in links that
        have no result yet (used right after an edit). force=True also recomputes
        the look-back metrics that are otherwise refreshed every half hour."""
        with self._run_lock:
            self.running = True
            started = datetime.now(timezone.utc)
            error: Optional[str] = None
            count = 0
            try:
                count = self._run(full, force)
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

    def _run(self, full: bool, force: bool = False) -> int:
        row = self.db.get_room()
        all_specs = collect_links(row["doc"] if row else None).specs
        if not self.cfg.jira_configured:
            return 0
        settings = self.db.get_settings()
        if full:
            self._refresh_sprint(settings)
        have = self.db.cached_results(list(all_specs))
        if full:
            specs = {sid: s for sid, s in all_specs.items()
                     if force or not is_lookback(s) or not _fresh(have.get(sid))}
        else:
            specs = {sid: s for sid, s in all_specs.items() if sid not in have}
        if not specs:
            if full:
                self.db.store_results({}, [], date.today(), keep_sids=list(all_specs))
            return 0
        engine = self.engine(settings)
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            computed = dict(zip(specs, pool.map(engine.compute, specs.values())))
        results = {sid: (specs[sid], result) for sid, result in computed.items()}
        snapshots: list[tuple[str, float, float]] = []
        for sid, result in computed.items():
            if not result.get("ok"):
                continue
            kind = specs[sid]["kind"]
            if kind == "auto":
                snapshots.extend((f"{sid}:{b['key']}", b["done"], b["total"]) for b in result["bars"])
            elif kind == "metric":
                # Look-back metrics carry their own weekly trend; the rest are snapshotted daily.
                if not is_lookback(specs[sid]) and result.get("value") is not None:
                    snapshots.append((sid, result["value"], 0))
            elif kind in ("issue", "jql"):
                snapshots.append((sid, result["done"], result["total"]))
        self.db.store_results(results, snapshots, date.today(), keep_sids=list(all_specs) if full else None)
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

    def wake(self, full: bool = False, force: bool = False) -> None:
        """Ask for a run soon, without blocking the caller."""
        if full:
            self._full_requested = True
        if force:
            self._force_requested = True
        self._wake.set()

    def _loop(self) -> None:
        full, force = True, False
        while not self._stop.is_set():
            try:
                self.run(full=full, force=force)
            except Exception:
                log.exception("Sync loop error")
            timed_out = not self._wake.wait(self.cfg.sync_seconds)
            self._wake.clear()
            full = timed_out or self._full_requested
            force = self._force_requested
            self._full_requested = self._force_requested = False

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

    def results_for(self, room: Any) -> dict[str, dict[str, dict]]:
        """Map cached results onto the items and panels that own the links.
        Returns {"progress", "auto", "boards", "metrics"}, each keyed by owner id."""
        links = collect_links(room)
        cache = self.db.cached_results(list(links.specs))
        snapshot_metrics = {sid for sid in set(links.metrics.values())
                            if sid in cache and not is_lookback(links.specs[sid])}
        hids = [sid for sid in set(links.items.values()) if sid in cache] + sorted(snapshot_metrics)
        for sid in set(links.autos.values()):
            hids.extend(f"{sid}:{b.get('key')}" for b in (cache.get(sid) or {}).get("bars") or [])
        history = self.db.history(hids)
        progress = {}
        for item_id, sid in links.items.items():
            if sid in cache:
                progress[item_id] = {**cache[sid], "history": history.get(sid, [])}
        auto = {}
        for panel_id, sid in links.autos.items():
            if sid in cache:
                result = dict(cache[sid])
                result["bars"] = [{**b, "history": history.get(f"{sid}:{b.get('key')}", [])}
                                  for b in result.get("bars") or []]
                auto[panel_id] = result
        boards = {panel_id: cache[sid] for panel_id, sid in links.boards.items() if sid in cache}
        metrics = {}
        for item_id, sid in links.metrics.items():
            if sid not in cache:
                continue
            result = cache[sid]
            if sid in snapshot_metrics:
                result = {**result, "history": [{"d": h["d"], "value": h["done"]} for h in history.get(sid, [])]}
            metrics[item_id] = result
        return {"progress": progress, "auto": auto, "boards": boards, "metrics": metrics}


def _fresh(result: Optional[dict]) -> bool:
    """A good cached result that is younger than the look-back refresh interval."""
    if not result or not result.get("ok"):
        return False
    try:
        fetched = datetime.fromisoformat(str(result.get("fetchedAt")))
    except ValueError:
        return False
    return (datetime.now(timezone.utc) - fetched).total_seconds() < LOOKBACK_TTL_SECONDS
