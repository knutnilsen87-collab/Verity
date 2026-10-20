# Verity

Søk i egne lyd- og videoopptak: intervjuer, fokusgrupper, møter. Teksten lages lokalt av talemotoren **nsb-engine** fra [NorwegianSpeechBase](https://github.com/knutnilsen87-collab/NSBmain). Treff vises som hele ytringer med tid, taler og kilde, og kan spilles av med ms-presisjon.

Grensesnittet følger designet «Living Knowledge Surface» (Claude Design, oktober 2026). Ingenting omformuleres, oppsummeres eller gjettes: søket kjører bare chips brukeren har godkjent, og teksten vises slik talemotoren skrev den.

Status: første versjon (0.1.0), oktober 2026. Ikke testet med NB-Whisper på ekte intervjuer ennå.

## Starte

Krever Windows, Python 3.11 (`py -3.11`), Node.js (første gang, for å bygge nettsiden) og talemotoren fra NorwegianSpeechBase.

```powershell
# 1. Talemotoren (eget vindu)
Set-Location "F:\prosjekter_MAIN\NorwegianSpeechBase"
& ".\scripts\RUN_ENGINE.cmd"

# 2. Verity
Set-Location "F:\prosjekter_MAIN\Verity"
& ".\scripts\RUN_VERITY.cmd"
```

Verity åpnes på http://127.0.0.1:8780/. Første start lager `.venv` og bygger nettsiden (noen minutter).

## Slik virker det

```
Opptak (lyd/video) ─▶ Verity-tjenesten (127.0.0.1:8780) ─▶ nsb-engine (127.0.0.1:8765)
                     dekoder til 16 kHz, lagrer           bare tale dekodes (VAD),
                     bølgeform, deler i tekstenheter  ◀── ord med tid og sannsynlighet
Nettleser ◀── søk, avspilling, sitat
```

1. **Bibliotek:** importer et opptak med navn, tema, taler og navn/fagord. Tjenesten trekker ut lyden (PyAV), lagrer bølgeformen og sender lyden til talemotoren med `vad=true`. Stillhet sendes aldri til modellen.
2. **Tekstenheter (TTU):** ordene deles ved pauser over 0,8 s, ved punktum når enheten er minst 4 s, og senest etter 20 s. Sikkerheten er snittet av ordenes sannsynlighet; under 70 % vises som «Lav sikkerhet» med bølgete understreking.
3. **Søk:** fritekst tolkes til chips (leksikalsk, person, tema) som må godkjennes. Leksikalske chips treffer hele ord med vanlige bøyningsendelser («tillit», «tilliten»). Null treff gir forslag om å fjerne én chip, med antall treff; søket endres aldri av seg selv.
4. **Kontekst:** et treff viser én tekstenhet før og etter (W). «Utvid kontekst» legger til én på hver side, opptil tre ganger.
5. **Sitat:** «Kopier sitat + kildelenke» gir teksten, opptak, taler, tid og en lenke (`#/opptak/<id>?start=…&slutt=…`) som åpner opptaket på stedet. Lav sikkerhet gir merket «[ikke verifisert mot lyd]».

## Personvern og sikkerhet

- Tjenesten lytter bare på 127.0.0.1, avviser fremmede `Host`-navn (mot DNS-rebinding) og endringer fra andre nettsider (`Origin`).
- Opptak og tekst lagres i `%LOCALAPPDATA%\Verity` (eller `--data`), aldri i repoet.
- Nøkkelen til talemotoren leses fra `%LOCALAPPDATA%\nsb-engine\access_token` av tjenesten (samme Windows-bruker) og sendes aldri til nettleseren.
- **Ikke på plass ennå:** kryptering av lagrede opptak og tekst, tilgangsstyring for flere brukere, innsynslogg og automatisk sletting. Bruk BitLocker på maskinen inntil videre. Før ekte intervjuer med personopplysninger lagres, må dette vurderes (behandlingsgrunnlag, samtykke, lagringstid).

## Kjente begrensninger

- **Talere:** talemotoren skiller ikke mellom talere. Alle tekstenheter får taleren som er oppgitt ved import. Taler kan endres per tekstenhet (klikk på navnet i et treff) eller for hele opptaket i Biblioteket.
- **Sikkerheten** er modellens egen sannsynlighet. Strømmeanalysen i NorwegianSpeechBase viste at den fanger en mindre del av feilene; tekst med høy sikkerhet kan også være feil.
- **Søket** er ordrett med enkle bøyningsendelser. Ingen synonymer eller semantisk søk (med vilje: ingen omformulering).
- **Store biblioteker:** hele biblioteket lastes inn i nettleseren og søkes der. Greit for hundrevis av timer; tusenvis krever søk i tjenesten.
- **Lengde:** opptak over omtrent 4 timer blir for store for talemotoren i ett kall (500 MB lyd).
- **Tid til innsikt** måler tiden fra «Kjør søk» til treffene er klare. Søket er lokalt, så tallet er lavt.

## Utvikling

```bash
cd server && pip install -e .[dev] && pytest && ruff check .
cd web && npm ci && npm test && npm run build
cd web && npm run dev   # http://127.0.0.1:5180, /api sendes til tjenesten på 8780
```

| Mappe | Innhold |
| --- | --- |
| `server/verity/` | `app.py` (API og nettside), `worker.py` (importkø), `engine.py` (klient mot nsb-engine), `segment.py` (ord til tekstenheter), `media.py` (dekoding og bølgeform), `store.py` (SQLite) |
| `web/src/lib/search.ts` | Søket: chips, bøyning, kontekst, sitat, kildelenke |
| `web/src/components/` | Spiller, treff, tilstander, bibliotek |
| `docs/design/` | Designet fra Claude Design (referanse) |

## API

| Kall | Hva |
| --- | --- |
| `GET /api/health` | Versjon og om talemotoren svarer |
| `GET /api/library` | Ferdige opptak med tekstenheter (det søket bruker) |
| `GET /api/recordings` | Alle opptak med status (`queued`, `transcribing`, `ready`, `failed`) og feilmelding |
| `POST /api/recordings?filename=&name=&theme=&speaker=&hotwords=` | Kroppen er filen. Legges i kø |
| `PATCH /api/recordings/{id}` | `{"name","theme","speakers":{"gammel":"ny"}}` |
| `PUT /api/recordings/{id}/ttus/{idx}/speaker` | `{"speaker":"…"}` |
| `POST /api/recordings/{id}/retry` / `DELETE /api/recordings/{id}` | Transkriber på nytt / slett opptak, tekst og fil |
| `GET /api/recordings/{id}/media` / `…/peaks?from_ms=&to_ms=&n=` | Filen (med Range) / bølgeform |
