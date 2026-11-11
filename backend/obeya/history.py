"""Earlier versions of the room: what each one holds and what changed in it.

Pure functions over room documents, no I/O. A document here is whatever was
saved, so nothing about its shape is taken for granted.
"""
from __future__ import annotations

import json
from typing import Any

SETTINGS = ("roomName", "theme", "tvTheme", "accent", "density", "rotate")
MAX_LINES = 5   # change lines shown per version; the rest are counted


def _walls(doc: Any) -> list[dict]:
    walls = doc.get("walls") if isinstance(doc, dict) else None
    return [w for w in walls if isinstance(w, dict)] if isinstance(walls, list) else []


def _panels(wall: dict) -> list[dict]:
    panels = wall.get("panels")
    return [p for p in panels if isinstance(p, dict)] if isinstance(panels, list) else []


def _name(thing: dict, fallback: str) -> str:
    """The name a wall or panel goes by on screen."""
    for key in ("name", "title"):
        value = thing.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return fallback


def _same(a: Any, b: Any) -> bool:
    return json.dumps(a, sort_keys=True, default=str) == json.dumps(b, sort_keys=True, default=str)


def _by_id(things: list[dict]) -> dict[str, dict]:
    """Keyed by id, in order. Things without a usable id are keyed by position."""
    out: dict[str, dict] = {}
    for n, thing in enumerate(things):
        key = thing.get("id")
        out[key if isinstance(key, str) and key and key not in out else f"#{n}"] = thing
    return out


def summary(doc: Any) -> dict:
    """What a version holds, for one line in the list."""
    walls = _walls(doc)
    name = doc.get("roomName") if isinstance(doc, dict) else None
    return {"roomName": name if isinstance(name, str) else "",
            "walls": len(walls),
            "panels": sum(len(_panels(w)) for w in walls)}


def describe_change(prev_doc: Any, doc: Any) -> list[str]:
    """Plain-English lines for what changed from one saved version to the next.

    prev_doc is None for the first version there is. An empty list means the
    two documents hold the same room.
    """
    if prev_doc is None:
        return ["Room created"]
    lines: list[str] = []
    old_room = prev_doc if isinstance(prev_doc, dict) else {}
    new_room = doc if isinstance(doc, dict) else {}
    if any(not _same(old_room.get(k), new_room.get(k)) for k in SETTINGS):
        lines.append("Room settings changed")

    old_walls, new_walls = _by_id(_walls(prev_doc)), _by_id(_walls(doc))
    for wid, wall in new_walls.items():
        if wid not in old_walls:
            lines.append(f"Added wall {_name(wall, 'Wall')}")
    for wid, wall in old_walls.items():
        if wid not in new_walls:
            lines.append(f"Removed wall {_name(wall, 'Wall')}")
    kept = [wid for wid in new_walls if wid in old_walls]
    if kept != [wid for wid in old_walls if wid in new_walls]:
        lines.append("Walls reordered")

    for wid in kept:
        old, new = old_walls[wid], new_walls[wid]
        where = _name(new, "Wall")
        if _name(old, "Wall") != where:
            lines.append(f"Renamed wall {_name(old, 'Wall')} to {where}")
        elif not _same(old.get("subtitle"), new.get("subtitle")):
            lines.append(f"Changed the subtitle of {where}")
        old_panels, new_panels = _by_id(_panels(old)), _by_id(_panels(new))
        for pid, panel in new_panels.items():
            if pid not in old_panels:
                lines.append(f"Added panel {_name(panel, 'Panel')} to {where}")
        for pid, panel in old_panels.items():
            if pid not in new_panels:
                lines.append(f"Removed panel {_name(panel, 'Panel')} from {where}")
        both = [pid for pid in new_panels if pid in old_panels]
        for pid in both:
            if not _same(old_panels[pid], new_panels[pid]):
                lines.append(f"Changed {_name(new_panels[pid], 'Panel')} on {where}")
        if both != [pid for pid in old_panels if pid in new_panels]:
            lines.append(f"Panels reordered on {where}")

    if not lines and not _same(prev_doc, doc):
        lines.append("Small changes")   # e.g. the "example data" marker being cleared
    return lines


def capped(lines: list[str], limit: int = MAX_LINES) -> tuple[list[str], int]:
    """The first few lines, and how many were left out."""
    return lines[:limit], max(0, len(lines) - limit)
