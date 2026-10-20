"""Deler ordene fra talemotoren i tekstenheter (TTU).

En tekstenhet er det Verity søker i, viser og siterer: en ytring på noen få
sekunder med start- og sluttid. Grensene settes der det er pause i talen, ved
punktum når enheten er lang nok, og senest etter ``max_len`` sekunder.
Teksten endres aldri; ordene settes sammen slik modellen skrev dem.
"""

from __future__ import annotations

from collections.abc import Sequence

SENTENCE_END = (".", "?", "!", "…")


def join_words(words: Sequence[dict]) -> str:
    out: list[str] = []
    for i, w in enumerate(words):
        if i and not w.get("joined"):
            out.append(" ")
        out.append(w["text"])
    return "".join(out).strip()


def segment(words: Sequence[dict], *, max_gap: float = 0.8, min_len: float = 4.0, max_len: float = 20.0) -> list[dict]:
    """Ord (``text``, ``start``, ``end`` i sekunder, ``probability``, ``joined``) til tekstenheter.

    Gir ``start_ms``, ``end_ms``, ``text``, ``conf`` (snittet av ordenes
    sannsynlighet) og ``words``.
    """
    units: list[list[dict]] = []
    cur: list[dict] = []
    for w in words:
        if not str(w.get("text", "")).strip():
            continue
        if cur and not w.get("joined"):
            length = w["end"] - cur[0]["start"]
            gap = w["start"] - cur[-1]["end"]
            sentence_done = cur[-1]["text"].endswith(SENTENCE_END) and cur[-1]["end"] - cur[0]["start"] >= min_len
            if gap > max_gap or length > max_len or sentence_done:
                units.append(cur)
                cur = []
        cur.append(w)
    if cur:
        units.append(cur)
    out = []
    for u in units:
        probs = [float(w.get("probability", 0.0)) for w in u]
        out.append({
            "start_ms": int(round(u[0]["start"] * 1000)),
            "end_ms": int(round(u[-1]["end"] * 1000)),
            "text": join_words(u),
            "conf": round(sum(probs) / len(probs), 3),
            "words": [{"t": w["text"], "s": int(round(w["start"] * 1000)), "e": int(round(w["end"] * 1000)),
                       "p": round(float(w.get("probability", 0.0)), 3), "j": bool(w.get("joined"))} for w in u],
        })
    return out
