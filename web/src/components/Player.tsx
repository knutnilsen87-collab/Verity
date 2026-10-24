import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { fmt, type Hit } from '../lib/search';

/** Hvor avspillingen skal stå. ``mark`` er tiden til søkeordet man klikket på. */
export interface Cue { hit: Hit; at: number; play: boolean; n: number; mark?: number }
interface Occ { index: number; total: number; prev: () => void; next: () => void }
interface Props { cue: Cue | null; occ?: Occ | null }

const N = 160;
const BEFORE = 6000; // ms av bølgeformen før hoppepunktet
const AFTER = 24000;

function grad(f: number) {
  const a = [41, 121, 255], b = [0, 229, 255];
  return 'rgb(' + a.map((v, i) => Math.round(v + (b[i] - v) * f)).join(',') + ')';
}

/**
 * Scenen øverst: lyd- eller videosporet med bølgeform, ms-presisjon og
 * forekomstnavigasjon. Avspillingen fortsetter fritt fra hoppepunktet;
 * bølgeformen følger med når den går utenfor vinduet.
 */
export function Player({ cue, occ }: Props) {
  const media = useRef<HTMLMediaElement | null>(null);
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [bars, setBars] = useState<number[]>([]);
  const [win, setWin] = useState({ ws: 0, we: 0 });
  const [err, setErr] = useState('');
  const rec = cue?.hit.rec;
  const t = cue ? cue.hit.rec.ttus[cue.hit.idx] : null;
  const dur = rec?.duration_ms || Infinity;

  // Nytt opptak: nytt medieelement; det gamle kan ikke lenger rapportere pause.
  useEffect(() => { setPlaying(false); setErr(''); }, [rec?.id]);

  const frame = (ms: number) => setWin({ ws: Math.max(0, ms - BEFORE), we: Math.min(dur, Math.max(0, ms - BEFORE) + BEFORE + AFTER) });

  // Nytt hopp: dit, og spill hvis brukeren ba om det.
  useEffect(() => {
    if (!cue) return;
    setPos(cue.at);
    frame(cue.at);
    const m = media.current;
    if (!m) return;
    const go = () => {
      m.currentTime = cue.at / 1000;
      if (cue.play) m.play().catch(() => setPlaying(false));
      else m.pause();
    };
    if (m.readyState >= 1) go();
    else m.addEventListener('loadedmetadata', go, { once: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cue]);

  useEffect(() => {
    if (!rec || win.we <= win.ws) return;
    let live = true;
    api.peaks(rec.id, win.ws, win.we, N).then((b) => live && setBars(b)).catch(() => live && setBars([]));
    return () => { live = false; };
  }, [rec, win.ws, win.we]);

  // Posisjonen følger lyden ved hver skjermoppdatering.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const m = media.current;
      if (m) {
        const ms = m.currentTime * 1000;
        setPos(ms);
        setWin((w) => (ms > w.we - 1500 || ms < w.ws ? { ws: Math.max(0, ms - BEFORE), we: Math.min(dur, Math.max(0, ms - BEFORE) + BEFORE + AFTER) } : w));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, dur]);

  if (!cue || !rec || !t) {
    return (
      <div className="stage-empty">
        <div style={{ fontWeight: 600, fontSize: 15 }}>Ingen kilde valgt</div>
        <div style={{ color: '#8B949E' }}>Søk, og klikk på et markert søkeord for å hoppe rett til stedet i opptaket.</div>
      </div>
    );
  }

  const seek = (ms: number) => {
    const v = Math.max(0, Math.min(dur, ms));
    setPos(v);
    if (v < win.ws || v > win.we) frame(v);
    if (media.current) media.current.currentTime = v / 1000;
  };
  const toggle = () => {
    const m = media.current;
    if (!m) return;
    if (m.paused) m.play().catch((e) => setErr(`kan ikke spille av: ${e.message}`));
    else m.pause();
  };
  const span = Math.max(1, win.we - win.ws);
  const cur = rec.ttus.find((x) => pos >= x.start_ms && pos <= x.end_ms);
  const pct = (ms: number) => `${((ms - win.ws) / span) * 100}%`;
  const events = {
    onPlay: () => { setPlaying(true); setErr(''); },
    onPause: () => setPlaying(false),
    onError: () => setErr('Opptaket kan ikke spilles av i nettleseren. Filformatet støttes kanskje ikke.'),
  };

  return (
    <div className="stage-inner">
      <div className="stage-head">
        <div style={{ minWidth: 0 }}>
          <div className="label">Kilde</div>
          <div style={{ fontWeight: 600, fontSize: 16, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{rec.name}</div>
          <div className="mono" style={{ fontSize: 11.5, color: '#8B949E' }}>{rec.file}</div>
        </div>
        <div className="pos" data-testid="pos">{fmt(pos)}</div>
        <div className="occ" data-testid="occ">
          {occ && occ.total > 0 ? (
            <>
              <button className="occ-btn" onClick={occ.prev} aria-label="Forrige forekomst" title="Forrige forekomst [K]">‹</button>
              <span className="mono">Forekomst <b>{occ.index + 1}</b> av {occ.total}</span>
              <button className="occ-btn" onClick={occ.next} aria-label="Neste forekomst" title="Neste forekomst [J]">›</button>
            </>
          ) : <span style={{ color: '#6f7a87', fontSize: 12 }}>ms-presisjon</span>}
        </div>
      </div>

      <div className={rec.kind === 'video' ? 'stage-body with-video' : 'stage-body'}>
        {rec.kind === 'video' && (
          <video key={rec.id} ref={(el) => { media.current = el; }} className="stage-video" src={api.mediaUrl(rec.id)} preload="metadata" playsInline
            onClick={toggle} {...events} />
        )}
        {rec.kind !== 'video' && <audio key={rec.id} ref={(el) => { media.current = el; }} src={api.mediaUrl(rec.id)} preload="metadata" {...events} />}
        <div className="stage-track">
          <div className="bars stage-bars">
            {Array.from({ length: N }, (_, i) => {
              const tm = win.ws + ((i + 0.5) / N) * span;
              const inT = tm >= t.start_ms && tm <= t.end_ms;
              const played = tm <= pos;
              const h = bars.length ? Math.max(6, bars[i] ?? 0) : 6;
              return (
                <div key={i} onClick={() => seek(Math.round(tm))} style={{
                  height: h + '%',
                  background: played ? grad((tm - win.ws) / span) : inT ? 'rgba(41,121,255,0.4)' : 'rgba(255,255,255,0.13)',
                  boxShadow: played ? '0 0 8px rgba(0,229,255,0.3)' : 'none',
                }} />
              );
            })}
            {cue.mark != null && cue.mark >= win.ws && cue.mark <= win.we && (
              <span className="mark-line" style={{ left: pct(cue.mark) }} title={`Søkeordet: ${fmt(cue.mark)}`} />
            )}
          </div>
          <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: '#8B949E' }}>
            <span>{fmt(win.ws)}</span><span style={{ color: '#8fb4ff' }}>treff {fmt(t.start_ms).slice(3)}–{fmt(t.end_ms).slice(3)}</span><span>{fmt(win.we)}</span>
          </div>
          <div className="stage-controls">
            <div className="transport">
              <button className="step" onClick={() => seek(pos - 1000)}>−1 s</button>
              <button className="step small" onClick={() => seek(pos - 100)}>−100</button>
              <button className="play" onClick={toggle} aria-label={playing ? 'Pause' : 'Spill av'}>{playing ? '❚❚' : '▶'}</button>
              <button className="step small" onClick={() => seek(pos + 100)}>+100</button>
              <button className="step" onClick={() => seek(pos + 1000)}>+1 s</button>
            </div>
            <button className="link-btn" onClick={() => seek(cue.mark != null ? Math.max(0, cue.mark - 250) : t.start_ms)}>
              {cue.mark != null ? '↺ Tilbake til søkeordet' : '↺ Til treffets start'}
            </button>
          </div>
          <div className="caption">{cur ? <><span className="spk">{cur.speaker}</span>{cur.text}</> : <span style={{ color: '#6f7a87' }}>Pause mellom tekstenheter.</span>}</div>
        </div>
      </div>
      {err && <div style={{ color: '#ff9266', fontSize: 12 }}>{err}</div>}
    </div>
  );
}
