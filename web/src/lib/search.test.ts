import { describe, expect, it } from 'vitest';
import { fmt, hitById, parse, parseLink, parts, quote, range, removalOptions, rx, search, type Chip, type Recording } from './search';

const T = (i: number, s: number, e: number, speaker: string, text: string, conf = 0.95) => ({ idx: i, start_ms: s, end_ms: e, speaker, text, conf });
const LIB: Recording[] = [
  { id: 'r1', name: 'Intervju 07', kind: 'lyd', theme: 'Trygghetsalarm', file: 'a.wav', duration_ms: 900000, ttus: [
    T(0, 752310, 758900, 'Intervjuer', 'Kan du fortelle hva som skjedde?'),
    T(1, 759120, 771480, 'Informant A', 'Jeg hadde ikke tillit til at noen ville komme.'),
    T(2, 771900, 779340, 'Intervjuer', 'Hva gjorde deg usikker?'),
    T(3, 779800, 792650, 'Informant A', 'Etter at Silje kom, ble tilliten en helt annen.', 0.58),
  ] },
  { id: 'r2', name: 'Intervju 12', kind: 'video', theme: 'Digitale tilsyn', file: 'b.mp4', duration_ms: 900000, ttus: [
    T(0, 1000, 5000, 'Informant B', 'Det handler om tillit, men også om kontroll.'),
  ] },
];
let n = 100;
const chip = (type: Chip['type'], val: string): Chip => ({ id: n++, type, val, ok: true });

describe('søk', () => {
  it('finner bøyde former og ikke ord som bare inneholder søkeordet', () => {
    expect(rx('tillit').test('tilliten')).toBe(true);
    expect(rx('tillit').test('mistillit')).toBe(false);
    expect(search(LIB, [chip('lex', 'tillit')]).map((h) => h.id)).toEqual(['r1-1', 'r1-3', 'r2-0']);
  });
  it('person og tema begrenser treffene', () => {
    expect(search(LIB, [chip('lex', 'tillit'), chip('person', 'Informant B')]).map((h) => h.id)).toEqual(['r2-0']);
    expect(search(LIB, [chip('lex', 'tillit'), chip('tema', 'Trygghetsalarm')]).length).toBe(2);
  });
  it('null treff gir forslag om å fjerne én chip, med antall treff', () => {
    const chips = [chip('lex', 'tillit'), chip('person', 'Informant A'), chip('tema', 'Digitale tilsyn')];
    expect(search(LIB, chips)).toEqual([]);
    expect(removalOptions(LIB, chips).map((o) => [o.val, o.n])).toEqual([['tillit', 0], ['Informant A', 1], ['Digitale tilsyn', 2]]);
  });
  it('kontekst er én TTU på hver side, pluss én per utvidelse', () => {
    const h = hitById(LIB, 'r1-1')!;
    expect(range(h, 0)).toEqual([0, 2]);
    expect(range(h, 1)).toEqual([0, 3]);
  });
  it('markerer treff uten å endre teksten', () => {
    const p = parts('Tilliten bygger jeg, tillit tar tid.', [rx('tillit')]);
    expect(p.map((x) => x.t).join('')).toBe('Tilliten bygger jeg, tillit tar tid.');
    expect(p.filter((x) => x.hit).map((x) => x.t)).toEqual(['Tilliten', 'tillit']);
  });
  it('tolker fritekst til chips som venter på godkjenning', () => {
    let id = 1;
    const out = parse('tillit hos informant a i digitale tilsyn «tok tid»', [], LIB, ['Intervjuer', 'Informant A', 'Informant B'], () => id++);
    expect(out.map((c) => [c.type, c.val, c.ok])).toEqual([
      ['lex', 'tok tid', false], ['tema', 'Digitale tilsyn', false], ['person', 'Informant A', false],
      ['lex', 'tillit', false], ['lex', 'hos', false],
    ]);
  });
  it('sitat har tid, kilde og forbehold ved lav sikkerhet', () => {
    const q = quote(hitById(LIB, 'r1-3')!, 'http://127.0.0.1:8780');
    expect(q).toContain('00:12:59.800–00:13:12.650');
    expect(q).toContain('[ikke verifisert mot lyd]');
    expect(parseLink(q.slice(q.indexOf('#')))).toEqual({ rec: 'r1', start: 779800 });
    expect(fmt(3723004)).toBe('01:02:03.004');
  });
});
