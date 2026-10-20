import { hitById, removalOptions, rx, type Chip, type Recording } from '../lib/search';
import { ChipView } from './ChipView';
import { Lines } from './Lines';

// Eksempeldata fra designet. Viser hvordan Verity oppfører seg i de tre
// vanskelige tilstandene; søket bruker de samme funksjonene som på ekte data.
const T = (i: number, s: number, e: number, speaker: string, text: string, conf = 0.96) => ({ idx: i, start_ms: s, end_ms: e, speaker, text, conf });
const DEMO: Recording[] = [
  { id: 'd1', name: 'Intervju 07 – Hjemmetjeneste', kind: 'lyd', theme: 'Trygghetsalarm', file: 'intervju_07.wav', duration_ms: 2472000, ttus: [
    T(0, 752310, 758900, 'Intervjuer', 'Kan du fortelle hva som skjedde da alarmen kom i bruk første gang?'),
    T(1, 759120, 771480, 'Informant A', 'Jeg var skeptisk. Jeg hadde ikke tillit til at noen faktisk ville komme hvis jeg trykket på den.'),
    T(2, 771900, 779340, 'Intervjuer', 'Hva var det som gjorde at du var usikker?'),
    T(3, 779800, 792650, 'Informant A', 'Det var navnet på firmaet, egentlig. Jeg visste ikke hvem som satt i andre enden, og da blir det vanskelig å stole på det.'),
    T(4, 793100, 803220, 'Informant A', 'Etter at Silje fra hjemmetjenesten kom og viste meg den, ble tilliten en helt annen. Hun forklarte hva som skjer når jeg trykker.'),
    T(5, 803700, 808100, 'Intervjuer', 'Så det var personen, ikke teknologien?'),
    T(6, 808500, 820940, 'Informant A', 'Ja. Teknologien er bare en dings. Tilliten bygger jeg til folkene som kommer når den brukes.'),
    T(7, 821300, 826000, 'Intervjuer', 'Har det endret seg etter at tjenesten ble lagt om?'),
    T(8, 826400, 838770, 'Informant A', 'Litt. Nå kommer det ofte nye folk, og jeg må begynne på nytt med å bygge tillit hver gang.', 0.58),
  ] },
  { id: 'd2', name: 'Intervju 12 – Pårørende', kind: 'video', theme: 'Digitale tilsyn', file: 'intervju_12.mp4', duration_ms: 3160000, ttus: [
    T(0, 1210600, 1224300, 'Informant B', 'Jeg ble redd. Kameraet på kjøkkenet føltes som overvåking, og jeg trodde mamma ville oppleve det som mistillit.'),
    T(1, 1229500, 1243800, 'Informant B', 'Hun sa: det er greit så lenge jeg vet hvem som ser. Det handler om tillit, men også om kontroll.'),
    T(2, 1262800, 1275000, 'Informant B', 'Vi har ikke tillit til systemet alene. Vi har tillit til at noen svarer når det betyr noe.'),
  ] },
];
const CHIPS: Chip[] = [
  { id: 1, type: 'lex', val: 'tillit', ok: true },
  { id: 2, type: 'person', val: 'Informant A', ok: true },
  { id: 3, type: 'tema', val: 'Digitale tilsyn', ok: true },
];

export function StatesView({ onTry }: { onTry: (chips: Chip[]) => void }) {
  const rt = [rx('tillit')];
  const low = hitById(DEMO, 'd1-8')!;
  const exp = hitById(DEMO, 'd1-4')!;
  const head = (k: string, title: string) => (
    <div className="card-head"><span className="mono" style={{ fontSize: 11, color: '#00E5FF' }}>{k}</span><span style={{ fontWeight: 600 }}>{title}</span></div>
  );
  return (
    <div className="page">
      <div className="page-inner">
        <div style={{ color: '#8B949E', maxWidth: '70ch', lineHeight: 1.55 }}>
          Ingen treff, lav sikkerhet og utvidet kontekst. Ingen tilstand omformulerer, oppsummerer eller gjetter. Alle valg ligger hos brukeren.
          <span style={{ color: '#6f7a87' }}> Eksempeldata.</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 14, alignItems: 'start' }}>
          <section className="glass" style={{ overflow: 'hidden' }}>
            {head('A', 'Ingen treff')}
            <div className="card-body">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{CHIPS.map((c) => <ChipView key={c.id} chip={c} />)}</div>
              <div style={{ border: '1px dashed rgba(255,255,255,0.18)', borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontWeight: 600 }}>0 treff på godkjente chips</div>
                <div style={{ color: '#8B949E', lineHeight: 1.5 }}>Ingen ordrett treff eller bøyning av «tillit» hos Informant A i opptak med tema Digitale tilsyn.</div>
              </div>
              <div className="label">Fjern én chip</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {removalOptions(DEMO, CHIPS).map((o) => (
                  <button key={o.val} className="btn-outline" style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 12px' }} onClick={() => onTry(o.rest)}>
                    <span>Fjern «{o.val}»</span><span className="mono" style={{ color: '#8B949E' }}>{o.n} treff</span>
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="glass" style={{ overflow: 'hidden' }}>
            {head('B', 'Lav sikkerhet')}
            <div className="card-body">
              <div className="hit">
                <div className="hit-head">
                  <span className="kind">LYD</span><span style={{ fontWeight: 600 }}>{low.rec.name}</span><div style={{ flex: 1 }} />
                  <span className="conf low">Lav sikkerhet {Math.round(low.rec.ttus[8].conf * 100)} %</span>
                </div>
                <div className="low-banner">Lav transkripsjonssikkerhet. Teksten er ikke verifisert mot lyden.</div>
                <div style={{ padding: '2px 0 6px' }}><Lines hit={low} lvl={0} rxs={rt} small /></div>
                <div className="hit-foot">
                  <span className="btn-primary" style={{ padding: '7px 12px' }}>▶ Lytt først</span>
                  <span className="btn-outline cyan" style={{ cursor: 'default' }}>Kopier med forbehold</span>
                </div>
              </div>
              <div style={{ color: '#8B949E', lineHeight: 1.55, fontSize: 13 }}>
                Grense: under 70 %. Teksten vises uendret med bølgete understreking. Kopiert sitat får merket «ikke verifisert mot lyd» og kildelenke.
              </div>
            </div>
          </section>

          <section className="glass" style={{ overflow: 'hidden' }}>
            {head('C', 'Utvidet kontekst')}
            <div className="card-body">
              <div className="hit" style={{ padding: '4px 0 6px' }}><Lines hit={exp} lvl={1} rxs={rt} tagged small /></div>
              <div className="mono" style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, lineHeight: 1.5, color: '#8B949E' }}>
                <div>W = 1 TTU før + mål + 1 TTU etter</div>
                <div>Utvid ×1 = 2 før + mål + 2 etter</div>
              </div>
              <div style={{ color: '#8B949E', lineHeight: 1.55, fontSize: 13 }}>
                Hver utvidelse legger til nøyaktig én TTU på hver side, uten omformulering. Målet er utvidelse i 1 av 5 søk eller færre.
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
