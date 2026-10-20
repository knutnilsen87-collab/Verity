import { useState } from 'react';
import { fmt, LOW_CONF, parts, range, type Hit } from '../lib/search';

interface Props {
  hit: Hit;
  lvl: number;
  rxs: RegExp[];
  onSeek?: (ms: number) => void;
  onSpeaker?: (idx: number, speaker: string) => void;
  tagged?: boolean;
  small?: boolean;
}

/** Tekstenhetene i et treff: målet, W (én før og én etter) og utvidelsene. Teksten vises uendret. */
export function Lines({ hit, lvl, rxs, onSeek, onSpeaker, tagged, small }: Props) {
  const [editing, setEditing] = useState<number | null>(null);
  const [a, b] = range(hit, lvl);
  const rows = [];
  for (let k = a; k <= b; k++) {
    const t = hit.rec.ttus[k];
    const isT = k === hit.idx;
    const added = Math.abs(k - hit.idx) > 1;
    const low = isT && t.conf < LOW_CONF;
    const tag = isT ? 'MÅL' : added ? '+' + (Math.abs(k - hit.idx) - 1) : 'W';
    rows.push(
      <div
        key={k}
        className={'line' + (tagged ? ' tagged' : '') + (onSeek ? '' : ' static')}
        style={{ background: isT ? 'rgba(255,255,255,0.05)' : added ? 'rgba(255,255,255,0.02)' : 'transparent' }}
        onClick={onSeek ? (e) => { e.stopPropagation(); onSeek(t.start_ms); } : undefined}
      >
        {tagged && (
          <div className="mono" style={{ fontSize: 10, fontWeight: 500, lineHeight: '21px', color: isT ? '#00E5FF' : added ? '#FF8a5c' : '#8B949E' }}>{tag}</div>
        )}
        <div className="tc" style={{ color: isT ? '#00E5FF' : '#6f7a87', fontSize: small ? 11.5 : 12 }}>{fmt(t.start_ms)}</div>
        <div className="tx" style={{ color: isT ? '#E0E6ED' : '#8B949E', fontWeight: isT && !small ? 500 : 400, fontSize: small ? 13.5 : 14 }}>
          {onSpeaker && editing === k ? (
            <input
              className="spk-input"
              autoFocus
              defaultValue={t.speaker}
              aria-label="Taler"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { const v = e.currentTarget.value.trim(); if (v && v !== t.speaker) onSpeaker(k, v); setEditing(null); }
                if (e.key === 'Escape') setEditing(null);
              }}
              onBlur={() => setEditing(null)}
            />
          ) : onSpeaker ? (
            <button className="spk" title="Endre taler" onClick={(e) => { e.stopPropagation(); setEditing(k); }}>{t.speaker}</button>
          ) : (
            <span className="spk">{t.speaker}</span>
          )}
          {parts(t.text, rxs).map((p, i) => (
            <span key={i} className={(p.hit ? 'mark' : '') + (low ? ' wavy' : '')}>{p.t}</span>
          ))}
        </div>
      </div>,
    );
  }
  return <>{rows}</>;
}
