"""Local demo: the Obeya server wired to the built-in fake Jira.

    uv run python scripts/dev.py

Starts the fake Jira on port 8790 and the Obeya server on 8787, and on the
first run fills in the Jira settings (PI field, board, PI calendar) to match
the fake data. For real Jira, run `python -m obeya` with JIRA_BASE_URL and
JIRA_TOKEN set instead.
"""
from __future__ import annotations

import os
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fake_jira.server import DEFAULT_TOKEN, make_fake_server, suggested_settings  # noqa: E402


def main() -> None:
    port = int(os.environ.get("FAKE_JIRA_PORT") or 8790)
    fake = make_fake_server(port=port)
    threading.Thread(target=fake.serve_forever, name="fake-jira", daemon=True).start()
    os.environ["JIRA_BASE_URL"] = f"http://127.0.0.1:{port}"
    os.environ["JIRA_TOKEN"] = DEFAULT_TOKEN
    os.environ["JIRA_AUTH"] = "bearer"
    os.environ.setdefault("OBEYA_SYNC_SECONDS", "60")

    from obeya.config import load_config
    from obeya.db import Database
    from obeya.__main__ import main as run_server

    db = Database(load_config().database_url)
    db.init_schema()
    with db.connect() as conn:
        configured = conn.execute("SELECT 1 FROM settings").fetchone()
    if not configured:
        db.save_settings(suggested_settings(fake.dataset))  # type: ignore[attr-defined]
        print("Jira settings filled in to match the fake Jira.")
    print(f"Fake Jira on http://127.0.0.1:{port} (sample keys: PLAT-1, DATA-1)")
    run_server()


if __name__ == "__main__":
    main()
