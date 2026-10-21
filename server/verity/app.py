"""Verity-tjenesten: lokal API og nettsiden.

Lytter bare på 127.0.0.1. Lyd, video og tekst lagres i datamappen
(``%LOCALAPPDATA%\\Verity`` som standard) og sendes bare til talemotoren på
samme maskin.
"""

from __future__ import annotations

import argparse
import hashlib
import logging
import os
import re
import shutil
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from verity import __version__, media
from verity.engine import EngineClient, EngineError
from verity.store import Store
from verity.worker import Worker

log = logging.getLogger("verity")

MAX_UPLOAD_BYTES = 8 * 1024**3
DEFAULT_PORT = 8780
WEB_DIST = Path(__file__).resolve().parents[2] / "web" / "dist"


def default_root() -> Path:
    base = os.environ.get("VERITY_DATA") or os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~/.local/share"), "Verity")
    return Path(base)


def _clean(s: str | None, limit: int = 200) -> str:
    return re.sub(r"[\x00-\x1f]", " ", (s or "")).strip()[:limit]


def _safe_filename(name: str) -> str:
    stem = re.sub(r"[^\w.\- ]", "_", Path(name or "opptak").name).strip(" .") or "opptak"
    return stem[:120]


def create_app(store: Store, engine: EngineClient, *, port: int = DEFAULT_PORT, web_dist: Path | None = WEB_DIST,
               start_worker: bool = True):
    worker = Worker(store, engine)
    hosts = {f"{h}:{port}" for h in ("127.0.0.1", "localhost")} | {"127.0.0.1", "localhost"}

    @asynccontextmanager
    async def lifespan(_app):
        if start_worker:
            worker.start()
        yield
        worker.stop()

    app = FastAPI(title="Verity", version=__version__, lifespan=lifespan)
    app.state.store, app.state.worker = store, worker

    @app.middleware("http")
    async def check_host(request: Request, call_next):
        # Mot DNS-rebinding: en fremmed nettside kan ikke late som den er 127.0.0.1.
        if request.headers.get("host", "") not in hosts:
            return JSONResponse({"detail": "ukjent Host"}, status_code=421)
        # Endringer bare fra Veritys egen side (eller uten nettleser).
        origin = request.headers.get("origin")
        if request.method not in ("GET", "HEAD") and origin and origin not in {f"http://{h}" for h in hosts}:
            return JSONResponse({"detail": "fremmed nettside"}, status_code=403)
        return await call_next(request)

    def rec_or_404(rec_id: str) -> dict:
        try:
            return store.get(rec_id)
        except KeyError:
            raise HTTPException(404, "fant ikke opptaket") from None

    @app.get("/api/health")
    def health():
        try:
            eng = {"ok": True, **engine.health()}
        except EngineError as e:
            eng = {"ok": False, "error": str(e)}
        return {"service": "verity", "version": __version__, "engine": eng}

    @app.get("/api/library")
    def library():
        """Alt søket trenger: ferdige opptak med tekstenheter."""
        recs = [r for r in store.list() if r["status"] == "ready"]
        return {"recordings": [{**r, "ttus": store.ttus(r["id"])} for r in recs]}

    @app.get("/api/recordings")
    def recordings():
        return {"recordings": store.list()}

    @app.post("/api/recordings", status_code=201)
    async def upload(request: Request, filename: str = "", name: str = "", theme: str = "", speaker: str = "",
                     hotwords: str = ""):
        fname = _safe_filename(filename)
        rec_id = store.new_id()
        folder = store.dir_of(rec_id)
        folder.mkdir(parents=True)
        size = 0
        sha = hashlib.sha256()  # sjekksum mens fila mottas: identifiserer nøyaktig denne fila i sitater
        with open(folder / fname, "wb") as f:
            async for chunk in request.stream():
                size += len(chunk)
                sha.update(chunk)
                if size > MAX_UPLOAD_BYTES:
                    f.close()
                    shutil.rmtree(folder, ignore_errors=True)
                    raise HTTPException(413, "filen er for stor (over 8 GB)")
                f.write(chunk)
        if not size:
            shutil.rmtree(folder, ignore_errors=True)
            raise HTTPException(400, "tom fil")
        rec = store.add(rec_id, _clean(name) or Path(fname).stem, media.kind_of(fname, request.headers.get("content-type", "")),
                        fname, theme=_clean(theme), speaker=_clean(speaker, 80), hotwords=_clean(hotwords, 500),
                        sha256=sha.hexdigest())
        worker.submit(rec_id)
        return rec

    @app.patch("/api/recordings/{rec_id}")
    async def edit(rec_id: str, request: Request):
        rec_or_404(rec_id)
        body = await request.json()
        fields = {k: _clean(body[k]) for k in ("name", "theme") if isinstance(body.get(k), str)}
        if fields.get("name") == "":
            raise HTTPException(400, "navnet kan ikke være tomt")
        for old, new in (body.get("speakers") or {}).items():
            if _clean(new, 80):
                store.rename_speaker(rec_id, old, _clean(new, 80))
        return store.edit_meta(rec_id, **fields)

    @app.put("/api/recordings/{rec_id}/ttus/{idx}/speaker")
    async def set_speaker(rec_id: str, idx: int, request: Request):
        rec_or_404(rec_id)
        speaker = _clean((await request.json()).get("speaker"), 80)
        if not speaker:
            raise HTTPException(400, "taler mangler")
        try:
            store.set_speaker(rec_id, idx, speaker)
        except KeyError:
            raise HTTPException(404, "fant ikke tekstenheten") from None
        return {"ok": True}

    @app.put("/api/recordings/{rec_id}/ttus/{idx}/text")
    async def set_text(rec_id: str, idx: int, request: Request):
        """Retting av tekst. Originalen fra talemotoren beholdes; rettingen føres som revisjon."""
        rec_or_404(rec_id)
        text = re.sub(r"\s+", " ", str((await request.json()).get("text") or "")).strip()[:5000]
        if not text:
            raise HTTPException(400, "teksten kan ikke være tom")
        try:
            changed = store.set_text(rec_id, idx, text)
        except KeyError:
            raise HTTPException(404, "fant ikke tekstenheten") from None
        return {"ok": True, "changed": changed}

    @app.get("/api/recordings/{rec_id}/ttus/{idx}")
    def ttu(rec_id: str, idx: int):
        """Én tekstenhet med ord, tider og sannsynlighet (til verifisering)."""
        rec_or_404(rec_id)
        try:
            return store.ttu(rec_id, idx)
        except KeyError:
            raise HTTPException(404, "fant ikke tekstenheten") from None

    @app.post("/api/recordings/{rec_id}/ttus/{idx}/verify")
    async def verify(rec_id: str, idx: int, request: Request):
        """Godkjenner teksten etter at hele tekstenheten er spilt av.

        Klienten må rapportere at hele utsnittet ble spilt av (``full_playback``).
        Det føres i endringsloggen sammen med hastighet og antall gjennomspillinger.
        """
        rec_or_404(rec_id)
        body = await request.json()
        if body.get("full_playback") is not True:
            raise HTTPException(409, "hele tekstenheten må spilles av før den kan verifiseres")
        text = re.sub(r"\s+", " ", str(body.get("text") or "")).strip()[:5000]
        if not text:
            raise HTTPException(400, "teksten kan ikke være tom")
        detail = {"full_playback": True, "loops": int(body.get("loops") or 0),
                  "slowest_rate": float(body.get("slowest_rate") or 1.0), "listened_ms": int(body.get("listened_ms") or 0)}
        try:
            return store.verify(rec_id, idx, text, detail)
        except KeyError:
            raise HTTPException(404, "fant ikke tekstenheten") from None

    @app.get("/api/recordings/{rec_id}/ttus/{idx}/revisions")
    def revisions(rec_id: str, idx: int):
        rec_or_404(rec_id)
        try:
            return store.revisions(rec_id, idx)
        except KeyError:
            raise HTTPException(404, "fant ikke tekstenheten") from None

    @app.post("/api/recordings/{rec_id}/check-file")
    def check_file(rec_id: str):
        """Er fila på disken den samme som ble importert?"""
        rec_or_404(rec_id)
        return store.check_file(rec_id)

    @app.get("/api/audit")
    def audit(rec_id: str | None = None, limit: int = 200):
        return {"verify": store.audit.verify(), "entries": store.audit.entries(rec_id, min(max(limit, 1), 2000))}

    @app.post("/api/recordings/{rec_id}/retry")
    def retry(rec_id: str):
        rec = rec_or_404(rec_id)
        if rec["status"] not in ("failed", "ready"):
            raise HTTPException(409, "opptaket er allerede i kø")
        if store.has_revisions(rec_id):
            raise HTTPException(409, "opptaket har rettinger som ville gått tapt ved ny transkripsjon")
        store.update(rec_id, status="queued", error="")
        worker.submit(rec_id)
        return store.get(rec_id)

    @app.delete("/api/recordings/{rec_id}")
    def delete(rec_id: str):
        rec_or_404(rec_id)
        store.delete(rec_id)
        return {"ok": True}

    @app.get("/api/recordings/{rec_id}/media")
    def media_file(rec_id: str):
        rec = rec_or_404(rec_id)
        return FileResponse(store.dir_of(rec_id) / rec["file"])

    @app.get("/api/recordings/{rec_id}/peaks")
    def peaks(rec_id: str, from_ms: int = 0, to_ms: int = 0, n: int = 90):
        rec_or_404(rec_id)
        path = store.dir_of(rec_id) / "peaks.bin"
        if not path.exists():
            return {"bars": [0] * n}
        return {"bars": media.window(path.read_bytes(), from_ms, to_ms, min(max(n, 1), 1000))}

    if web_dist and (web_dist / "index.html").exists():
        app.mount("/", StaticFiles(directory=web_dist, html=True), name="web")
    return app


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description="Verity: søk i egne opptak, lokalt")
    p.add_argument("--port", type=int, default=DEFAULT_PORT)
    p.add_argument("--data", default=None, help="datamappe (standard %%LOCALAPPDATA%%\\Verity)")
    p.add_argument("--engine-url", default=None)
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    import uvicorn

    root = Path(args.data) if args.data else default_root()
    app = create_app(Store(root), EngineClient(args.engine_url), port=args.port)
    print(f"Verity {__version__}: http://127.0.0.1:{args.port}/  (data: {root})")
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
