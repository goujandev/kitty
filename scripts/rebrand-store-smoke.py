"""Synthetic installed-upgrade fixtures; restricted to disposable GitHub runners."""
import os
import sqlite3
import sys
from pathlib import Path

if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted":
    raise SystemExit("This test only runs on disposable GitHub-hosted runners.")
mode, filename = sys.argv[1:]
database = Path(filename)
assert database.is_file(), "Installed app did not create its database"
settings = {"theme": "nord", "zoom": "1.3", "rail_widths": '{"projects":300,"chats":310}', "background": "background.png"}
with sqlite3.connect(database) as connection:
    connection.execute("PRAGMA foreign_keys = ON")
    if mode == "seed":
        connection.execute("INSERT INTO projects (id,root,name,created_at,last_opened_at) VALUES ('release-smoke',NULL,'Saved upgrade test',1,1)")
        connection.execute("INSERT INTO sessions (id,project_id,harness,title,created_at,updated_at) VALUES ('release-smoke-chat','release-smoke','codex','Saved conversation',1,1)")
        connection.execute("INSERT INTO blocks (session_id,seq,kind,text,created_at) VALUES ('release-smoke-chat',0,'user','Keep this conversation after the Pantheon upgrade',1)")
        connection.execute("INSERT INTO blocks_fts (text,session_id,seq) VALUES ('Keep this conversation after the Pantheon upgrade','release-smoke-chat',0)")
        for key, value in settings.items():
            connection.execute("INSERT OR REPLACE INTO settings (scope,scope_id,key,value) VALUES ('ui','',?,?)", (key, value))
    elif mode == "verify":
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        assert connection.execute("SELECT name FROM projects WHERE id='release-smoke'").fetchone()[0] == "Saved upgrade test"
        assert connection.execute("SELECT title FROM sessions WHERE id='release-smoke-chat'").fetchone()[0] == "Saved conversation"
        assert connection.execute("SELECT text FROM blocks WHERE session_id='release-smoke-chat' AND seq=0").fetchone()[0] == "Keep this conversation after the Pantheon upgrade"
        for key, value in settings.items():
            assert connection.execute("SELECT value FROM settings WHERE scope='ui' AND scope_id='' AND key=?", (key,)).fetchone()[0] == value, key
    else:
        raise SystemExit("Expected seed or verify")
print(f"Installed-upgrade database {mode} passed.")
