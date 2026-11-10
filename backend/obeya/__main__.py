"""Run the Obeya server, or one of its maintenance commands.

    python -m obeya                  start the server
    python -m obeya check            test the Jira connection and print what was found
    python -m obeya reset-passcode   remove the edit passcode (when it has been forgotten)
"""
from __future__ import annotations

import logging
import os
import sys

from .config import load_config
from .db import Database
from .server import App, make_server
from .sync import Syncer


def check() -> int:
    """Run the Jira connection check from the command line. Exit code 1 if anything failed."""
    from .diagnostics import format_text, run_diagnostics
    cfg = load_config()
    db = Database(cfg.database_url)
    db.init_schema()
    result = run_diagnostics(Syncer(db, cfg).client(), db.get_settings(), cfg.jira_configured)
    print(format_text(result))
    return 0 if result["ok"] else 1


def reset_passcode() -> int:
    from .access import AccessControl
    cfg = load_config()
    db = Database(cfg.database_url)
    db.init_schema()
    had = AccessControl(db, cfg).reset()
    print("The edit passcode has been removed. Anyone can edit until a new one is set in Customize."
          if had else "There was no edit passcode to remove.")
    return 0


def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "check":
        sys.exit(check())
    if command == "reset-passcode":
        sys.exit(reset_passcode())
    if command:
        print(__doc__)
        sys.exit(2)
    logging.basicConfig(level=os.environ.get("OBEYA_LOG_LEVEL", "INFO").upper(),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    log = logging.getLogger("obeya")
    cfg = load_config()
    db = Database(cfg.database_url)
    db.init_schema()
    syncer = Syncer(db, cfg)
    syncer.start()
    app = App(cfg, db, syncer)
    server = make_server(app)
    log.info("Obeya is listening on http://%s:%s", cfg.host, cfg.port)
    log.info("Storage: %s", db.describe())
    access = app.access.describe({})
    if access["locked"]:
        log.info("Editing is locked: %s", "passcode set" if access["passcodeSet"] else f"editors come from the {cfg.auth_header} header")
    else:
        log.info("Editing is open to anyone who can reach this port. Set a passcode under Customize to lock it.")
    if cfg.jira_configured:
        log.info("Jira: %s, syncing every %s seconds", cfg.jira_base_url, cfg.sync_seconds)
    else:
        log.info("Jira is not connected: set JIRA_BASE_URL and JIRA_TOKEN to enable linked bars")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        syncer.stop()
        server.server_close()


if __name__ == "__main__":
    main()
