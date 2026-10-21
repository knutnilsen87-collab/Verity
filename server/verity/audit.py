"""Endringslogg med HMAC-kjede.

Hver hendelse (import, retting av tekst eller taler, sletting, kontroll av fil)
får en HMAC over innholdet og forrige hendelses HMAC. Endres, fjernes eller
settes en linje inn i ettertid, brytes kjeden, og ``verify`` sier hvor. At de
siste linjene er kuttet bort, kan bare oppdages mot en tidligere kjent
``head`` (siste HMAC), som vises i Biblioteket.

Loggen lagrer aldri selve teksten, bare SHA-256 av gammel og ny verdi. Teksten
ligger i revisjonene til opptaket og slettes sammen med det; kjeden forblir hel
og viser at det fantes en retting, uten å beholde personopplysninger.

Beskytter mot: utilsiktede eller naive endringer i databasen, og mot at noen
uten nøkkelen lager en troverdig logg. Beskytter ikke mot noen som har
nøkkelfila (``audit.key`` i datamappen, samme Windows-bruker): de kan skrive
hele loggen på nytt. Ekstern forankring (for eksempel en signert kopi av siste
HMAC utenfor maskinen) er neste steg.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time
from pathlib import Path

GENESIS = "0" * 64


def digest(value: str | None) -> str:
    return hashlib.sha256((value or "").encode("utf-8")).hexdigest() if value is not None else ""


def load_key(root: Path) -> bytes:
    path = Path(root) / "audit.key"
    if path.exists():
        return bytes.fromhex(path.read_text(encoding="ascii").strip())
    key = secrets.token_bytes(32)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(key.hex(), encoding="ascii")
    os.replace(tmp, path)
    return key


def actor_default() -> str:
    return os.environ.get("USERNAME") or os.environ.get("USER") or "ukjent"


def _canonical(entry: dict) -> bytes:
    fields = {k: entry[k] for k in ("seq", "ts", "actor", "action", "rec_id", "idx", "field", "old_sha", "new_sha", "detail", "prev")}
    return json.dumps(fields, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


class AuditLog:
    SCHEMA = """
    CREATE TABLE IF NOT EXISTS audit (
      seq INTEGER PRIMARY KEY, ts REAL NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
      rec_id TEXT NOT NULL DEFAULT '', idx INTEGER, field TEXT NOT NULL DEFAULT '',
      old_sha TEXT NOT NULL DEFAULT '', new_sha TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '',
      prev TEXT NOT NULL, mac TEXT NOT NULL
    );
    """

    def __init__(self, db: sqlite3.Connection, key: bytes, actor: str | None = None):
        self.db, self.key, self.actor = db, key, actor or actor_default()
        db.executescript(self.SCHEMA)

    def record(self, action: str, *, rec_id: str = "", idx: int | None = None, field: str = "",
               old: str | None = None, new: str | None = None, detail: str = "") -> dict:
        """Legger til en hendelse. Kalles inne i samme transaksjon som endringen."""
        last = self.db.execute("SELECT seq, mac FROM audit ORDER BY seq DESC LIMIT 1").fetchone()
        entry = {"seq": (last[0] + 1) if last else 1, "ts": round(time.time(), 3), "actor": self.actor, "action": action,
                 "rec_id": rec_id, "idx": idx, "field": field, "old_sha": digest(old), "new_sha": digest(new),
                 "detail": detail, "prev": last[1] if last else GENESIS}
        entry["mac"] = hmac.new(self.key, _canonical(entry), hashlib.sha256).hexdigest()
        self.db.execute(
            "INSERT INTO audit (seq, ts, actor, action, rec_id, idx, field, old_sha, new_sha, detail, prev, mac) "
            "VALUES (:seq, :ts, :actor, :action, :rec_id, :idx, :field, :old_sha, :new_sha, :detail, :prev, :mac)", entry)
        return entry

    def verify(self) -> dict:
        prev, n = GENESIS, 0
        cur = self.db.execute(
            "SELECT seq, ts, actor, action, rec_id, idx, field, old_sha, new_sha, detail, prev, mac FROM audit ORDER BY seq")
        cols = [c[0] for c in cur.description]
        expect_seq = 1
        for row in cur:
            e = dict(zip(cols, row, strict=True))
            mac = hmac.new(self.key, _canonical(e), hashlib.sha256).hexdigest()
            if e["seq"] != expect_seq or e["prev"] != prev or not hmac.compare_digest(mac, e["mac"]):
                return {"ok": False, "entries": n, "broken_at": e["seq"]}
            prev, n, expect_seq = e["mac"], n + 1, expect_seq + 1
        return {"ok": True, "entries": n, "broken_at": None, "head": prev}

    def entries(self, rec_id: str | None = None, limit: int = 500) -> list[dict]:
        q = "SELECT seq, ts, actor, action, rec_id, idx, field, detail FROM audit"
        args: tuple = ()
        if rec_id:
            q += " WHERE rec_id = ?"
            args = (rec_id,)
        q += " ORDER BY seq DESC LIMIT ?"
        cur = self.db.execute(q, (*args, limit))
        cols = [c[0] for c in cur.description]
        return [dict(zip(cols, r, strict=True)) for r in cur]
