import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLoopPlayer } from '../hooks/useLoopPlayer';
import { api } from '../lib/api';
import { Coverage, LOOP, loopBounds, weakestWord, type LoopScope, type Word } from '../lib/loop';
import { fmt, type Hit, type Ttu } from '../lib/search';

interface Props {
  queue: Hit[];
  onVerified: (hit: Hit, ttu: Ttu) => void;
  onClose: (done: number) => void;
}

/**
 * Verifiseringskø. Hele tekstenheten spilles av først; «Godkjenn» blir først
 * mulig når hele utsnittet faktisk er spilt av (sammenhengende, ikke spolet).
 * Usikre ord kan lyttes til i en egen løkke. Teksten kan rettes før godkjenning;
 * rettingen lagres som revisjon. Verity kan ikke vite om noen lyttet, bare at lyden ble spilt av.
 *
 * Taster (velges for ikke å kollidere med Windows eller skriving): F2 spill på nytt,
 * F4 ord eller hel tekstenhet, F8 0,75×, F9 hopp over, Ctrl+Enter godkjenn, Esc lukk.
 * (Ikke Alt+Space, som åpner vindusmenyen i Windows, eller Ctrl+Alt+piltast, som kan snu skjermen.)
 */
export function VerifyQueue({ queue, onVerified, onClose }: Props) {
  const [pos, setPos] = useState(0);
  const [done, setDone] = useState(0);
  const [words, setWords] = useState<Word[]>([]);
  const [text, setText] = useState('');
  const [scope, setScope] = useState<LoopScope>('ttu');
  const [word, setWord] = useState<Word | null>(null);
  const [covered, setCovered] = useState(0);
  const [slowest, setSlowest] = useState(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const coverage = useRef<Coverage | null>(null);
  const listened = useRef(0);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const hit = queue[pos];
  const ttu = hit ? hit.rec.ttus[hit.idx] : null;
  const src = hit ? api.mediaUrl(hit.rec.id) : null;

  const onFrame = useCallback((a: number, b: number) => {
    const c = coverage.current;
    if (!c) return;
    c.add(a, b);
    if (b > a && b - a < 400) listened.current += b - a;
    setCovered(c.fraction);
  }, []);
  const player = useLoopPlayer(src, onFrame);
  const { play, stop } = player;
  const duration = hit?.rec.duration_ms || player.duration;

  // Ny tekstenhet: hent ordene, nullstill og spill hele tekstenheten.
  useEffect(() => {
    if (!hit || !ttu) return;
    let live = true;
    setErr('');
    setText(ttu.text);
    setScope('ttu');
    setWord(null);
    setCovered(0);
    setSlowest(1);
    listened.current = 0;
    coverage.current = new Coverage(ttu.start_ms, ttu.end_ms);
    api.ttu(hit.rec.id, hit.idx).then((t) => { if (live) setWords(t.words ?? []); }).catch(() => live && setWords([]));
    play(loopBounds('ttu', ttu, null, duration));
    setTimeout(() => textRef.current?.focus(), 30);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos]);

  useEffect(() => { if (player.rate < slowest) setSlowest(player.rate); }, [player.rate, slowest]);
  useEffect(() => () => stop(), [stop]);

  const weakest = useMemo(() => weakestWord(words), [words]);
  const complete = coverage.current?.complete ?? false;

  const loopWord = (w: Word | null) => {
    if (!ttu) return;
    const next: LoopScope = w ? 'word' : 'ttu';
    setScope(next);
    setWord(w);
    play(loopBounds(next, ttu, w, duration));
  };
  const toggleScope = () => loopWord(scope === 'ttu' ? (word ?? weakest ?? words[0] ?? null) : null);
  const restart = () => ttu && play(loopBounds(scope, ttu, word, duration));
  const next = () => {
    stop();
    if (pos + 1 < queue.length) setPos(pos + 1);
    else onClose(done);
  };
  const approve = async () => {
    if (!hit || !ttu || !complete || busy) return;
    setBusy(true);
    try {
      const t = await api.verify(hit.rec.id, hit.idx, {
        text, full_playback: true, loops: player.loops, slowest_rate: slowest, listened_ms: Math.round(listened.current),
      });
      onVerified(hit, t);
      setDone((d) => d + 1);
      next();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); stop(); onClose(done); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); approve(); }
    else if (e.key === 'F9') { e.preventDefault(); next(); }
    else if (e.key === 'F2') { e.preventDefault(); restart(); }
    else if (e.key === 'F4') { e.preventDefault(); toggleScope(); }
    else if (e.key === 'F8') { e.preventDefault(); player.toggleRate(); }
  };

  if (!hit || !ttu) return null;
  const b = loopBounds(scope, ttu, word, duration);
  const span = Math.max(1, b.end - b.start);
  const pct = (ms: number) => `${Math.max(0, Math.min(100, ((ms - b.start) / span) * 100))}%`;
  const zone = scope === 'word' && word ? [word.s, word.e] : [ttu.start_ms, ttu.end_ms];

  return (
    <div className="vq-backdrop" onKeyDown={onKey} role="dialog" aria-modal="true" aria-label="Verifisering mot lyd">
      <div className="vq glass">
        <div className="vq-head mono">
          <span>VERIFISERING · {hit.rec.name} · {ttu.speaker} · {fmt(ttu.start_ms)}–{fmt(ttu.end_ms)}</span>
          <span>{pos + 1} AV {queue.length}</span>
        </div>

        <div className="vq-player">
          <div className="vq-row mono">
            <span style={{ color: '#00E5FF' }}>
              <span className={'vq-dot' + (player.playing ? ' on' : '')} />
              {scope === 'word' && word ? `ORD «${word.t}» (−${LOOP.wordPreroll}/+${LOOP.wordPostroll} ms)` : 'HELE TEKSTENHETEN'} · {fmt(player.posMs)}
            </span>
            <span style={{ display: 'flex', gap: 8 }}>
              <button className="vq-pill" onClick={restart}>Spill på nytt [F2]</button>
              <button className="vq-pill" onClick={toggleScope}>{scope === 'ttu' ? 'Lytt til ord' : 'Hele tekstenheten'} [F4]</button>
              <button className={'vq-pill' + (player.rate < 1 ? ' slow' : '')} onClick={player.toggleRate}>{player.rate === 1 ? '1×' : '0,75×'} [F8]</button>
            </span>
          </div>
          <div className="vq-track">
            <div className="vq-zone" style={{ left: pct(zone[0]), width: `calc(${pct(zone[1])} - ${pct(zone[0])})` }} />
            <div className="vq-head-line" style={{ left: pct(player.posMs) }} />
          </div>
          <div className="vq-row mono" style={{ marginTop: 8, fontSize: 11 }}>
            <span style={{ color: complete ? '#00E5FF' : '#8B949E' }} data-testid="coverage">
              {complete ? '✓ Hele tekstenheten er spilt av' : `Spilt av ${Math.round(covered * 100)} % av tekstenheten`}
              {player.loops > 0 ? ` · ${player.loops} runder` : ''}
            </span>
            {player.error && <span style={{ color: '#ff9266' }}>{player.error}</span>}
          </div>
        </div>

        <div className="vq-words" aria-label="Ord">
          {words.length === 0 && <span style={{ color: '#6f7a87' }}>Ingen ordtider for denne tekstenheten.</span>}
          {words.map((w, i) => (
            <button key={i} className={'vq-word' + (w.p < LOOP.uncertainWord ? ' weak' : '') + (word === w ? ' sel' : '')}
              title={`${Math.round(w.p * 100)} % · ${fmt(w.s)}`} onClick={() => loopWord(w)}>{w.t}</button>
          ))}
        </div>

        <textarea ref={textRef} className="vq-text" value={text} onChange={(e) => setText(e.target.value)} aria-label="Tekst som godkjennes"
          rows={Math.min(6, Math.ceil(text.length / 80) + 1)} />

        <div className="vq-row" style={{ marginTop: 14 }}>
          <span className="mono" style={{ fontSize: 11, color: '#8B949E' }}>
            {text.trim() !== ttu.text ? 'Teksten er endret; rettingen lagres som revisjon.' : 'Talemotorens tekst.'}
            {err && <span style={{ color: '#ff9266' }}> {err}</span>}
          </span>
          <span style={{ display: 'flex', gap: 8 }}>
            <button className="btn-outline" onClick={() => { stop(); onClose(done); }}>Lukk [Esc]</button>
            <button className="btn-outline" onClick={next}>Hopp over [F9]</button>
            <button className="btn-primary" disabled={!complete || busy || !text.trim()} onClick={approve}
              title={complete ? undefined : 'Hele tekstenheten må spilles av før den kan godkjennes'}>
              ✓ Godkjenn [Ctrl+Enter]
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
