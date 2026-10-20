import io
import time
import wave

import numpy as np
import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")
pytest.importorskip("av")

from fastapi.testclient import TestClient  # noqa: E402

from verity import media  # noqa: E402
from verity.app import create_app  # noqa: E402
from verity.engine import EngineClient, EngineError  # noqa: E402
from verity.segment import segment  # noqa: E402
from verity.store import Store  # noqa: E402

BASE = "http://127.0.0.1:8780"


def wav(seconds: float, tone_from: float = 1.0, tone_to: float = 3.0) -> bytes:
    t = np.arange(int(seconds * media.SAMPLE_RATE)) / media.SAMPLE_RATE
    x = np.where((t >= tone_from) & (t < tone_to), 0.5 * np.sin(2 * np.pi * 220 * t), 0.0)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(media.SAMPLE_RATE)
        w.writeframes((x * 32767).astype("<i2").tobytes())
    return buf.getvalue()


class FakeEngine:
    def __init__(self, fail: str | None = None):
        self.calls = []
        self.fail = fail

    def health(self):
        if self.fail:
            raise EngineError(self.fail)
        return {"status": "ok", "model": "fake"}

    def transcribe(self, data, hotwords=None):
        self.calls.append((len(data), hotwords))
        if self.fail:
            raise EngineError(self.fail)
        words = [("Jeg", 1.0, 1.2), ("hadde", 1.25, 1.5), ("ikke", 1.55, 1.8), ("tillit.", 1.85, 2.3),
                 ("Etter", 4.0, 4.3), ("hvert", 4.35, 4.6), ("ble", 4.65, 4.8), ("det", 4.85, 5.0), ("bedre.", 5.05, 5.6)]
        return {"model": "fake", "words": [{"text": a, "start": s, "end": e, "probability": 0.5 if a == "hvert" else 0.9,
                                            "joined": False} for a, s, e in words]}


def make(tmp_path, engine=None):
    store = Store(tmp_path / "data")
    engine = engine or FakeEngine()
    app = create_app(store, engine, web_dist=None)
    return TestClient(app, base_url=BASE), store, engine


def wait_ready(client, rec_id, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        rec = next(r for r in client.get("/api/recordings").json()["recordings"] if r["id"] == rec_id)
        if rec["status"] in ("ready", "failed"):
            return rec
        time.sleep(0.05)
    raise AssertionError("importen ble ikke ferdig")


def test_import_transcribes_and_library_has_ttus(tmp_path):
    client, store, engine = make(tmp_path)
    with client:
        r = client.post("/api/recordings?filename=intervju_07.wav&name=Intervju 07&theme=Trygghetsalarm&speaker=Informant A",
                        content=wav(6.0), headers={"content-type": "audio/wav"})
        assert r.status_code == 201
        rec = wait_ready(client, r.json()["id"])
        assert rec["status"] == "ready" and rec["kind"] == "lyd" and rec["duration_ms"] == 6000
        assert engine.calls and engine.calls[0][1] == "Trygghetsalarm"  # tema sendes som kontekst
        lib = client.get("/api/library").json()["recordings"]
        ttus = lib[0]["ttus"]
        assert [t["text"] for t in ttus] == ["Jeg hadde ikke tillit.", "Etter hvert ble det bedre."]
        assert ttus[0]["speaker"] == "Informant A" and ttus[0]["start_ms"] == 1000
        assert ttus[1]["conf"] < ttus[0]["conf"]


def test_engine_down_marks_recording_failed_with_reason(tmp_path):
    client, _, _ = make(tmp_path, FakeEngine(fail="talemotoren kjører ikke på http://127.0.0.1:8765"))
    with client:
        r = client.post("/api/recordings?filename=a.wav", content=wav(4.0))
        rec = wait_ready(client, r.json()["id"])
        assert rec["status"] == "failed" and "kjører ikke" in rec["error"]
        health = client.get("/api/health").json()
        assert health["engine"]["ok"] is False
        assert client.get("/api/library").json()["recordings"] == []


def test_unreadable_file_fails_honestly(tmp_path):
    client, _, engine = make(tmp_path)
    with client:
        r = client.post("/api/recordings?filename=a.wav", content=b"ikke lyd i det hele tatt")
        rec = wait_ready(client, r.json()["id"])
        assert rec["status"] == "failed" and rec["error"].startswith("kunne ikke lese opptaket")
        assert not engine.calls


def test_rename_speakers_edit_and_delete(tmp_path):
    client, store, _ = make(tmp_path)
    with client:
        rid = client.post("/api/recordings?filename=b.wav", content=wav(6.0)).json()["id"]
        wait_ready(client, rid)
        edit = {"speakers": {"Ukjent taler": "Informant B"}, "theme": "Tilsyn"}
        assert client.patch(f"/api/recordings/{rid}", json=edit).status_code == 200
        assert client.put(f"/api/recordings/{rid}/ttus/0/speaker", json={"speaker": "Intervjuer"}).status_code == 200
        rec = client.get("/api/recordings").json()["recordings"][0]
        assert rec["theme"] == "Tilsyn" and rec["speakers"] == ["Intervjuer", "Informant B"]
        assert client.delete(f"/api/recordings/{rid}").status_code == 200
        assert client.get("/api/recordings").json()["recordings"] == []
        assert not store.dir_of(rid).exists()


def test_media_with_range_and_peaks(tmp_path):
    client, _, _ = make(tmp_path)
    with client:
        rid = client.post("/api/recordings?filename=c.wav", content=wav(6.0)).json()["id"]
        wait_ready(client, rid)
        r = client.get(f"/api/recordings/{rid}/media", headers={"Range": "bytes=0-99"})
        assert r.status_code == 206 and len(r.content) == 100
        bars = client.get(f"/api/recordings/{rid}/peaks?from_ms=0&to_ms=6000&n=6").json()["bars"]
        assert bars[0] == 0 and bars[1] > 50 and bars[4] == 0  # tonen ligger mellom 1 og 3 s


def test_foreign_host_and_origin_are_rejected(tmp_path):
    client, _, _ = make(tmp_path)
    with client:
        assert client.get("/api/recordings", headers={"host": "evil.example"}).status_code == 421
        assert client.post("/api/recordings?filename=a.wav", content=wav(1.0),
                           headers={"origin": "https://evil.example"}).status_code == 403
        assert client.get("/api/recordings/../../etc/media").status_code == 404


def test_segment_splits_on_pause_sentence_and_length():
    w = lambda t, s, e, p=0.9, j=False: {"text": t, "start": s, "end": e, "probability": p, "joined": j}  # noqa: E731
    # pause over 0,8 s
    assert len(segment([w("a", 0, 0.5), w("b", 2.0, 2.5)])) == 2
    # punktum, men enheten er for kort: ingen deling
    assert len(segment([w("Ja.", 0, 0.5), w("Greit", 0.6, 1.0)])) == 1
    # sammenhengende tale deles senest etter 20 s
    long = [w(f"o{i}", i * 0.5, i * 0.5 + 0.45) for i in range(100)]
    units = segment(long)
    assert len(units) >= 3 and all(u["end_ms"] - u["start_ms"] <= 20000 for u in units)
    # ord som henger sammen (13.2) skilles aldri
    assert segment([w("13", 0, 0.3), w(".2", 2.0, 2.2, j=True)])[0]["text"] == "13.2"


def test_engine_client_refuses_remote_url_and_explains_missing_token(tmp_path):
    with pytest.raises(ValueError):
        EngineClient("http://example.com:8765")
    c = EngineClient("http://127.0.0.1:1", token_file=tmp_path / "mangler")
    with pytest.raises(EngineError, match="nøkkelen"):
        c.transcribe(b"x")
    with pytest.raises(EngineError, match="kjører ikke"):
        c.health()
