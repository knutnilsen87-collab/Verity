"""Revisjoner, endringslogg og sjekksum: det sitater og bevis skal kunne spores tilbake til."""

import hashlib
import sqlite3

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("av")

from test_server import make, wait_ready, wav  # noqa: E402

from verity.store import Store  # noqa: E402


def ready(client):
    data = wav(6.0)
    rid = client.post("/api/recordings?filename=a.wav&speaker=Informant A", content=data).json()["id"]
    wait_ready(client, rid)
    return rid, data


def test_import_stores_sha256_of_exact_file(tmp_path):
    client, _, _ = make(tmp_path)
    with client:
        rid, data = ready(client)
        rec = client.get("/api/recordings").json()["recordings"][0]
        assert rec["sha256"] == hashlib.sha256(data).hexdigest()
        check = client.post(f"/api/recordings/{rid}/check-file").json()
        assert check["ok"] and check["actual"] == rec["sha256"]


def test_changed_file_is_detected(tmp_path):
    client, store, _ = make(tmp_path)
    with client:
        rid, _ = ready(client)
        path = store.dir_of(rid) / "a.wav"
        b = bytearray(path.read_bytes())
        b[-1] ^= 1
        path.write_bytes(bytes(b))
        assert client.post(f"/api/recordings/{rid}/check-file").json()["ok"] is False


def test_text_correction_keeps_original_and_logs_revision(tmp_path):
    client, _, _ = make(tmp_path)
    with client:
        rid, _ = ready(client)
        r = client.put(f"/api/recordings/{rid}/ttus/0/text", json={"text": "Jeg hadde ikke  tillit, sa hun."})
        assert r.json() == {"ok": True, "changed": True}
        assert client.put(f"/api/recordings/{rid}/ttus/0/text", json={"text": "Jeg hadde ikke tillit, sa hun."}).json()["changed"] is False
        assert client.put(f"/api/recordings/{rid}/ttus/0/speaker", json={"speaker": "Intervjuer"}).status_code == 200
        ttu = client.get("/api/library").json()["recordings"][0]["ttus"][0]
        assert ttu["text"] == "Jeg hadde ikke tillit, sa hun." and ttu["edited"] and ttu["revisions"] == 2
        rev = client.get(f"/api/recordings/{rid}/ttus/0/revisions").json()
        assert rev["text_raw"] == "Jeg hadde ikke tillit." and rev["speaker_raw"] == "Informant A"
        assert [(x["field"], x["old"], x["new"]) for x in rev["revisions"]] == [
            ("text", "Jeg hadde ikke tillit.", "Jeg hadde ikke tillit, sa hun."), ("speaker", "Informant A", "Intervjuer")]
        assert client.put(f"/api/recordings/{rid}/ttus/0/text", json={"text": "  "}).status_code == 400


def test_retranscribing_is_refused_when_there_are_corrections(tmp_path):
    client, _, _ = make(tmp_path)
    with client:
        rid, _ = ready(client)
        assert client.post(f"/api/recordings/{rid}/retry").status_code == 200
        wait_ready(client, rid)
        client.put(f"/api/recordings/{rid}/ttus/1/text", json={"text": "Etter hvert ble det mye bedre."})
        r = client.post(f"/api/recordings/{rid}/retry")
        assert r.status_code == 409 and "rettinger" in r.json()["detail"]


def test_audit_chain_detects_tampering_and_keeps_no_text(tmp_path):
    client, store, _ = make(tmp_path)
    with client:
        rid, _ = ready(client)
        client.put(f"/api/recordings/{rid}/ttus/0/text", json={"text": "Hemmelig formulering."})
        client.patch(f"/api/recordings/{rid}", json={"theme": "Tilsyn"})
        audit = client.get("/api/audit").json()
        assert audit["verify"]["ok"] and audit["verify"]["entries"] >= 4
        actions = [e["action"] for e in audit["entries"]]
        assert {"recording.imported", "recording.transcribed", "ttu.revised", "recording.edited"} <= set(actions)
    db = sqlite3.connect(tmp_path / "data" / "verity.sqlite3")
    dump = "\n".join(str(r) for r in db.execute("SELECT * FROM audit"))
    assert "Hemmelig" not in dump  # bare sjekksummer av teksten i loggen
    db.execute("UPDATE audit SET actor = 'noen andre' WHERE seq = 2")
    db.commit()
    store2 = Store(tmp_path / "data")
    v = store2.audit.verify()
    assert v["ok"] is False and v["broken_at"] == 2


def test_deleting_recording_removes_text_but_chain_stays_intact(tmp_path):
    client, store, _ = make(tmp_path)
    with client:
        rid, _ = ready(client)
        client.put(f"/api/recordings/{rid}/ttus/0/text", json={"text": "Personopplysning her."})
        client.delete(f"/api/recordings/{rid}")
        audit = client.get("/api/audit").json()
        assert audit["verify"]["ok"] and audit["entries"][0]["action"] == "recording.deleted"
    db = sqlite3.connect(tmp_path / "data" / "verity.sqlite3")
    assert db.execute("SELECT COUNT(*) FROM revisions").fetchone()[0] == 0


def test_old_database_is_migrated(tmp_path):
    root = tmp_path / "old"
    root.mkdir()
    db = sqlite3.connect(root / "verity.sqlite3")
    db.executescript("""
    CREATE TABLE recordings (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, theme TEXT NOT NULL DEFAULT '',
      file TEXT NOT NULL, duration_ms INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '',
      speaker TEXT NOT NULL DEFAULT 'Ukjent taler', hotwords TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
      created REAL NOT NULL, processing_seconds REAL NOT NULL DEFAULT 0);
    CREATE TABLE ttus (rec_id TEXT NOT NULL, idx INTEGER NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
      speaker TEXT NOT NULL, text TEXT NOT NULL, conf REAL NOT NULL, words TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (rec_id, idx));
    INSERT INTO recordings VALUES ('rabc', 'Gammelt', 'lyd', '', 'g.wav', 1000, 'ready', '', 'A', '', '', 1.0, 0);
    INSERT INTO ttus VALUES ('rabc', 0, 0, 900, 'A', 'Gammel tekst.', 0.9, '[]');
    """)
    db.commit()
    db.close()
    s = Store(root)
    assert s.ttus("rabc")[0]["edited"] is False and s.get("rabc")["sha256"] == ""
    assert s.revisions("rabc", 0)["text_raw"] == "Gammel tekst."


def test_verification_requires_full_playback_and_is_logged(tmp_path):
    client, _, _ = make(tmp_path)
    with client:
        rid, _ = ready(client)
        url = f"/api/recordings/{rid}/ttus/0/verify"
        assert client.post(url, json={"text": "Jeg hadde ikke tillit."}).status_code == 409
        r = client.post(url, json={"text": "Jeg hadde ikke tillit.", "full_playback": True, "loops": 2, "slowest_rate": 0.75})
        assert r.status_code == 200 and r.json()["verified"] and r.json()["verified_by"]
        ttu = client.get("/api/library").json()["recordings"][0]["ttus"]
        assert ttu[0]["verified"] and not ttu[1]["verified"] and not ttu[0]["edited"]
        hist = client.get(f"/api/recordings/{rid}/ttus/0/revisions").json()
        assert hist["verifications"][0]["detail"]["loops"] == 2 and hist["verifications"][0]["detail"]["slowest_rate"] == 0.75
        assert client.get("/api/recordings").json()["recordings"][0]["verified_count"] == 1
        assert client.get("/api/audit").json()["verify"]["ok"]


def test_correction_during_verification_is_a_revision(tmp_path):
    client, _, _ = make(tmp_path)
    with client:
        rid, _ = ready(client)
        r = client.post(f"/api/recordings/{rid}/ttus/0/verify", json={"text": "Jeg hadde ikke tillit, sa hun.", "full_playback": True})
        assert r.json()["verified"] and r.json()["edited"] and r.json()["revisions"] == 1


def test_editing_after_verification_removes_it(tmp_path):
    client, _, _ = make(tmp_path)
    with client:
        rid, _ = ready(client)
        client.post(f"/api/recordings/{rid}/ttus/0/verify", json={"text": "Jeg hadde ikke tillit.", "full_playback": True})
        client.put(f"/api/recordings/{rid}/ttus/0/speaker", json={"speaker": "Intervjuer"})
        assert client.get("/api/library").json()["recordings"][0]["ttus"][0]["verified"] is False
        client.put(f"/api/recordings/{rid}/ttus/0/speaker", json={"speaker": "Informant A"})
        # samme tekst og taler som da den ble verifisert: verifiseringen gjelder igjen
        assert client.get("/api/library").json()["recordings"][0]["ttus"][0]["verified"] is True
        client.put(f"/api/recordings/{rid}/ttus/0/text", json={"text": "Noe annet."})
        assert client.get("/api/library").json()["recordings"][0]["ttus"][0]["verified"] is False


def test_single_ttu_has_words_with_probability(tmp_path):
    client, _, _ = make(tmp_path)
    with client:
        rid, _ = ready(client)
        t = client.get(f"/api/recordings/{rid}/ttus/1").json()
        assert [w["t"] for w in t["words"]] == ["Etter", "hvert", "ble", "det", "bedre."]
        assert min(w["p"] for w in t["words"]) == 0.5
