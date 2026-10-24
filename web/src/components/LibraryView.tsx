import { useEffect, useRef, useState } from 'react';
import { api, type AuditStatus, type Health, type RecordingInfo } from '../lib/api';
import { fmt } from '../lib/search';

const STATUS: Record<RecordingInfo['status'], string> = {
  queued: 'I kø', transcribing: 'Transkriberer …', ready: 'Klar', failed: 'Feilet',
};

interface Props { recs: RecordingInfo[]; health: Health | null; onChanged: () => void; toast: (m: string) => void }

/** Bibliotek: importer opptak, se status, sett talere og tema. Ikke i designet; laget i samme stil. */
export function LibraryView({ recs, health, onChanged, toast }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [meta, setMeta] = useState({ name: '', theme: '', speaker: '', hotwords: '' });
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const pick = (f: File | undefined) => {
    if (!f) return;
    setFile(f);
    setMeta((m) => ({ ...m, name: m.name || f.name.replace(/\.[^.]+$/, '') }));
  };
  const upload = async () => {
    if (!file) return;
    setError('');
    setProgress(0);
    try {
      await api.upload(file, meta, setProgress);
      toast('Opptaket er lagt i kø for transkripsjon');
      setFile(null);
      setMeta({ name: '', theme: '', speaker: '', hotwords: '' });
      if (input.current) input.current.value = '';
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProgress(null);
    }
  };
  const eng = health?.engine;
  const [audit, setAudit] = useState<AuditStatus | null>(null);
  useEffect(() => { api.audit().then(setAudit).catch(() => setAudit(null)); }, [recs]);
  const field = (k: keyof typeof meta, label: string, ph: string) => (
    <label className="field"><span className="label">{label}</span>
      <input value={meta[k]} placeholder={ph} onChange={(e) => setMeta({ ...meta, [k]: e.target.value })} /></label>
  );

  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 1100 }}>
        <div className="glass engine" data-testid="engine-status">
          <span className="dot" style={{ background: eng?.ok ? '#00E5FF' : '#FF3D00', boxShadow: eng?.ok ? '0 0 10px rgba(0,229,255,0.7)' : 'none' }} />
          {health == null ? <span style={{ color: '#8B949E' }}>Sjekker talemotoren …</span>
            : eng?.ok ? <span>Talemotoren kjører <span className="mono" style={{ color: '#8B949E', fontSize: 12 }}>{eng.model} · {eng.device}</span></span>
              : <span><b>Talemotoren kjører ikke.</b> <span style={{ color: '#8B949E' }}>{eng?.error} Opptak kan legges inn nå og transkriberes når den er startet («Prøv igjen»).</span></span>}
        </div>
        {audit && (
          <div className="glass engine" data-testid="audit-status" style={audit.ok ? undefined : { borderColor: 'rgba(255,61,0,0.5)' }}>
            <span className="dot" style={{ background: audit.ok ? '#00E5FF' : '#FF3D00' }} />
            {audit.ok
              ? <span>Endringsloggen er hel <span className="mono" style={{ color: '#8B949E', fontSize: 12 }}>
                  {audit.entries} hendelser · siste HMAC <span title={audit.head}>{audit.head?.slice(0, 12)}…</span></span></span>
              : <span><b>Endringsloggen er brutt ved hendelse {audit.broken_at}.</b> <span style={{ color: '#8B949E' }}>
                  Noe i databasen er endret utenom Verity. Rettinger etter dette punktet kan ikke stoles på.</span></span>}
          </div>
        )}

        <section className="glass" style={{ overflow: 'hidden' }}>
          <div className="card-head"><span style={{ fontWeight: 600 }}>Importer opptak</span>
            <span style={{ color: '#8B949E', fontSize: 12 }}>Lyd eller video. Filen blir på denne maskinen; teksten lages av talemotoren lokalt.</span></div>
          <div className="card-body">
            <div
              className={'drop' + (over ? ' over' : '')}
              onClick={() => input.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files[0]); }}
            >
              {file ? <span style={{ color: '#E0E6ED' }}>{file.name} <span className="mono" style={{ color: '#8B949E' }}>{(file.size / 1e6).toFixed(1)} MB</span></span>
                : 'Slipp en fil her, eller klikk for å velge'}
              <input ref={input} type="file" accept="audio/*,video/*" hidden data-testid="file" onChange={(e) => pick(e.target.files?.[0])} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 12 }}>
              {field('name', 'Navn', 'Intervju 07 – Hjemmetjeneste')}
              {field('theme', 'Tema', 'Trygghetsalarm')}
              {field('speaker', 'Taler', 'Ukjent taler')}
              {field('hotwords', 'Navn og fagord', 'Silje, hjemmetjenesten')}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button className="btn-primary" disabled={!file || progress != null} onClick={upload}>Importer og transkriber</button>
              {progress != null && <div className="progress" style={{ width: 200 }}><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>}
              {error && <span style={{ color: '#ff9266', fontSize: 13 }}>{error}</span>}
            </div>
            <div style={{ color: '#8B949E', fontSize: 12, lineHeight: 1.5 }}>
              Talemotoren skiller ikke mellom talere ennå. Alle tekstenheter får taleren over; du kan endre taler per tekstenhet i søket, eller for hele opptaket under.
            </div>
          </div>
        </section>

        <section className="glass" style={{ overflow: 'hidden' }}>
          <div className="card-head"><span style={{ fontWeight: 600 }}>Opptak</span><span className="count">{recs.length}</span></div>
          <div className="card-body" style={{ gap: 0, padding: 0 }}>
            {recs.length === 0 && <div style={{ padding: 16, color: '#8B949E' }}>Ingen opptak ennå.</div>}
            {recs.map((r) => <RecRow key={r.id} r={r} engineModel={eng?.ok ? eng.model ?? '' : ''} onChanged={onChanged} toast={toast} />)}
          </div>
        </section>
      </div>
    </div>
  );
}

function RecRow({ r, engineModel, onChanged, toast }: { r: RecordingInfo; engineModel: string; onChanged: () => void; toast: (m: string) => void }) {
  // Teksten er laget med en annen modell enn den talemotoren kjører nå.
  const otherModel = r.status === 'ready' && !!r.model && !!engineModel && r.model !== engineModel;
  const [confirm, setConfirm] = useState(false);
  const [theme, setTheme] = useState(r.theme);
  useEffect(() => setTheme(r.theme), [r.theme]);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 4000);
    return () => clearTimeout(t);
  }, [confirm]);
  const act = (p: Promise<unknown>, msg: string) => p.then(() => { toast(msg); onChanged(); }).catch((e) => toast((e as Error).message));
  return (
    <div style={{ padding: '14px 16px', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="rec-row">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span className="kind">{r.kind.toUpperCase()}</span>
        <span style={{ fontWeight: 600 }}>{r.name}</span>
        <span className="mono" style={{ fontSize: 11.5, color: '#8B949E' }}>{r.file}{r.duration_ms ? ` · ${fmt(r.duration_ms).slice(0, 8)}` : ''}</span>
        <div style={{ flex: 1 }} />
        <span className={'status ' + r.status}>{STATUS[r.status]}{r.status === 'ready' ? ` · ${r.ttu_count} TTU · ${r.verified_count} verifisert` : ''}{r.revision_count ? ` · ${r.revision_count} ${r.revision_count === 1 ? 'retting' : 'rettinger'}` : ''}</span>
        {(r.status === 'failed' || r.status === 'ready') && (
          <button className="btn-outline" disabled={r.revision_count > 0}
            title={r.revision_count > 0 ? 'Opptaket har rettinger som ville gått tapt ved ny transkripsjon' : undefined}
            onClick={() => act(api.retry(r.id), 'Lagt i kø på nytt')}>{r.status === 'failed' ? 'Prøv igjen' : otherModel ? `Transkriber på nytt med ${engineModel}` : 'Transkriber på nytt'}</button>
        )}
        <button className="btn-outline" title="Regn ut SHA-256 på nytt og sammenlign med verdien fra importen"
          onClick={() => api.checkFile(r.id).then((c) => {
            toast(c.ok ? (c.first_check ? 'Sjekksum lagret (første kontroll)' : 'Fila er uendret siden import') : 'FILA ER ENDRET siden import');
            onChanged();
          }).catch((e) => toast((e as Error).message))}>Kontroller fil</button>
        {confirm
          ? <button className="btn-outline warn" style={{ borderColor: '#FF3D00', color: '#ff9266' }} onClick={() => act(api.remove(r.id), 'Opptaket er slettet')}>Bekreft sletting</button>
          : <button className="btn-outline warn" onClick={() => setConfirm(true)}>Slett</button>}
      </div>
      {r.error && <div style={{ color: '#ff9266', fontSize: 13 }}>{r.error}</div>}
      {otherModel && (
        <div style={{ color: '#ffb74d', fontSize: 12.5 }} data-testid="other-model">
          Teksten er laget med {r.model}; talemotoren kjører nå {engineModel}.
          {r.revision_count > 0 ? ' Opptaket har rettinger, så det transkriberes ikke på nytt automatisk.' : ' Transkriber på nytt for å bruke den.'}
        </div>
      )}
      {r.sha256 && <div className="mono" style={{ fontSize: 11, color: '#6f7a87', wordBreak: 'break-all' }}>SHA-256 {r.sha256}</div>}
      {r.status === 'ready' && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="field" style={{ width: 200 }}><span className="label">Tema</span>
            <input value={theme} onChange={(e) => setTheme(e.target.value)}
              onBlur={() => theme !== r.theme && act(api.edit(r.id, { theme }), 'Tema lagret')} /></label>
          {r.speakers.map((s) => (
            <label key={s} className="field" style={{ width: 170 }}><span className="label">Taler</span>
              <input defaultValue={s} onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== s) act(api.edit(r.id, { speakers: { [s]: v } }), `«${s}» heter nå «${v}»`);
              }} /></label>
          ))}
          <span style={{ color: '#6f7a87', fontSize: 12, paddingBottom: 8 }}>{r.model}{r.processing_seconds ? ` · ${r.processing_seconds} s` : ''}</span>
        </div>
      )}
    </div>
  );
}
