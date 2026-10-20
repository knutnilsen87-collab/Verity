"""Lokal lagring: opptak, tekstenheter og bølgeform i en SQLite-fil og en mappe."""

from __future__ import annotations

import json
import secrets
import shutil
import sqlite3
import threading
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS recordings (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, theme TEXT NOT NULL DEFAULT '',
  file TEXT NOT NULL, duration_ms INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
  error TEXT NOT NULL DEFAULT '', speaker TEXT NOT NULL DEFAULT 'Ukjent taler', hotwords TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '', created REAL NOT NULL, processing_seconds REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ttus (
  rec_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE, idx INTEGER NOT NULL,
  start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, speaker TEXT NOT NULL, text TEXT NOT NULL,
  conf REAL NOT NULL, words TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (rec_id, idx)
);
"""

STATUSES = ("queued", "transcribing", "ready", "failed")
REC_FIELDS = ("id", "name", "kind", "theme", "file", "duration_ms", "status", "error", "speaker", "hotwords",
              "model", "created", "processing_seconds")


class Store:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.media = self.root / "media"
        self.media.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(self.root / "verity.sqlite3", check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA foreign_keys = ON")
        self._db.executescript(SCHEMA)
        self._db.commit()

    # ---------- opptak
    def new_id(self) -> str:
        return "r" + secrets.token_hex(5)

    def dir_of(self, rec_id: str) -> Path:
        if not rec_id.isalnum():
            raise KeyError(rec_id)
        return self.media / rec_id

    def add(self, rec_id: str, name: str, kind: str, file: str, theme: str = "", speaker: str = "", hotwords: str = "") -> dict:
        with self._lock:
            self._db.execute(
                "INSERT INTO recordings (id, name, kind, theme, file, status, speaker, hotwords, created) VALUES (?,?,?,?,?,?,?,?,?)",
                (rec_id, name, kind, theme, file, "queued", speaker or "Ukjent taler", hotwords, time.time()))
            self._db.commit()
        return self.get(rec_id)

    def get(self, rec_id: str) -> dict:
        row = self._db.execute("SELECT * FROM recordings WHERE id = ?", (rec_id,)).fetchone()
        if not row:
            raise KeyError(rec_id)
        return dict(row)

    def list(self) -> list[dict]:
        rows = self._db.execute("SELECT * FROM recordings ORDER BY created").fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["ttu_count"] = self._db.execute("SELECT COUNT(*) FROM ttus WHERE rec_id = ?", (r["id"],)).fetchone()[0]
            d["speakers"] = [x[0] for x in self._db.execute(
                "SELECT speaker FROM ttus WHERE rec_id = ? GROUP BY speaker ORDER BY MIN(idx)", (r["id"],))]
            out.append(d)
        return out

    def update(self, rec_id: str, **fields) -> dict:
        fields = {k: v for k, v in fields.items() if k in REC_FIELDS and k != "id"}
        if fields:
            with self._lock:
                sets = ", ".join(f"{k} = ?" for k in fields)
                self._db.execute(f"UPDATE recordings SET {sets} WHERE id = ?", (*fields.values(), rec_id))  # noqa: S608
                self._db.commit()
        return self.get(rec_id)

    def delete(self, rec_id: str) -> None:
        self.get(rec_id)
        with self._lock:
            self._db.execute("DELETE FROM ttus WHERE rec_id = ?", (rec_id,))
            self._db.execute("DELETE FROM recordings WHERE id = ?", (rec_id,))
            self._db.commit()
        shutil.rmtree(self.dir_of(rec_id), ignore_errors=True)

    def pending(self) -> list[str]:
        return [r[0] for r in self._db.execute(
            "SELECT id FROM recordings WHERE status IN ('queued', 'transcribing') ORDER BY created")]

    # ---------- tekstenheter
    def set_ttus(self, rec_id: str, units: list[dict], speaker: str) -> None:
        with self._lock:
            self._db.execute("DELETE FROM ttus WHERE rec_id = ?", (rec_id,))
            self._db.executemany(
                "INSERT INTO ttus (rec_id, idx, start_ms, end_ms, speaker, text, conf, words) VALUES (?,?,?,?,?,?,?,?)",
                [(rec_id, i, u["start_ms"], u["end_ms"], u.get("speaker") or speaker, u["text"], u["conf"],
                  json.dumps(u.get("words", []), ensure_ascii=False)) for i, u in enumerate(units)])
            self._db.commit()

    def ttus(self, rec_id: str, with_words: bool = False) -> list[dict]:
        cols = "idx, start_ms, end_ms, speaker, text, conf" + (", words" if with_words else "")
        rows = self._db.execute(f"SELECT {cols} FROM ttus WHERE rec_id = ? ORDER BY idx", (rec_id,)).fetchall()  # noqa: S608
        out = [dict(r) for r in rows]
        if with_words:
            for r in out:
                r["words"] = json.loads(r["words"])
        return out

    def rename_speaker(self, rec_id: str, old: str, new: str) -> int:
        with self._lock:
            n = self._db.execute("UPDATE ttus SET speaker = ? WHERE rec_id = ? AND speaker = ?", (new, rec_id, old)).rowcount
            self._db.commit()
        return n

    def set_speaker(self, rec_id: str, idx: int, speaker: str) -> None:
        with self._lock:
            n = self._db.execute("UPDATE ttus SET speaker = ? WHERE rec_id = ? AND idx = ?", (speaker, rec_id, idx)).rowcount
            self._db.commit()
        if not n:
            raise KeyError(f"{rec_id}/{idx}")
