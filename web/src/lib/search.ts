// Søket i Verity. Samme regler som i designet («Living Knowledge Surface»):
// godkjente chips kjøres, ingenting omformuleres, og treff er alltid hele
// tekstenheter (TTU) med tid og kilde.

export type ChipType = 'lex' | 'person' | 'tema';
export interface Chip { id: number; type: ChipType; val: string; ok: boolean }
export interface Ttu { idx: number; start_ms: number; end_ms: number; speaker: string; text: string; conf: number }
export interface Recording {
  id: string; name: string; kind: 'lyd' | 'video'; theme: string; file: string; duration_ms: number; ttus: Ttu[];
}
export interface Hit { id: string; rec: Recording; idx: number }

export const LOW_CONF = 0.7;
const STOP = ['og', 'i', 'om', 'på', 'av', 'en', 'et', 'det', 'som', 'til', 'for', 'med', 'er'];

export function fmt(ms: number): string {
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}.${p(Math.floor(ms % 1000), 3)}`;
}

/** Ordrett treff med vanlige norske bøyningsendelser («tillit», «tilliten»). */
export function rx(val: string, flags = 'iu'): RegExp {
  const body = val.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  return new RegExp('(?<![\\p{L}\\p{N}])' + body + '(?:en|et|er|ene|a|s|ens|ets)?(?![\\p{L}\\p{N}])', flags);
}

export function search(lib: Recording[], chips: Chip[]): Hit[] {
  if (!chips.length) return [];
  const P = chips.filter((c) => c.type === 'person');
  const Th = chips.filter((c) => c.type === 'tema');
  const rxs = chips.filter((c) => c.type === 'lex').map((c) => rx(c.val));
  const out: Hit[] = [];
  for (const r of lib) {
    if (Th.length && !Th.some((c) => r.theme.toLowerCase().includes(c.val.toLowerCase()))) continue;
    r.ttus.forEach((t, i) => {
      if (P.length && !P.some((c) => t.speaker.toLowerCase().includes(c.val.toLowerCase()))) return;
      if (!rxs.every((x) => x.test(t.text))) return;
      out.push({ id: `${r.id}-${i}`, rec: r, idx: i });
    });
  }
  return out;
}

export function hitById(lib: Recording[], id: string | null): Hit | null {
  if (!id) return null;
  const [r, i] = id.split('-');
  const rec = lib.find((x) => x.id === r);
  return rec && rec.ttus[+i] ? { id, rec, idx: +i } : null;
}

/** Konteksten rundt et treff: én TTU på hver side, og én til per utvidelse. */
export function range(h: Hit, lvl: number): [number, number] {
  const n = h.rec.ttus.length;
  return [Math.max(0, h.idx - 1 - lvl), Math.min(n - 1, h.idx + 1 + lvl)];
}

export interface Part { t: string; hit: boolean }
export function parts(text: string, rxs: RegExp[]): Part[] {
  const R: [number, number][] = [];
  rxs.forEach((r) => {
    const g = new RegExp(r.source, 'giu');
    let m: RegExpExecArray | null;
    while ((m = g.exec(text))) {
      R.push([m.index, m.index + m[0].length]);
      if (!m[0].length) g.lastIndex++;
    }
  });
  R.sort((a, b) => a[0] - b[0]);
  const M: [number, number][] = [];
  R.forEach((r) => {
    const l = M[M.length - 1];
    if (l && r[0] <= l[1]) l[1] = Math.max(l[1], r[1]);
    else M.push([r[0], r[1]]);
  });
  const out: Part[] = [];
  let c = 0;
  M.forEach((m) => {
    if (m[0] > c) out.push({ t: text.slice(c, m[0]), hit: false });
    out.push({ t: text.slice(m[0], m[1]), hit: true });
    c = m[1];
  });
  if (c < text.length) out.push({ t: text.slice(c), hit: false });
  return out;
}

/** Tolker fritekst til chips som må godkjennes. «Sitat» blir én leksikalsk chip. */
export function parse(text: string, existing: Chip[], lib: Recording[], speakers: string[], nextId: () => number): Chip[] {
  let t = ' ' + text + ' ';
  const out: Chip[] = [];
  const add = (type: ChipType, raw: string) => {
    const val = raw.trim();
    if (!val) return;
    if (existing.concat(out).some((c) => c.type === type && c.val.toLowerCase() === val.toLowerCase())) return;
    out.push({ id: nextId(), type, val, ok: false });
  };
  t = t.replace(/"([^"]+)"|«([^»]+)»/g, (_m, a, b) => { add('lex', a || b); return ' '; });
  const themes = [...new Set(lib.map((r) => r.theme).filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const th of themes) {
    const i = t.toLowerCase().indexOf(th.toLowerCase());
    if (i >= 0) { add('tema', th); t = t.slice(0, i) + ' ' + t.slice(i + th.length); }
  }
  for (const sp of [...speakers].sort((a, b) => b.length - a.length)) {
    const re = new RegExp('(?<![\\p{L}\\p{N}])' + sp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}])', 'iu');
    if (re.test(t)) { add('person', sp); t = t.replace(re, ' '); }
  }
  t.split(/\s+/).filter((w) => w && !STOP.includes(w.toLowerCase())).forEach((w) => add('lex', w));
  return out;
}

/** Ved null treff: hvor mange treff det blir om én chip fjernes. Søket endres aldri av seg selv. */
export function removalOptions(lib: Recording[], chips: Chip[]) {
  return chips.map((c, i) => {
    const rest = chips.filter((_, j) => j !== i);
    return { val: c.val, n: search(lib, rest).length, rest };
  });
}

export function speakersOf(lib: Recording[]): string[] {
  const seen = new Set<string>();
  lib.forEach((r) => r.ttus.forEach((t) => seen.add(t.speaker)));
  return [...seen];
}

export function quote(h: Hit, origin: string): string {
  const t = h.rec.ttus[h.idx];
  const low = t.conf < LOW_CONF;
  return `«${t.text}» — ${h.rec.name}, ${t.speaker}, ${fmt(t.start_ms)}–${fmt(t.end_ms)}` +
    (low ? ' [ikke verifisert mot lyd]' : '') +
    `\n${origin}/#/opptak/${h.rec.id}?start=${t.start_ms}&slutt=${t.end_ms}`;
}

export function parseLink(hash: string): { rec: string; start: number } | null {
  const m = /^#\/opptak\/([A-Za-z0-9]+)\?start=(\d+)/.exec(hash);
  return m ? { rec: m[1], start: +m[2] } : null;
}
