"""Lokal lagring: opptak, tekstenheter, revisjoner og endringslogg i SQLite, filer i en mappe.

Teksten fra talemotoren (``text_raw``) endres aldri. Rettinger av tekst og
taler lagres som revisjoner og føres i endringsloggen (se ``audit.py``).
"""

from __future__ import annotations

import hashlib
import json
import secrets
import shutil
import sqlite3
import threading
import time
from pathlib import Path

from verity.audit import AuditLog, load_key

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
CREATE TABLE IF NOT EXISTS revisions (
  id INTEGER PRIMARY KEY, rec_id TEXT NOT NULL, idx INTEGER NOT NULL, field TEXT NOT NULL,
  old TEXT NOT NULL, new TEXT NOT NULL, actor TEXT NOT NULL, ts REAL NOT NULL, audit_seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS revisions_ttu ON revisions (rec_id, idx);
"""

# Skjemaversjoner. 1: text_raw, speaker_raw og sha256. 2: verifisering mot lyd (oktober 2026).
SCHEMA_VERSION = 2


def content_sha(text: str, speaker: str) -> str:
    """Det en verifisering gjelder: teksten og hvem som sa den. Endres en av dem, gjelder ikke verifiseringen lenger."""
    return hashlib.sha256(f"{speaker}\n{text}".encode()).hexdigest()

STATUSES = ("queued", "transcribing", "ready", "failed")
REC_FIELDS = ("id", "name", "kind", "theme", "file", "duration_ms", "status", "error", "speaker", "hotwords",
              "model", "created", "processing_seconds", "sha256")


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class EditConflict(RuntimeError):
    """Endringen ville slettet rettinger brukeren har gjort."""


class Store:
    def __init__(self, root: Path, actor: str | None = None):
        self.root = Path(root)
        self.media = self.root / "media"
        self.media.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._db = sqlite3.connect(self.root / "verity.sqlite3", check_same_thread=False, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA foreign_keys = ON")
        self._db.executescript(SCHEMA)
        self._migrate()
        self.audit = AuditLog(self._db, load_key(self.root), actor)

    def _migrate(self) -> None:
        v = self._db.execute("PRAGMA user_version").fetchone()[0]
        if v < 1:
            cols = {r[1] for r in self._db.execute("PRAGMA table_info(ttus)")}
            if "text_raw" not in cols:
                self._db.execute("ALTER TABLE ttus ADD COLUMN text_raw TEXT")
                self._db.execute("ALTER TABLE ttus ADD COLUMN speaker_raw TEXT")
                self._db.execute("UPDATE ttus SET text_raw = text, speaker_raw = speaker")
            rcols = {r[1] for r in self._db.execute("PRAGMA table_info(recordings)")}
            if "sha256" not in rcols:
                self._db.execute("ALTER TABLE recordings ADD COLUMN sha256 TEXT NOT NULL DEFAULT ''")
        if v < 2:
            cols = {r[1] for r in self._db.execute("PRAGMA table_info(ttus)")}
            if "verified_sha" not in cols:
                for c in ("verified_sha TEXT", "verified_by TEXT", "verified_at REAL", "verified_detail TEXT"):
                    self._db.execute(f"ALTER TABLE ttus ADD COLUMN {c}")
        if v < SCHEMA_VERSION:
            self._db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    def _tx(self):
        """``with self._tx():`` – én transaksjon, så endring og logglinje lagres sammen eller ikke i det hele tatt."""
        store = self

        class _Tx:
            def __enter__(self):
                store._lock.acquire()
                store._db.execute("BEGIN IMMEDIATE")

            def __exit__(self, exc_type, *_):
                try:
                    store._db.execute("ROLLBACK" if exc_type else "COMMIT")
                finally:
                    store._lock.release()

        return _Tx()

    # ---------- opptak
    def new_id(self) -> str:
        return "r" + secrets.token_hex(5)

    def dir_of(self, rec_id: str) -> Path:
        if not rec_id.isalnum():
            raise KeyError(rec_id)
        return self.media / rec_id

    def add(self, rec_id: str, name: str, kind: str, file: str, theme: str = "", speaker: str = "", hotwords: str = "",
            sha256: str = "") -> dict:
        with self._tx():
            self._db.execute(
                "INSERT INTO recordings (id, name, kind, theme, file, status, speaker, hotwords, created, sha256) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (rec_id, name, kind, theme, file, "queued", speaker or "Ukjent taler", hotwords, time.time(), sha256))
            self.audit.record("recording.imported", rec_id=rec_id, detail=json.dumps({"file": file, "sha256": sha256}))
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
            d["revision_count"] = self._db.execute("SELECT COUNT(*) FROM revisions WHERE rec_id = ?", (r["id"],)).fetchone()[0]
            d["verified_count"] = sum(1 for t in self.ttus(r["id"]) if t["verified"])
            d["speakers"] = [x[0] for x in self._db.execute(
                "SELECT speaker FROM ttus WHERE rec_id = ? GROUP BY speaker ORDER BY MIN(idx)", (r["id"],))]
            out.append(d)
        return out

    def update(self, rec_id: str, **fields) -> dict:
        fields = {k: v for k, v in fields.items() if k in REC_FIELDS and k != "id"}
        if fields:
            with self._tx():
                sets = ", ".join(f"{k} = ?" for k in fields)
                self._db.execute(f"UPDATE recordings SET {sets} WHERE id = ?", (*fields.values(), rec_id))  # noqa: S608
        return self.get(rec_id)

    def edit_meta(self, rec_id: str, **fields) -> dict:
        """Navn og tema, ført i loggen."""
        old = self.get(rec_id)
        with self._tx():
            for k, v in fields.items():
                if k in ("name", "theme") and v != old[k]:
                    self._db.execute(f"UPDATE recordings SET {k} = ? WHERE id = ?", (v, rec_id))  # noqa: S608
                    self.audit.record("recording.edited", rec_id=rec_id, field=k, old=old[k], new=v)
        return self.get(rec_id)

    def delete(self, rec_id: str) -> None:
        rec = self.get(rec_id)
        with self._tx():
            self._db.execute("DELETE FROM revisions WHERE rec_id = ?", (rec_id,))
            self._db.execute("DELETE FROM ttus WHERE rec_id = ?", (rec_id,))
            self._db.execute("DELETE FROM recordings WHERE id = ?", (rec_id,))
            self.audit.record("recording.deleted", rec_id=rec_id, detail=json.dumps({"file": rec["file"], "sha256": rec["sha256"]}))
        shutil.rmtree(self.dir_of(rec_id), ignore_errors=True)

    def pending(self) -> list[str]:
        return [r[0] for r in self._db.execute(
            "SELECT id FROM recordings WHERE status IN ('queued', 'transcribing') ORDER BY created")]

    def check_file(self, rec_id: str) -> dict:
        """Regner ut SHA-256 av fila på nytt og sammenligner med verdien fra importen."""
        rec = self.get(rec_id)
        actual = file_sha256(self.dir_of(rec_id) / rec["file"])
        expected = rec["sha256"]
        with self._tx():
            if not expected:  # opptak fra før sjekksummer ble lagret
                self._db.execute("UPDATE recordings SET sha256 = ? WHERE id = ?", (actual, rec_id))
            self.audit.record("recording.file_checked", rec_id=rec_id,
                              detail=json.dumps({"expected": expected, "actual": actual, "ok": not expected or expected == actual}))
        return {"ok": not expected or expected == actual, "expected": expected or actual, "actual": actual, "first_check": not expected}

    # ---------- tekstenheter
    def set_ttus(self, rec_id: str, units: list[dict], speaker: str) -> None:
        with self._tx():
            if self._db.execute("SELECT COUNT(*) FROM revisions WHERE rec_id = ?", (rec_id,)).fetchone()[0]:
                raise EditConflict("opptaket har rettinger som ville gått tapt")
            self._db.execute("DELETE FROM ttus WHERE rec_id = ?", (rec_id,))
            self._db.executemany(
                "INSERT INTO ttus (rec_id, idx, start_ms, end_ms, speaker, text, conf, words, text_raw, speaker_raw) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                [(rec_id, i, u["start_ms"], u["end_ms"], u.get("speaker") or speaker, u["text"], u["conf"],
                  json.dumps(u.get("words", []), ensure_ascii=False), u["text"], u.get("speaker") or speaker)
                 for i, u in enumerate(units)])
            self.audit.record("recording.transcribed", rec_id=rec_id,
                              detail=json.dumps({"ttus": len(units), "text_sha256": hashlib.sha256(
                                  "\n".join(u["text"] for u in units).encode("utf-8")).hexdigest()}))

    def has_revisions(self, rec_id: str) -> bool:
        return bool(self._db.execute("SELECT 1 FROM revisions WHERE rec_id = ? LIMIT 1", (rec_id,)).fetchone())

    def ttus(self, rec_id: str, with_words: bool = False) -> list[dict]:
        cols = ("t.idx, t.start_ms, t.end_ms, t.speaker, t.text, t.conf, t.text_raw, t.verified_sha, t.verified_by, t.verified_at"
                + (", t.words" if with_words else ""))
        rows = self._db.execute(
            f"SELECT {cols}, (SELECT COUNT(*) FROM revisions r WHERE r.rec_id = t.rec_id AND r.idx = t.idx) AS revisions "  # noqa: S608
            "FROM ttus t WHERE t.rec_id = ? ORDER BY t.idx", (rec_id,)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["edited"] = d.pop("text_raw") != d["text"]
            vsha = d.pop("verified_sha")
            # Verifiseringen gjelder bare teksten og taleren slik de var da den ble gjort.
            if not (vsha and vsha == content_sha(d["text"], d["speaker"])):
                d["verified_by"] = d["verified_at"] = None
            d["verified"] = d["verified_at"] is not None
            if with_words:
                d["words"] = json.loads(d["words"])
            out.append(d)
        return out

    def _revise(self, rec_id: str, idx: int, field: str, new: str) -> bool:
        row = self._db.execute(f"SELECT {field} FROM ttus WHERE rec_id = ? AND idx = ?", (rec_id, idx)).fetchone()  # noqa: S608
        if not row:
            raise KeyError(f"{rec_id}/{idx}")
        old = row[0]
        if old == new:
            return False
        self._db.execute(f"UPDATE ttus SET {field} = ? WHERE rec_id = ? AND idx = ?", (new, rec_id, idx))  # noqa: S608
        e = self.audit.record("ttu.revised", rec_id=rec_id, idx=idx, field=field, old=old, new=new)
        self._db.execute("INSERT INTO revisions (rec_id, idx, field, old, new, actor, ts, audit_seq) VALUES (?,?,?,?,?,?,?,?)",
                         (rec_id, idx, field, old, new, e["actor"], e["ts"], e["seq"]))
        return True

    def set_text(self, rec_id: str, idx: int, text: str) -> bool:
        with self._tx():
            return self._revise(rec_id, idx, "text", text)

    def set_speaker(self, rec_id: str, idx: int, speaker: str) -> bool:
        with self._tx():
            return self._revise(rec_id, idx, "speaker", speaker)

    def rename_speaker(self, rec_id: str, old: str, new: str) -> int:
        with self._tx():
            idxs = [r[0] for r in self._db.execute("SELECT idx FROM ttus WHERE rec_id = ? AND speaker = ?", (rec_id, old))]
            for i in idxs:
                self._revise(rec_id, i, "speaker", new)
        return len(idxs)

    def verify(self, rec_id: str, idx: int, text: str, detail: dict) -> dict:
        """Brukeren har hørt hele tekstenheten og godkjenner teksten (eventuelt rettet).

        Rettingen lagres som revisjon, og verifiseringen føres i endringsloggen med
        det klienten rapporterer om avspillingen. Verity kan ikke vite om noen
        faktisk lyttet; loggen viser at hele utsnittet ble spilt av før godkjenning.
        """
        with self._tx():
            self._revise(rec_id, idx, "text", text)
            row = self._db.execute("SELECT text, speaker FROM ttus WHERE rec_id = ? AND idx = ?", (rec_id, idx)).fetchone()
            sha = content_sha(row["text"], row["speaker"])
            e = self.audit.record("ttu.verified", rec_id=rec_id, idx=idx, new=row["text"],
                                  detail=json.dumps({**detail, "content_sha256": sha}, sort_keys=True))
            self._db.execute("UPDATE ttus SET verified_sha = ?, verified_by = ?, verified_at = ?, verified_detail = ? "
                             "WHERE rec_id = ? AND idx = ?", (sha, e["actor"], e["ts"], json.dumps(detail), rec_id, idx))
        return next(t for t in self.ttus(rec_id) if t["idx"] == idx)

    def ttu(self, rec_id: str, idx: int) -> dict:
        for t in self.ttus(rec_id, with_words=True):
            if t["idx"] == idx:
                return t
        raise KeyError(f"{rec_id}/{idx}")

    def revisions(self, rec_id: str, idx: int) -> dict:
        row = self._db.execute("SELECT text_raw, speaker_raw FROM ttus WHERE rec_id = ? AND idx = ?", (rec_id, idx)).fetchone()
        if not row:
            raise KeyError(f"{rec_id}/{idx}")
        revs = [dict(r) for r in self._db.execute(
            "SELECT field, old, new, actor, ts, audit_seq FROM revisions WHERE rec_id = ? AND idx = ? ORDER BY id", (rec_id, idx))]
        ver = [{"actor": e["actor"], "ts": e["ts"], "detail": json.loads(e["detail"] or "{}")}
               for e in self.audit.entries(rec_id, 2000) if e["action"] == "ttu.verified" and e["idx"] == idx]
        return {"text_raw": row["text_raw"], "speaker_raw": row["speaker_raw"], "revisions": revs, "verifications": ver[::-1]}
