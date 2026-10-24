import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type RecordingInfo } from '../lib/api';

const MEDIA_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|oga|opus|wma|mp4|m4v|mov|mkv|webm|avi|3gp)$/i;

export function isMedia(f: File) {
  return f.type.startsWith('audio/') || f.type.startsWith('video/') || MEDIA_EXT.test(f.name);
}

interface Upload { key: number; name: string; progress: number; recId?: string; error?: string; doneAt?: number }

const STATUS: Record<RecordingInfo['status'], string> = { queued: 'I kø', transcribing: 'Transkriberer …', ready: 'Klar', failed: 'Feilet' };

/**
 * Dra og slipp lyd- og videofiler hvor som helst i Verity. Filene lastes opp
 * med en gang (navn fra filnavnet), og en liten liste nede i hjørnet viser
 * opplasting og transkripsjon. Navn, tema og taler kan endres i Biblioteket etterpå.
 */
export function DropImport({ recs, onChanged, toast, onOpen }: {
  recs: RecordingInfo[]; onChanged: () => void; toast: (m: string) => void; onOpen: () => void;
}) {
  const [over, setOver] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const depth = useRef(0);
  const nextKey = useRef(1);

  const start = useCallback((files: File[]) => {
    const media = files.filter(isMedia);
    const skipped = files.length - media.length;
    if (skipped) toast(`${skipped} ${skipped === 1 ? 'fil er' : 'filer er'} ikke lyd eller video og ble hoppet over`);
    for (const f of media) {
      const key = nextKey.current++;
      setUploads((u) => [...u, { key, name: f.name, progress: 0 }]);
      const set = (patch: Partial<Upload>) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...patch } : x)));
      api.upload(f, { name: f.name.replace(/\.[^.]+$/, ''), theme: '', speaker: '', hotwords: '' }, (p) => set({ progress: p }))
        .then((rec) => { set({ progress: 1, recId: rec.id }); onChanged(); })
        .catch((e) => set({ error: (e as Error).message }));
    }
  }, [onChanged, toast]);

  // Hele vinduet tar imot filer. Telleren holder styr på inn/ut over barn-elementer.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); depth.current++; setOver(true); };
    const overFn = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; };
    const leave = (e: DragEvent) => { if (!hasFiles(e)) return; depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false); };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = 0;
      setOver(false);
      // Importskjemaet i Biblioteket har sitt eget slippfelt (med navn, tema og taler).
      if ((e.target as Element | null)?.closest?.('[data-own-drop]')) return;
      e.preventDefault();
      start(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', overFn);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop, true);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', overFn);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop, true);
    };
  }, [start]);

  // Ferdige opptak forsvinner fra lista etter en stund.
  useEffect(() => {
    const now = Date.now();
    setUploads((u) => u.map((x) => {
      const r = x.recId ? recs.find((y) => y.id === x.recId) : undefined;
      return r && (r.status === 'ready' || r.status === 'failed') && !x.doneAt ? { ...x, doneAt: now } : x;
    }));
  }, [recs]);
  useEffect(() => {
    const t = window.setInterval(() => setUploads((u) => u.filter((x) => !x.doneAt || Date.now() - x.doneAt < 15000)), 2000);
    return () => window.clearInterval(t);
  }, []);

  return (
    <>
      {over && (
        <div className="drop-overlay" data-testid="drop-overlay">
          <div className="drop-card">
            <div style={{ fontSize: 34, lineHeight: 1 }}>⤓</div>
            <div style={{ fontWeight: 600, fontSize: 18 }}>Slipp for å importere</div>
            <div style={{ color: '#8B949E' }}>Lyd og video. Filene blir på denne maskinen og transkriberes av talemotoren.</div>
          </div>
        </div>
      )}
      {uploads.length > 0 && (
        <div className="upload-tray glass" data-testid="upload-tray">
          <div className="upload-head">
            <span className="label">Import</span>
            <button className="link-btn" style={{ padding: 0 }} onClick={onOpen}>Bibliotek</button>
            <button className="chip-x" title="Skjul" onClick={() => setUploads([])}>×</button>
          </div>
          {uploads.map((u) => {
            const r = u.recId ? recs.find((x) => x.id === u.recId) : undefined;
            const state = u.error ? `Feilet: ${u.error}` : r ? STATUS[r.status] + (r.status === 'failed' && r.error ? `: ${r.error}` : '') : u.progress < 1 ? `Laster opp ${Math.round(u.progress * 100)} %` : 'I kø';
            const bad = !!u.error || r?.status === 'failed';
            return (
              <div key={u.key} className="upload-row">
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={u.name}>{u.name}</span>
                  <span className="mono" style={{ fontSize: 11, color: bad ? '#ff9266' : r?.status === 'ready' ? '#00E5FF' : '#8B949E', whiteSpace: 'nowrap' }}>{state}</span>
                </div>
                {!u.error && u.progress < 1 && <div className="progress"><div style={{ width: `${Math.round(u.progress * 100)}%` }} /></div>}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
