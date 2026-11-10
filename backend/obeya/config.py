"""Configuration from environment variables (and an optional backend/.env file).

Secrets (the Jira token, the database password) only ever come from here.
They are never stored in the database and never sent to a browser.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent


def load_env_file(path: Path) -> None:
    """Read KEY=VALUE lines into os.environ without overriding what is already set."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


@dataclass(frozen=True)
class Config:
    host: str
    port: int
    database_url: str
    static_dir: Path
    sync_seconds: int
    jira_base_url: str
    jira_token: str
    jira_auth: str  # "bearer" (Data Center personal access token) or "basic" (Cloud email + API token)
    jira_email: str
    jira_ca_bundle: str
    jira_timeout: int

    @property
    def jira_configured(self) -> bool:
        return bool(self.jira_base_url and self.jira_token)


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def load_config() -> Config:
    load_env_file(BACKEND_DIR / ".env")
    env = os.environ
    return Config(
        host=env.get("OBEYA_HOST", "127.0.0.1"),
        port=_int("OBEYA_PORT", 8787),
        # SQLite file by default; a postgresql:// URL switches to Postgres.
        database_url=env.get("DATABASE_URL") or f"sqlite:///{BACKEND_DIR / 'data' / 'obeya.db'}",
        static_dir=Path(env.get("OBEYA_STATIC_DIR") or REPO_DIR / "frontend" / "dist"),
        sync_seconds=max(30, _int("OBEYA_SYNC_SECONDS", 300)),
        jira_base_url=env.get("JIRA_BASE_URL", "").strip().rstrip("/"),
        jira_token=env.get("JIRA_TOKEN", "").strip(),
        jira_auth=(env.get("JIRA_AUTH", "bearer").strip().lower() or "bearer"),
        jira_email=env.get("JIRA_EMAIL", "").strip(),
        jira_ca_bundle=env.get("JIRA_CA_BUNDLE", "").strip(),
        jira_timeout=_int("JIRA_TIMEOUT", 30),
    )
