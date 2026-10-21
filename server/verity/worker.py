"""Importkø: ett opptak om gangen gjennom dekoding, talemotoren og oppdeling."""

from __future__ import annotations

import logging
import queue
import threading
import time

from verity import media
from verity.engine import EngineClient, EngineError
from verity.segment import segment
from verity.store import EditConflict, Store

log = logging.getLogger("verity.worker")


def process(store: Store, engine: EngineClient, rec_id: str) -> dict:
    rec = store.get(rec_id)
    folder = store.dir_of(rec_id)
    store.update(rec_id, status="transcribing", error="")
    t0 = time.perf_counter()
    try:
        pcm = media.decode(folder / rec["file"])
        (folder / "peaks.bin").write_bytes(media.peaks(pcm))
        store.update(rec_id, duration_ms=int(len(pcm) * 1000 / media.SAMPLE_RATE))
        hot = ", ".join(x for x in (rec["hotwords"], rec["theme"]) if x) or None
        result = engine.transcribe(media.wav_bytes(pcm), hotwords=hot)
        units = segment(result.get("words", []))
        store.set_ttus(rec_id, units, rec["speaker"])
        return store.update(rec_id, status="ready", model=result.get("model", ""),
                            processing_seconds=round(time.perf_counter() - t0, 1))
    except EngineError as e:
        return store.update(rec_id, status="failed", error=str(e))
    except EditConflict as e:
        return store.update(rec_id, status="ready", error=str(e))
    except Exception as e:  # noqa: BLE001 - vises til brukeren i biblioteket
        log.exception("import av %s feilet", rec_id)
        return store.update(rec_id, status="failed", error=f"kunne ikke lese opptaket: {e}")


class Worker:
    def __init__(self, store: Store, engine: EngineClient):
        self.store, self.engine = store, engine
        self.q: queue.Queue[str | None] = queue.Queue()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        for rec_id in self.store.pending():  # avbrutt ved forrige avslutning
            self.store.update(rec_id, status="queued")
            self.q.put(rec_id)
        self._thread = threading.Thread(target=self._run, name="verity-import", daemon=True)
        self._thread.start()

    def submit(self, rec_id: str) -> None:
        self.q.put(rec_id)

    def stop(self) -> None:
        self.q.put(None)

    def _run(self) -> None:
        while (rec_id := self.q.get()) is not None:
            try:
                process(self.store, self.engine, rec_id)
            except KeyError:
                pass  # slettet mens det sto i kø
