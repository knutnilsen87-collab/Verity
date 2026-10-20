"""Klient mot talemotoren nsb-engine (NorwegianSpeechBase) på samme maskin.

Verity snakker med motoren fra tjenesten, ikke fra nettleseren, så nøkkelen
leses rett fra fila motoren lager (``%LOCALAPPDATA%\\nsb-engine\\access_token``,
samme Windows-bruker) og forlater aldri maskinen.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_URL = "http://127.0.0.1:8765"


class EngineError(RuntimeError):
    """Feil fra talemotoren, med en forklaring brukeren kan handle på."""


def default_token_file() -> Path:
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~/.local/share")
    return Path(base) / "nsb-engine" / "access_token"


class EngineClient:
    def __init__(self, url: str | None = None, token_file: Path | None = None, timeout: float = 4 * 3600):
        self.url = (url or os.environ.get("NSB_ENGINE_URL") or DEFAULT_URL).rstrip("/")
        if not self.url.startswith(("http://127.0.0.1:", "http://localhost:", "http://[::1]:")):
            raise ValueError("talemotoren må kjøre på denne maskinen (http://127.0.0.1:…)")
        self.token_file = Path(token_file or os.environ.get("NSB_ENGINE_TOKEN_FILE") or default_token_file())
        self.timeout = timeout

    def _token(self) -> str:
        try:
            return self.token_file.read_text(encoding="utf-8").strip()
        except FileNotFoundError as e:
            raise EngineError(f"fant ikke nøkkelen til talemotoren ({self.token_file}). Start talemotoren én gang først") from e

    def _open(self, req: urllib.request.Request, timeout: float):
        try:
            return urllib.request.urlopen(req, timeout=timeout)  # noqa: S310 - bare lokal adresse
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = json.loads(e.read().decode("utf-8")).get("detail", "")
            except Exception:  # noqa: BLE001
                pass
            if e.code == 401:
                raise EngineError("talemotoren avviste nøkkelen. Start talemotoren på nytt og prøv igjen") from e
            raise EngineError(f"talemotoren svarte {e.code}: {detail or e.reason}") from e
        except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
            raise EngineError(f"talemotoren kjører ikke på {self.url}. Start scripts\\RUN_ENGINE.cmd i NorwegianSpeechBase") from e

    def health(self) -> dict:
        with self._open(urllib.request.Request(f"{self.url}/v1/health"), timeout=3) as r:
            return json.loads(r.read().decode("utf-8"))

    def transcribe(self, wav: bytes, hotwords: str | None = None) -> dict:
        """Hele opptaket; motoren dekoder bare tale (``vad=true``) og formaterer ikke teksten."""
        q = {"vad": "true", "format": "none"}
        if hotwords:
            q["hotwords"] = hotwords
        req = urllib.request.Request(
            f"{self.url}/v1/transcribe?{urllib.parse.urlencode(q)}", data=wav, method="POST",
            headers={"Authorization": f"Bearer {self._token()}", "Content-Type": "audio/wav", "X-NSB-User": "verity"},
        )
        with self._open(req, timeout=self.timeout) as r:
            return json.loads(r.read().decode("utf-8"))
