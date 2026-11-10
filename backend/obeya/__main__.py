"""Run the Obeya server: python -m obeya"""
from __future__ import annotations

import logging
import os

from .config import load_config
from .db import Database
from .server import App, make_server
from .sync import Syncer


def main() -> None:
    logging.basicConfig(level=os.environ.get("OBEYA_LOG_LEVEL", "INFO").upper(),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    log = logging.getLogger("obeya")
    cfg = load_config()
    db = Database(cfg.database_url)
    db.init_schema()
    syncer = Syncer(db, cfg)
    syncer.start()
    server = make_server(App(cfg, db, syncer))
    log.info("Obeya is listening on http://%s:%s", cfg.host, cfg.port)
    log.info("Storage: %s", db.describe())
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
