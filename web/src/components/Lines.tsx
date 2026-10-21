import { useState } from 'react';
import { api, type Revision, type Verification } from '../lib/api';
import { fmt, LOW_CONF, parts, range, type Hit } from '../lib/search';

interface Props {
  hit: Hit;
  lvl: number;
  rxs: RegExp[];
  onSeek?: (ms: number) => void;
  onSpeaker?: (idx: number, speaker: string) => void;
  onText?: (idx: number, text: string) => void;
  tagged?: boolean;
  small?: boolean;
}

interface History { idx: number; text_raw: string; speaker_raw: string; revisions: Revision[]; verifications: Verification[] }

const when = (ts: number) => new Date(ts * 1000).toLocaleString('nb-NO', { dateStyle: 'short', timeStyle: 'medium' });

/**
 * Tekstenhetene i et treff: målet, W (én før og én etter) og utvidelsene. Teksten vises slik
 * den står, med markering hvis den er rettet; originalen fra talemotoren kan alltid vises.
 */
export function Lines({ hit, lvl, rxs, onSeek, onSpeaker, onText, tagged, small }: Props) {
  const [editingSpk, setEditingSpk] = useState<number | null>(null);
  const [editingText, setEditingText] = useState<number | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [histErr, setHistErr] = useState('');
  const [a, b] = range(hit, lvl);

  const showHistory = async (idx: number) => {
    if (history?.idx === idx) { setHistory(null); return; }
    try {
      setHistErr('');
      setHistory({ idx, ...(await api.revisions(hit.rec.id, idx)) });
    } catch (e) { setHistErr((e as Error).message); }
  };

  const rows = [];
  for (let k = a; k <= b; k++) {
    const t = hit.rec.ttus[k];
    const isT = k === hit.idx;
    const added = Math.abs(k - hit.idx) > 1;
    const low = isT && t.conf < LOW_CONF;
    const tag = isT ? 'MÅL' : added ? '+' + (Math.abs(k - hit.idx) - 1) : 'W';
    const stop = (e: React.SyntheticEvent) => e.stopPropagation();
    rows.push(
      <div key={k}>
        <div
          className={'line' + (tagged ? ' tagged' : '') + (onSeek && editingText !== k ? '' : ' static')}
          style={{ background: isT ? 'rgba(255,255,255,0.05)' : added ? 'rgba(255,255,255,0.02)' : 'transparent' }}
          onClick={onSeek && editingText !== k ? (e) => { e.stopPropagation(); onSeek(t.start_ms); } : undefined}
        >
          {tagged && (
            <div className="mono" style={{ fontSize: 10, fontWeight: 500, lineHeight: '21px', color: isT ? '#00E5FF' : added ? '#FF8a5c' : '#8B949E' }}>{tag}</div>
          )}
          <div className="tc" style={{ color: isT ? '#00E5FF' : '#6f7a87', fontSize: small ? 11.5 : 12 }}>{fmt(t.start_ms)}</div>
          <div className="tx" style={{ color: isT ? '#E0E6ED' : '#8B949E', fontWeight: isT && !small ? 500 : 400, fontSize: small ? 13.5 : 14 }}>
            {onSpeaker && editingSpk === k ? (
              <input
                className="spk-input" autoFocus defaultValue={t.speaker} aria-label="Taler" onClick={stop}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { const v = e.currentTarget.value.trim(); if (v && v !== t.speaker) onSpeaker(k, v); setEditingSpk(null); }
                  if (e.key === 'Escape') setEditingSpk(null);
                }}
                onBlur={() => setEditingSpk(null)}
              />
            ) : onSpeaker ? (
              <button className="spk" title="Endre taler" onClick={(e) => { e.stopPropagation(); setEditingSpk(k); }}>{t.speaker}</button>
            ) : (
              <span className="spk">{t.speaker}</span>
            )}
            {onText && editingText === k ? (
              <textarea
                className="text-input" autoFocus defaultValue={t.text} aria-label="Rett tekst" onClick={stop}
                rows={Math.min(6, Math.ceil(t.text.length / 70) + 1)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    const v = e.currentTarget.value.trim();
                    if (v && v !== t.text) onText(k, v);
                    setEditingText(null);
                  }
                  if (e.key === 'Escape') setEditingText(null);
                }}
                onBlur={() => setEditingText(null)}
              />
            ) : (
              parts(t.text, rxs).map((p, i) => <span key={i} className={(p.hit ? 'mark' : '') + (low ? ' wavy' : '')}>{p.t}</span>)
            )}
            {t.verified && <span className="verified-mark" title="Verifisert mot lyd">✓</span>}
            {((t.revisions ?? 0) > 0 || t.verified) && (
              <button className="edited-tag" title="Vis original og rettinger" onClick={(e) => { e.stopPropagation(); showHistory(k); }}>
                {t.edited ? 'rettet' : (t.revisions ?? 0) > 0 ? 'endret' : 'historikk'}{(t.revisions ?? 0) > 0 ? ` · ${t.revisions}` : ''}
              </button>
            )}
            {onText && editingText !== k && (
              <button className="edit-btn" title="Rett teksten (originalen fra talemotoren beholdes)"
                onClick={(e) => { e.stopPropagation(); setEditingText(k); }} aria-label="Rett tekst">✎</button>
            )}
          </div>
        </div>
        {history?.idx === k && (
          <div className="history" onClick={stop} data-testid="history">
            <div><span className="label">Original fra talemotoren</span></div>
            <div style={{ color: '#E0E6ED' }}><span className="spk">{history.speaker_raw}</span>{history.text_raw}</div>
            {history.verifications.map((v, i) => (
              <div key={'v' + i} className="mono" style={{ fontSize: 11.5, color: '#00E5FF' }}>
                {when(v.ts)} · {v.actor} · verifisert etter avspilling av hele tekstenheten ({((v.detail.listened_ms ?? 0) / 1000).toFixed(1).replace('.', ',')} s avspilt{v.detail.slowest_rate && v.detail.slowest_rate < 1 ? ', delvis 0,75×' : ''})
              </div>
            ))}
            {history.revisions.map((r) => (
              <div key={r.audit_seq} className="mono" style={{ fontSize: 11.5 }}>
                <span style={{ color: '#8B949E' }}>{when(r.ts)} · {r.actor} · {r.field === 'text' ? 'tekst' : 'taler'}:</span>{' '}
                <span style={{ color: '#ff9266', textDecoration: 'line-through' }}>{r.old}</span> → <span style={{ color: '#00E5FF' }}>{r.new}</span>
              </div>
            ))}
          </div>
        )}
        {histErr && history == null && <div className="history" style={{ color: '#ff9266' }}>{histErr}</div>}
      </div>,
    );
  }
  return <>{rows}</>;
}
