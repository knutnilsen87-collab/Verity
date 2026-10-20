import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { fmt, type Hit } from '../lib/search';

export interface Cue { hit: Hit; at: number; play: boolean; n: number }
interface Props { cue: Cue | null; ws: number; we: number }

const N = 90;

function grad(f: number) {
  const a = [41, 121, 255], b = [0, 229, 255];
  return 'rgb(' + a.map((v, i) => Math.round(v + (b[i] - v) * f)).join(',') + ')';
}

/** Kilden til treffet: ekte avspilling av opptaket, med ms-presisjon, innenfor vinduet rundt sitatet. */
export function Player({ cue, ws, we }: Props) {
  const media = useRef<HTMLMediaElement | null>(null);
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [bars, setBars] = useState<number[]>([]);
  const [err, setErr] = useState('');
  const rec = cue?.hit.rec;
  const t = cue ? cue.hit.rec.ttus[cue.hit.idx] : null;

  // Nytt treff eller nytt punkt: hopp dit, og spill hvis brukeren ba om det.
  useEffect(() => {
    if (!cue) return;
    setPos(cue.at);
    const m = media.current;
    if (!m) return;
    const go = () => {
      m.currentTime = cue.at / 1000;
      if (cue.play) m.play().catch(() => setPlaying(false));
      else m.pause();
    };
    if (m.readyState >= 1) go();
    else m.addEventListener('loadedmetadata', go, { once: true });
  }, [cue]);

  useEffect(() => {
    if (!rec) return;
    let live = true;
    api.peaks(rec.id, ws, we, N).then((b) => live && setBars(b)).catch(() => live && setBars([]));
    return () => { live = false; };
  }, [rec, ws, we]);

  // Posisjonen følger lyden ved hver skjermoppdatering; avspillingen stopper ved vinduets slutt.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const m = media.current;
      if (m) {
        const ms = m.currentTime * 1000;
        if (ms >= we) { m.pause(); m.currentTime = we / 1000; setPos(we); return; }
        setPos(ms);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, we]);

  if (!cue || !rec || !t) return <div style={{ color: '#8B949E', lineHeight: 1.5 }}>Velg et treff for å spille av kilden.</div>;

  const seek = (ms: number) => {
    const v = Math.max(ws, Math.min(we, ms));
    setPos(v);
    if (media.current) media.current.currentTime = v / 1000;
  };
  const toggle = () => {
    const m = media.current;
    if (!m) return;
    if (m.paused) {
      if (pos >= we) seek(ws);
      m.play().catch((e) => setErr(`kan ikke spille av: ${e.message}`));
    } else m.pause();
  };
  const span = we - ws;
  const cur = rec.ttus.find((x) => pos >= x.start_ms && pos <= x.end_ms);
  const events = {
    onPlay: () => { setPlaying(true); setErr(''); },
    onPause: () => setPlaying(false),
    onError: () => setErr('Opptaket kan ikke spilles av i nettleseren. Filformatet støttes kanskje ikke.'),
  };

  return (
    <>
      <div>
        <div className="label">Kilde</div>
        <div style={{ fontWeight: 600, fontSize: 16, marginTop: 2 }}>{rec.name}</div>
        <div className="mono" style={{ fontSize: 11.5, color: '#8B949E', marginTop: 2 }}>{rec.file}</div>
      </div>
      {rec.kind === 'video'
        ? <video key={rec.id} ref={(el) => { media.current = el; }} className="video" src={api.mediaUrl(rec.id)} preload="metadata" playsInline {...events} />
        : <audio key={rec.id} ref={(el) => { media.current = el; }} src={api.mediaUrl(rec.id)} preload="metadata" {...events} />}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div className="pos" data-testid="pos">{fmt(pos)}</div>
        <div style={{ fontSize: 11, color: '#8B949E' }}>ms-presisjon</div>
      </div>
      <div className="bars">
        {Array.from({ length: N }, (_, i) => {
          const tm = ws + ((i + 0.5) / N) * span;
          const inT = tm >= t.start_ms && tm <= t.end_ms;
          const played = tm <= pos;
          const h = bars.length ? Math.max(6, bars[i] ?? 0) : 6;
          return (
            <div key={i} onClick={() => seek(Math.round(tm))} style={{
              height: h + '%',
              background: played ? grad(i / N) : inT ? 'rgba(41,121,255,0.4)' : 'rgba(255,255,255,0.13)',
              boxShadow: played ? '0 0 8px rgba(0,229,255,0.3)' : 'none',
            }} />
          );
        })}
      </div>
      <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: '#8B949E' }}>
        <span>{fmt(ws)}</span><span style={{ color: '#8fb4ff' }}>sitat {fmt(t.start_ms).slice(3)}–{fmt(t.end_ms).slice(3)}</span><span>{fmt(we)}</span>
      </div>
      <div className="transport">
        <button className="step" onClick={() => seek(pos - 1000)}>−1 s</button>
        <button className="step small" onClick={() => seek(pos - 100)}>−100</button>
        <button className="play" onClick={toggle} aria-label={playing ? 'Pause' : 'Spill av'}>{playing ? '❚❚' : '▶'}</button>
        <button className="step small" onClick={() => seek(pos + 100)}>+100</button>
        <button className="step" onClick={() => seek(pos + 1000)}>+1 s</button>
      </div>
      <button className="link-btn" onClick={() => seek(t.start_ms)}>Hopp til sitatets start</button>
      {err && <div style={{ color: '#ff9266', fontSize: 12 }}>{err}</div>}
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 14 }}>
        <div className="label" style={{ marginBottom: 6 }}>Nå på opptaket</div>
        <div style={{ fontSize: 14, lineHeight: 1.5, minHeight: 60 }}>{cur ? `${cur.speaker}: ${cur.text}` : 'Pause mellom TTU.'}</div>
      </div>
    </>
  );
}
