import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChipView } from './components/ChipView';
import { DropImport } from './components/DropImport';
import { LibraryView } from './components/LibraryView';
import { Lines } from './components/Lines';
import { Player, type Cue } from './components/Player';
import { StatesView } from './components/StatesView';
import { VerifyQueue } from './components/VerifyQueue';
import { api, type Health, type RecordingInfo } from './lib/api';
import {
  fmt, LOW_CONF, matchTimes, occurrences, parse, parseLink, quote, range, removalOptions, rx, search, speakersOf,
  type Chip, type ChipType, type Hit, type Recording, type TimedWord,
} from './lib/search';

type Tab = 'sok' | 'til' | 'bib';
type TtuT = Recording['ttus'][number];
const TAB_NAME: Record<Tab, string> = { sok: 'Søk', til: 'Tilstander', bib: 'Bibliotek' };
const NEXT_TYPE: Record<ChipType, ChipType> = { lex: 'person', person: 'tema', tema: 'lex' };
const HIST_KEY = 'verity.history';

interface HistItem { label: string; chips: Chip[] }

function loadHistory(): HistItem[] {
  try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch { return []; }
}
function saveHistory(h: HistItem[]) {
  try { localStorage.setItem(HIST_KEY, JSON.stringify(h)); } catch { /* privat vindu */ }
}
const sec = (ms: number) => (ms / 1000).toFixed(1).replace('.', ',') + ' s';

const Icon = {
  search: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></svg>,
  states: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="16" height="6" rx="1.5" /><rect x="4" y="14" width="16" height="6" rx="1.5" /></svg>,
  library: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15V4" /><path d="M7.5 8.5L12 4l4.5 4.5" /><path d="M4 15v3.5A1.5 1.5 0 005.5 20h13a1.5 1.5 0 001.5-1.5V15" /></svg>,
};

export default function App() {
  const [tab, setTab] = useState<Tab>('sok');
  const [lib, setLib] = useState<Recording[]>([]);
  const [recs, setRecs] = useState<RecordingInfo[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [loadError, setLoadError] = useState('');
  const [open, setOpen] = useState({ rec: true, spk: false, hist: true });
  const [text, setText] = useState('');
  const [chips, setChips] = useState<Chip[]>([]);
  const [run, setRun] = useState<Chip[]>([]);
  const [busy, setBusy] = useState(false);
  const [tti, setTti] = useState<number | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [cue, setCue] = useState<Cue | null>(null);
  const [expand, setExpand] = useState<Record<string, number>>({});
  const [recOff, setRecOff] = useState<Record<string, boolean>>({});
  const [spkOff, setSpkOff] = useState<Record<string, boolean>>({});
  const [hist, setHist] = useState<HistItem[]>(loadHistory);
  const [stats, setStats] = useState({ searches: 0, expanded: 0, thisExpanded: false });
  const [toastMsg, setToastMsg] = useState('');
  const [vq, setVq] = useState<Hit[] | null>(null);
  // Søkeordet man sist hoppet til: treff, tekstenhet og hvilket markert ord i den.
  const [curWord, setCurWord] = useState<{ hitId: string; idx: number; k: number } | null>(null);
  const wordCache = useRef(new Map<string, TimedWord[]>());
  const idRef = useRef(1000);
  const toastTimer = useRef<number>();
  const pendingLink = useRef(parseLink(window.location.hash));
  const nextId = () => idRef.current++;

  const toast = useCallback((m: string) => {
    setToastMsg(m);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(''), 2200);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [l, r] = await Promise.all([api.library(), api.recordings()]);
      setLib(l);
      setRecs(r);
      setLoadError('');
    } catch (e) {
      setLoadError(`Verity-tjenesten svarer ikke (${(e as Error).message}).`);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  // Status for import og talemotor: oftere mens noe transkriberes.
  const working = recs.some((r) => r.status === 'queued' || r.status === 'transcribing');
  useEffect(() => {
    const t = window.setInterval(refresh, working ? 2000 : 15000);
    return () => window.clearInterval(t);
  }, [refresh, working]);
  useEffect(() => {
    const check = () => api.health().then(setHealth).catch(() => setHealth({ version: '', engine: { ok: false, error: 'Verity-tjenesten svarer ikke.' } }));
    check();
    const t = window.setInterval(check, 10000);
    return () => window.clearInterval(t);
  }, []);

  const select = useCallback((h: Hit, play: boolean, at?: number, mark?: number) => {
    setActive(h.id);
    if (mark == null) setCurWord(null);
    setCue((c) => ({ hit: h, at: at ?? h.rec.ttus[h.idx].start_ms, play, n: (c?.n ?? 0) + 1, mark }));
  }, []);

  /**
   * Hopper til det eksakte stedet et markert søkeord blir sagt. Ordtidene hentes fra
   * talemotorens resultat; 250 ms før ordet, så starten ikke kuttes. Er teksten rettet
   * slik at ordet ikke finnes i ordene fra motoren, hoppes det til tekstenhetens start.
   */
  const jumpToWord = useCallback(async (h: Hit, idx: number, k: number, play: boolean, regexes: RegExp[]) => {
    const key = `${h.rec.id}-${idx}`;
    let words = wordCache.current.get(key);
    if (!words) {
      try {
        words = (await api.ttu(h.rec.id, idx)).words ?? [];
        wordCache.current.set(key, words);
      } catch { words = []; }
    }
    const times = matchTimes(words, regexes);
    const ttu = h.rec.ttus[idx];
    const mark = times[k] ?? ttu.start_ms;
    select(h, play, Math.max(0, mark - 250), mark);
    setCurWord({ hitId: h.id, idx, k });
    document.querySelector(`[data-hit="${h.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [select]);

  // Kildelenke (#/opptak/r…?start=…): åpne opptaket på riktig sted.
  useEffect(() => {
    const link = pendingLink.current;
    if (!link || !lib.length) return;
    pendingLink.current = null;
    const rec = lib.find((r) => r.id === link.rec);
    const idx = rec?.ttus.findIndex((t) => t.start_ms === link.start) ?? -1;
    if (rec && idx >= 0) select({ id: `${rec.id}-${idx}`, rec, idx }, false);
    else toast('Fant ikke stedet kildelenken peker på');
  }, [lib, select, toast]);

  const visible = useCallback((hits: Hit[]) => hits.filter((h) => !recOff[h.rec.id] && !spkOff[h.rec.ttus[h.idx].speaker]), [recOff, spkOff]);

  const exec = (c: Chip[]) => {
    const t0 = performance.now();
    const approved = c.map((x) => ({ ...x, ok: true }));
    setBusy(true);
    setChips(approved);
    setText('');
    setTab('sok');
    // Søket er lokalt; tiden måles fra «Kjør søk» til treffene er klare.
    window.setTimeout(() => {
      const found = visible(search(lib, approved));
      const first = found[0];
      setRun(approved);
      setExpand({});
      setBusy(false);
      setTti(performance.now() - t0);
      setStats((s) => ({ searches: s.searches + 1, expanded: s.expanded, thisExpanded: false }));
      const firstRxs = approved.filter((x) => x.type === 'lex').map((x) => rx(x.val));
      if (first && firstRxs.length) jumpToWord(first, first.idx, 0, false, firstRxs);
      else if (first) select(first, false);
      else { setActive(null); setCue(null); setCurWord(null); }
      const label = approved.map((x) => x.val).join(' · ');
      setHist((h) => { const nh = [{ label, chips: approved }, ...h.filter((x) => x.label !== label)].slice(0, 6); saveHistory(nh); return nh; });
    }, 0);
  };

  const parseNow = () => {
    const add = parse(text, chips, lib, speakersOf(lib), nextId);
    if (add.length) { setChips((c) => c.concat(add)); setText(''); }
  };

  const bump = (id: string) => {
    setExpand((e) => ({ ...e, [id]: Math.min(3, (e[id] || 0) + 1) }));
    setStats((s) => (s.thisExpanded ? s : { ...s, expanded: s.expanded + 1, thisExpanded: true }));
  };

  const changeSpeaker = async (h: Hit, idx: number, speaker: string) => {
    try {
      await api.setSpeaker(h.rec.id, idx, speaker);
      setLib((l) => l.map((r) => (r.id !== h.rec.id ? r : {
        ...r, ttus: r.ttus.map((t, i) => (i === idx ? { ...t, speaker, revisions: (t.revisions ?? 0) + 1 } : t)),
      })));
      toast(`Taler endret til «${speaker}»`);
      api.recordings().then(setRecs).catch(() => undefined);
    } catch (e) { toast((e as Error).message); }
  };

  const changeText = async (h: Hit, idx: number, text: string) => {
    try {
      const r = await api.setText(h.rec.id, idx, text);
      if (r.changed) {
        setLib((l) => l.map((rec) => (rec.id !== h.rec.id ? rec : {
          ...rec, ttus: rec.ttus.map((t, i) => (i === idx ? { ...t, text, edited: true, revisions: (t.revisions ?? 0) + 1 } : t)),
        })));
        toast('Teksten er rettet. Originalen er bevart.');
        api.recordings().then(setRecs).catch(() => undefined);
      }
    } catch (e) { toast((e as Error).message); }
  };

  const openQueue = (hits: Hit[]) => {
    if (!hits.length) return;
    setCue((c) => (c ? { ...c, play: false, n: c.n + 1 } : c)); // stopp hovedspilleren
    setVq(hits);
  };
  const onVerified = (h: Hit, t: TtuT) => {
    setLib((l) => l.map((rec) => (rec.id !== h.rec.id ? rec : { ...rec, ttus: rec.ttus.map((x, i) => (i === h.idx ? { ...x, ...t, words: undefined } : x)) })));
  };
  const closeQueue = (n: number) => {
    setVq(null);
    if (n) toast(`${n} ${n === 1 ? 'tekstenhet' : 'tekstenheter'} verifisert mot lyd`);
    api.recordings().then(setRecs).catch(() => undefined);
  };

  const copy = (h: Hit) => {
    navigator.clipboard?.writeText(quote(h, window.location.origin)).then(
      () => toast(h.rec.ttus[h.idx].verified ? 'Sitat kopiert med kildelenke (verifisert mot lyd)' : 'Sitat kopiert med kildelenke, merket «ikke verifisert mot lyd»'),
      () => toast('Kunne ikke kopiere til utklippstavlen'),
    );
  };

  // ---------- avledet
  const rxs = useMemo(() => run.filter((c) => c.type === 'lex').map((c) => rx(c.val)), [run]);
  const all = useMemo(() => search(lib, run), [lib, run]);
  const vis = useMemo(() => visible(all), [all, visible]);
  const nrec = new Set(vis.map((h) => h.rec.id)).size;
  // Verifiseringskøen: uverifiserte treff, de mest usikre først.
  const unverified = vis.filter((h) => !h.rec.ttus[h.idx].verified).sort((a, b) => a.rec.ttus[a.idx].conf - b.rec.ttus[b.idx].conf);
  const runnable = chips.length > 0 && chips.every((c) => c.ok) && !busy;
  const hasPending = chips.some((c) => !c.ok);
  const speakers = useMemo(() => speakersOf(lib), [lib]);
  // Alle markerte søkeord i treffene, i rekkefølge: «Forekomst i av N».
  const occs = useMemo(() => (rxs.length ? occurrences(vis, rxs) : []), [vis, rxs]);
  const occIndex = curWord ? occs.findIndex((o) => o.hit.id === curWord.hitId && o.hit.idx === curWord.idx && o.k === curWord.k) : -1;
  const stepOcc = useCallback((d: number) => {
    if (!occs.length) return;
    const i = occIndex < 0 ? (d > 0 ? 0 : occs.length - 1) : (occIndex + d + occs.length) % occs.length;
    const o = occs[i];
    jumpToWord(o.hit, o.hit.idx, o.k, true, rxs);
  }, [occs, occIndex, jumpToWord, rxs]);
  // J / K: neste og forrige forekomst (ikke mens man skriver).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (tab !== 'sok' || vq || e.ctrlKey || e.metaKey || e.altKey || el.closest('input, textarea, [contenteditable]')) return;
      if (e.key === 'j' || e.key === 'J') { e.preventDefault(); stepOcc(1); }
      if (e.key === 'k' || e.key === 'K') { e.preventDefault(); stepOcc(-1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stepOcc, tab, vq]);
  const ttiPct = tti == null ? 0 : Math.min(100, tti / 150);
  const expPct = stats.searches ? Math.round((stats.expanded / stats.searches) * 100) + ' %' : '0 %';

  const box = (on: boolean) => <span className={'box' + (on ? ' on' : '')}>{on ? '✓' : ''}</span>;
  const section = (key: keyof typeof open, title: string, body: React.ReactNode) => (
    <section>
      <button className="sec-toggle" onClick={() => setOpen((o) => ({ ...o, [key]: !o[key] }))} aria-expanded={open[key]}>
        {title}<span style={{ transform: open[key] ? 'rotate(90deg)' : 'rotate(0deg)' }}>›</span>
      </button>
      {open[key] && <div className="sec-list">{body}</div>}
    </section>
  );

  return (
    <div className="shell">
      <div className="aurora" />
      <nav className="nav">
        <img src="/assets/verity-icon-v2.png" alt="Verity" />
        {(['sok', 'til', 'bib'] as Tab[]).map((t) => (
          <button key={t} title={TAB_NAME[t]} aria-label={TAB_NAME[t]} aria-current={tab === t ? 'page' : undefined} onClick={() => setTab(t)}>
            {t === 'sok' ? Icon.search : t === 'til' ? Icon.states : Icon.library}
          </button>
        ))}
      </nav>

      <div className="content">
        <header className="glass header">
          <img src="/assets/verity-wordmark-white.png" alt="Verity" />
          <div style={{ fontSize: 12, color: '#8B949E' }}>{TAB_NAME[tab]}</div>
          <div style={{ flex: 1 }} />
          <div className="tti">
            <div className="label">Tid til innsikt</div>
            <div className="tti-bar"><div style={{ width: ttiPct + '%', background: tti != null && tti > 15000 ? '#FF3D00' : 'linear-gradient(90deg,#2979FF,#00E5FF)' }} /></div>
            <div className="tti-val" data-testid="tti">{tti == null ? '–' : sec(tti)}</div>
            <div style={{ fontSize: 11, color: '#8B949E' }}>mål &lt; 15 s</div>
          </div>
        </header>

        {tab === 'sok' && (
          <div className="search-grid stage-layout">
            <aside className="glass filters">
              {section('rec', 'Opptak', lib.map((r) => (
                <button key={r.id} className="check-row" onClick={() => setRecOff((o) => ({ ...o, [r.id]: !o[r.id] }))}>
                  {box(!recOff[r.id])}<span title={r.name}>{r.name}</span><span className="count">{all.filter((h) => h.rec.id === r.id).length}</span>
                </button>
              )))}
              {section('spk', 'Talere', speakers.map((n) => (
                <button key={n} className="check-row" onClick={() => setSpkOff((o) => ({ ...o, [n]: !o[n] }))}>
                  {box(!spkOff[n])}<span title={n}>{n}</span><span className="count">{all.filter((h) => h.rec.ttus[h.idx].speaker === n).length}</span>
                </button>
              )))}
              {section('hist', 'Søkehistorikk', hist.map((h) => (
                <button key={h.label} className="hist-btn" onClick={() => exec(h.chips)}>{h.label}</button>
              )))}
              <div style={{ flex: 1 }} />
              <section className="exp-box">
                <div className="label" style={{ marginBottom: 6 }}>Kontekstjustering</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span className="mono" style={{ fontSize: 20, fontWeight: 500, color: '#00E5FF' }}>{expPct}</span>
                  <span style={{ fontSize: 12, color: '#8B949E' }}>{stats.expanded} av {stats.searches} søk</span>
                </div>
                <div style={{ fontSize: 11, color: '#8B949E', marginTop: 2 }}>Mål: under 20 %</div>
              </section>
            </aside>

            <section className="center">
              <div className="glass stage">
                <Player cue={cue} occ={occs.length ? { index: Math.max(0, occIndex), total: occs.length, prev: () => stepOcc(-1), next: () => stepOcc(1) } : null} />
              </div>
            <main className="results below">
              <section className="query-wrap">
                <div className="glass query">
                  <span style={{ color: '#8B949E', display: 'flex' }}>{Icon.search}</span>
                  {chips.map((c) => (
                    <ChipView key={c.id} chip={c}
                      onCycle={() => setChips((cs) => cs.map((x) => (x.id === c.id ? { ...x, type: NEXT_TYPE[x.type], ok: false } : x)))}
                      onApprove={() => setChips((cs) => cs.map((x) => (x.id === c.id ? { ...x, ok: true } : x)))}
                      onRemove={() => setChips((cs) => cs.filter((x) => x.id !== c.id))} />
                  ))}
                  <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Søk, f.eks. tillit Informant A" aria-label="Søk"
                    onKeyDown={(e) => { if (e.key === 'Enter') { if (text.trim()) parseNow(); else if (runnable) exec(chips); } }} />
                  <button className="btn-outline btn-tall" onClick={parseNow}>Tolk til chips</button>
                  {hasPending && <button className="btn-approve" onClick={() => setChips((cs) => cs.map((c) => ({ ...c, ok: true })))}>Godkjenn alle</button>}
                  <button className={'btn-run' + (runnable ? ' ready' : '')} onClick={() => runnable && exec(chips)} disabled={!runnable}>Kjør søk</button>
                </div>
                <div className="note">{hasPending ? 'Stiplede chips er ikke godkjent og kjøres ikke.' : chips.length ? '' : 'Ingen chips ennå.'}</div>
              </section>

              {loadError && <div className="zero" style={{ borderColor: 'rgba(255,61,0,0.4)' }}>{loadError}</div>}
              {!loadError && !lib.length && (
                <div className="zero">
                  <div style={{ fontWeight: 600 }}>Ingen opptak å søke i ennå.</div>
                  <div style={{ color: '#8B949E' }}>Dra lyd- eller videofiler inn hvor som helst i vinduet. Talemotoren gjør dem om til tekst på denne maskinen.</div>
                  <div><button className="btn-outline" onClick={() => setTab('bib')}>Gå til Biblioteket</button></div>
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
                <div className="summary" data-testid="summary">{busy ? 'Søker …' : run.length ? `${vis.length} treff i ${nrec} opptak` : ''}</div>
                {!busy && unverified.length > 0 && (
                  <button className="btn-outline cyan" onClick={() => openQueue(unverified)} title="Usikre først. Hele tekstenheten spilles av før den kan godkjennes.">
                    Verifiser treffene mot lyd <span className="mono" style={{ color: '#8B949E' }}>{unverified.length}</span>
                  </button>
                )}
              </div>

              {!busy && run.length > 0 && all.length === 0 && (
                <div className="zero">
                  <div style={{ fontWeight: 600 }}>Ingen treff på godkjente chips.</div>
                  <div style={{ color: '#8B949E' }}>Søket er ikke omformulert. Du kan fjerne en chip selv:</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {removalOptions(lib, run).map((o) => (
                      <button key={o.val} className="btn-outline warn" onClick={() => exec(o.rest)}>
                        Fjern «{o.val}» <span className="mono" style={{ color: '#8B949E' }}>→ {o.n} treff</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {vis.map((h) => {
                  const lv = expand[h.id] || 0;
                  const t = h.rec.ttus[h.idx];
                  const low = t.conf < LOW_CONF && !t.verified;
                  const [a, b] = range(h, lv + 1);
                  const [ca, cb] = range(h, lv);
                  const can = a < ca || b > cb;
                  return (
                    <article key={h.id} data-hit={h.id} className={'hit' + (active === h.id ? ' active' : '')} onClick={() => select(h, false)} data-testid="hit">
                      <div className="hit-head">
                        <span className="kind">{h.rec.kind.toUpperCase()}</span>
                        <div style={{ flex: '1 1 190px', minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 8 }}>
                          <span style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{h.rec.name}</span>
                          <span style={{ color: '#8B949E', whiteSpace: 'nowrap', flex: 'none' }}>{t.speaker}</span>
                        </div>
                        <div style={{ flex: 'none', marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span className="mono" style={{ fontSize: 12, color: '#00E5FF', whiteSpace: 'nowrap' }}>{fmt(t.start_ms)}–{fmt(t.end_ms)}</span>
                          <span className={'conf' + (low ? ' low' : '')}>{low ? `Lav sikkerhet ${Math.round(t.conf * 100)} %` : `${Math.round(t.conf * 100)} %`}</span>
                          {t.verified && <span className="verified-pill" title={`Verifisert av ${t.verified_by} ${t.verified_at ? new Date(t.verified_at * 1000).toLocaleString('nb-NO') : ''}`}>✓ Verifisert mot lyd</span>}
                        </div>
                      </div>
                      {low && <div className="low-banner">Lav transkripsjonssikkerhet. Teksten er ikke verifisert mot lyden. Lytt før du siterer.</div>}
                      <div style={{ padding: '2px 0 6px' }}>
                        <Lines hit={h} lvl={lv} rxs={rxs} onSeek={(ms) => select(h, false, ms)} onSpeaker={(idx, s) => changeSpeaker(h, idx, s)} onText={(idx, x) => changeText(h, idx, x)}
                          onWord={(idx, k) => jumpToWord(h, idx, k, true, rxs)}
                          currentWord={curWord?.hitId === h.id ? { idx: curWord.idx, k: curWord.k } : null} />
                      </div>
                      <div className="hit-foot">
                        <button className="btn-primary" onClick={(e) => { e.stopPropagation(); select(h, true); }}>▶ Spill av</button>
                        {!t.verified && <button className="btn-outline cyan" onClick={(e) => { e.stopPropagation(); openQueue([h]); }}>Verifiser mot lyd</button>}
                        <button className="btn-outline" onClick={(e) => { e.stopPropagation(); if (can) bump(h.id); }}>
                          Utvid kontekst <span className="mono" style={{ color: '#8B949E' }}>{lv > 0 ? '±' + (1 + lv) : can ? '+1' : 'maks'}</span>
                        </button>
                        {lv > 0 && (
                          <button className="btn-outline warn" style={{ borderColor: 'rgba(255,255,255,0.15)' }}
                            onClick={(e) => { e.stopPropagation(); setExpand((x) => ({ ...x, [h.id]: 0 })); }}>Tilbake til W</button>
                        )}
                        <div style={{ flex: 1 }} />
                        <button className="btn-outline cyan" onClick={(e) => { e.stopPropagation(); copy(h); }}>Kopier sitat + kildelenke</button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </main>
            </section>
          </div>
        )}

        {tab === 'til' && <StatesView onTry={exec} />}
        {tab === 'bib' && <LibraryView recs={recs} health={health} onChanged={refresh} toast={toast} />}
      </div>

      <DropImport recs={recs} onChanged={refresh} toast={toast} onOpen={() => setTab('bib')} />
      {vq && <VerifyQueue queue={vq} onVerified={onVerified} onClose={closeQueue} />}
      {toastMsg && <div className="toast" role="status">{toastMsg}</div>}
    </div>
  );
}
