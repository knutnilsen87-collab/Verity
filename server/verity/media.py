"""Lyd fra opptaket: dekoding til 16 kHz mono, bølgeform og WAV til talemotoren."""

from __future__ import annotations

import io
import wave
from pathlib import Path

import numpy as np

SAMPLE_RATE = 16000
PEAKS_PER_SECOND = 50
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}


def kind_of(filename: str, content_type: str = "") -> str:
    if content_type.startswith("video/") or Path(filename).suffix.lower() in VIDEO_EXT:
        return "video"
    return "lyd"


def decode(path: Path) -> np.ndarray:
    """Hele lydsporet som int16, 16 kHz mono (PyAV leser både lyd- og videofiler)."""
    import av

    chunks = []
    with av.open(str(path)) as container:
        if not container.streams.audio:
            raise ValueError("filen har ikke noe lydspor")
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):
            chunks.append(out.to_ndarray().reshape(-1))
    if not chunks:
        raise ValueError("fant ingen lyd i filen")
    return np.concatenate(chunks).astype(np.int16)


def wav_bytes(pcm: np.ndarray) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm.astype("<i2").tobytes())
    return buf.getvalue()


def peaks(pcm: np.ndarray, per_second: int = PEAKS_PER_SECOND) -> bytes:
    """Største utslag per bit (50 per sekund) som 0–255, med kvadratrot så stille tale synes."""
    step = SAMPLE_RATE // per_second
    n = len(pcm) // step
    if n == 0:
        return b""
    a = np.abs(pcm[: n * step].astype(np.float32)).reshape(n, step).max(axis=1) / 32768.0
    return (np.sqrt(np.clip(a, 0, 1)) * 255).astype(np.uint8).tobytes()


def window(peak_data: bytes, from_ms: int, to_ms: int, n: int, per_second: int = PEAKS_PER_SECOND) -> list[int]:
    """``n`` søyler (0–100) for tidsrommet, fra lagrede utslag."""
    arr = np.frombuffer(peak_data, dtype=np.uint8)
    if not len(arr) or n <= 0 or to_ms <= from_ms:
        return [0] * max(n, 0)
    edges = np.linspace(from_ms, to_ms, n + 1) * per_second / 1000.0
    out = []
    for a, b in zip(edges[:-1], edges[1:], strict=True):
        lo, hi = int(a), max(int(a) + 1, int(np.ceil(b)))
        part = arr[min(lo, len(arr)): min(hi, len(arr))]
        out.append(int(round(part.max() / 255 * 100)) if len(part) else 0)
    return out
