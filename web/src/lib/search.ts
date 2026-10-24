// Søket i Verity. Samme regler som i designet («Living Knowledge Surface»):
// godkjente chips kjøres, ingenting omformuleres, og treff er alltid hele
// tekstenheter (TTU) med tid og kilde.

export type ChipType = 'lex' | 'person' | 'tema';
export interface Chip { id: number; type: ChipType; val: string; ok: boolean }
export interface Ttu {
  idx: number; start_ms: number; end_ms: number; speaker: string; text: string; conf: number;
  /** Teksten er rettet for hånd (originalen fra talemotoren er bevart). */
  edited?: boolean;
  /** Antall rettinger av tekst og taler. */
  revisions?: number;
  /** Godkjent etter at hele tekstenheten er spilt av, med denne teksten og taleren. */
  verified?: boolean;
  verified_by?: string | null;
  verified_at?: number | null;
  words?: { t: string; s: number; e: number; p: number; j?: boolean }[];
}
export interface Recording {
  id: string; name: string; kind: 'lyd' | 'video'; theme: string; file: string; duration_ms: number; ttus: Ttu[];
  /** SHA-256 av fila slik den ble importert. */
  sha256?: string;
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

/**
 * Sitat med kilde. Sitater som ikke er godkjent i verifiseringskøen, merkes
 * «ikke verifisert mot lyd», også når talemotoren var sikker: sikkerheten fanger
 * bare en mindre del av feilene. Rettet tekst merkes som rettet.
 */
export function quote(h: Hit, origin: string): string {
  const t = h.rec.ttus[h.idx];
  const marks = [t.verified && t.verified_at
    ? `verifisert mot lyd av ${t.verified_by} ${new Date(t.verified_at * 1000).toLocaleDateString('nb-NO')}`
    : 'ikke verifisert mot lyd'];
  if (t.conf < LOW_CONF && !t.verified) marks.push(`lav sikkerhet ${Math.round(t.conf * 100)} %`);
  if (t.edited) marks.push('tekst rettet manuelt');
  return `«${t.text}» — ${h.rec.name}, ${t.speaker}, ${fmt(t.start_ms)}–${fmt(t.end_ms)} [${marks.join('; ')}]` +
    `\nKilde: ${h.rec.file}` + (h.rec.sha256 ? ` (SHA-256 ${h.rec.sha256})` : '') +
    `\n${origin}/#/opptak/${h.rec.id}?start=${t.start_ms}&slutt=${t.end_ms}`;
}

export function parseLink(hash: string): { rec: string; start: number } | null {
  const m = /^#\/opptak\/([A-Za-z0-9]+)\?start=(\d+)/.exec(hash);
  return m ? { rec: m[1], start: +m[2] } : null;
}

export interface TimedWord { t: string; s: number; e: number; j?: boolean }

/**
 * Starttiden (ms) for hvert søketreff i en tekstenhet, i rekkefølge. Ordene settes
 * sammen slik talemotoren skrev dem, søket kjøres på den teksten, og hvert treff
 * knyttes til ordet det begynner i. Brukes når man klikker på et markert søkeord.
 */
export function matchTimes(words: TimedWord[], rxs: RegExp[]): number[] {
  let text = '';
  const starts: number[] = [];
  words.forEach((w, i) => {
    if (i && !w.j) text += ' ';
    starts.push(text.length);
    text += w.t;
  });
  const hits: number[] = [];
  rxs.forEach((r) => {
    const g = new RegExp(r.source, 'giu');
    let m: RegExpExecArray | null;
    while ((m = g.exec(text))) {
      hits.push(m.index);
      if (!m[0].length) g.lastIndex++;
    }
  });
  hits.sort((a, b) => a - b);
  const out: number[] = [];
  let last = -1;
  for (const c of hits) {
    if (c === last) continue; // flere chips som treffer samme sted
    last = c;
    let k = 0;
    while (k + 1 < starts.length && starts[k + 1] <= c) k++;
    out.push(words[k].s);
  }
  return out;
}

/** Antall markerte treff i målteksten til hvert treff: grunnlaget for «forekomst i av N». */
export function occurrences(hits: Hit[], rxs: RegExp[]): { hit: Hit; k: number }[] {
  const out: { hit: Hit; k: number }[] = [];
  for (const h of hits) {
    const n = parts(h.rec.ttus[h.idx].text, rxs).filter((p) => p.hit).length;
    for (let k = 0; k < Math.max(1, n); k++) out.push({ hit: h, k });
  }
  return out;
}
