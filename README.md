# Verity

Søk i egne lyd- og videoopptak: intervjuer, fokusgrupper, møter. Teksten lages lokalt av talemotoren **nsb-engine** fra [NorwegianSpeechBase](https://github.com/knutnilsen87-collab/NSBmain). Treff vises som hele ytringer med tid, taler og kilde, og kan spilles av med ms-presisjon.

Grensesnittet følger designet «Living Knowledge Surface» (Claude Design, oktober 2026). Ingenting omformuleres, oppsummeres eller gjettes: søket kjører bare chips brukeren har godkjent, og teksten vises slik talemotoren skrev den.

Status: versjon 0.5.0, oktober 2026. Ikke testet med NB-Whisper på ekte intervjuer ennå.

## Starte

**Enklest:** dobbeltklikk `Start Verity.cmd` i Verity-mappen. Den starter talemotoren i et eget vindu hvis den ikke kjører (fra `..\NorwegianSpeechBase`, eller `NSB_ROOT`), venter til den er klar og åpner Verity i nettleseren.

Talemotoren startes med modellen **dialekt_v1** (videretrent på dialekt og nynorsk; omtrent halvparten så mange feil på samtale som utgangsmodellen, se NorwegianSpeechBase `docs/experiments/DIALEKT_V1.md`) og forkorting av gjentakelsesløkker. Overstyres med `VERITY_ENGINE_MODEL` og `VERITY_ENGINE_DECODING`. Kjører motoren allerede med en annen modell, brukes den, og Biblioteket viser hvilke opptak som er laget med en annen modell enn den som kjører.

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

1. **Import:** dra lyd- eller videofiler inn hvor som helst i Verity, også flere samtidig. De lastes opp med en gang (navnet tas fra filnavnet), og en liste nede i hjørnet viser opplasting og transkripsjon. Navn, tema og taler kan endres i Biblioteket etterpå, og importskjemaet der kan fortsatt brukes når du vil sette tema og navn/fagord på forhånd. Tjenesten trekker ut lyden (PyAV), lagrer bølgeformen og sender lyden til talemotoren med `vad=true`. Stillhet sendes aldri til modellen.
2. **Tekstenheter (TTU):** ordene deles ved pauser over 0,8 s, ved punktum når enheten er minst 4 s, og senest etter 20 s. Sikkerheten er snittet av ordenes sannsynlighet; under 70 % vises som «Lav sikkerhet» med bølgete understreking.
3. **Søk:** fritekst tolkes til chips (leksikalsk, person, tema) som må godkjennes. Leksikalske chips treffer hele ord med vanlige bøyningsendelser («tillit», «tilliten»). Null treff gir forslag om å fjerne én chip, med antall treff; søket endres aldri av seg selv.
4. **Hopp til søkeordet:** lyd- eller videosporet står øverst og midt på skjermen, med søket under. Hvert markert søkeord i treffene kan klikkes, og avspillingen hopper til det eksakte stedet ordet blir sagt (ordtider fra talemotoren, 250 ms før ordet så starten ikke kuttes; en magenta strek i bølgeformen viser ordet). «Forekomst i av N» med ‹ › eller tastene J/K går gjennom alle forekomstene i treffene, i rekkefølge. Er teksten rettet slik at ordet ikke finnes i talemotorens ord, hoppes det til starten av tekstenheten.
5. **Kontekst:** et treff viser én tekstenhet før og etter (W). «Utvid kontekst» legger til én på hver side, opptil tre ganger.
6. **Sitat:** «Kopier sitat + kildelenke» gir teksten, opptak, taler, tid, filnavn med SHA-256 og en lenke (`#/opptak/<id>?start=…&slutt=…`) som åpner opptaket på stedet. Sitater som ikke er verifisert, merkes «ikke verifisert mot lyd», også når talemotoren var sikker, fordi sikkerheten bare fanger en mindre del av feilene. Verifiserte sitater merkes «verifisert mot lyd av <bruker> <dato>». Manuell retting står også i merket.
7. **Verifisering mot lyd:** «Verifiser treffene mot lyd» (usikre først) eller «Verifiser mot lyd» på ett treff åpner køen. Hele tekstenheten spilles av med 500 ms før og 300 ms etter, i løkke med 150 ms pause. «Godkjenn» blir først mulig når hele tekstenheten faktisk er spilt av (sammenhengende; spoling teller ikke). Ord under 50 % sannsynlighet er understreket og kan lyttes til i en egen løkke (750 ms før, 400 ms etter). Teksten kan rettes før godkjenning. Taster: F2 spill på nytt, F4 ord/hel tekstenhet, F8 0,75× med bevart tonehøyde, F9 hopp over, Ctrl+Enter godkjenn, Esc lukk. Endres tekst eller taler etterpå, gjelder ikke verifiseringen lenger.

   Verity kan ikke vite at noen lyttet, bare at lyden ble spilt av før godkjenning; det er det loggen viser. Løkkeparametrene er rimelige utgangspunkt, ikke målte verdier, og bør justeres etter bruk på ekte opptak.
8. **Retting:** tekst (✎ ved linjen) og taler (klikk på navnet) kan rettes. Teksten fra talemotoren endres aldri; hver retting lagres som en revisjon med tid og Windows-bruker, og «rettet»-merket viser originalen og alle rettinger. Et opptak med rettinger kan ikke transkriberes på nytt, siden rettingene da ville gått tapt.

## Sporbarhet

- **Sjekksum:** SHA-256 av fila regnes ut mens den lastes opp og står i Biblioteket og i hvert sitat. «Kontroller fil» regner den ut på nytt og sier om fila er endret siden import.
- **Endringslogg:** import, transkripsjon, rettinger, verifiseringer, endret navn/tema, filkontroller og sletting føres i en logg der hver hendelse har en HMAC over innholdet og forrige hendelse. Endres, fjernes eller settes en hendelse inn i ettertid, viser Biblioteket hvor kjeden er brutt. Loggen inneholder bare SHA-256 av gammel og ny tekst, aldri teksten selv; ved sletting forsvinner teksten og revisjonene, mens kjeden forblir hel.
- **Grenser:** nøkkelen ligger i `audit.key` i datamappen. Den som har tilgang til den (samme Windows-bruker) kan skrive hele loggen på nytt, og at de siste hendelsene er kuttet bort, oppdages bare mot en tidligere kjent «siste HMAC». Ekstern forankring av den (for eksempel i en signert kopi utenfor maskinen) er ikke bygget. Verity signerer ingenting, og en retting viser hvem som var logget inn i Windows, ikke at noen har lyttet til lyden.

## Personvern og sikkerhet

- Tjenesten lytter bare på 127.0.0.1, avviser fremmede `Host`-navn (mot DNS-rebinding) og endringer fra andre nettsider (`Origin`).
- Opptak og tekst lagres i `%LOCALAPPDATA%\Verity` (eller `--data`), aldri i repoet.
- Nøkkelen til talemotoren leses fra `%LOCALAPPDATA%\nsb-engine\access_token` av tjenesten (samme Windows-bruker) og sendes aldri til nettleseren.
- **Ikke på plass ennå:** kryptering av lagrede opptak og tekst, tilgangsstyring for flere brukere og automatisk sletting. Endringsloggen (over) viser hva som er endret, ikke hvem som har lest. Bruk BitLocker på maskinen inntil videre. Før ekte intervjuer med personopplysninger lagres, må dette vurderes (behandlingsgrunnlag, samtykke, lagringstid).

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
| `server/verity/` | `app.py` (API og nettside), `worker.py` (importkø), `engine.py` (klient mot nsb-engine), `segment.py` (ord til tekstenheter), `media.py` (dekoding og bølgeform), `store.py` (SQLite, revisjoner), `audit.py` (endringslogg) |
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
| `PUT /api/recordings/{id}/ttus/{idx}/speaker` / `…/text` | `{"speaker":"…"}` / `{"text":"…"}`. Lagres som revisjon |
| `GET /api/recordings/{id}/ttus/{idx}` | Én tekstenhet med ord, tider og sannsynlighet |
| `POST /api/recordings/{id}/ttus/{idx}/verify` | `{"text","full_playback":true,"loops","slowest_rate","listened_ms"}`. Nektes uten `full_playback` |
| `GET /api/recordings/{id}/ttus/{idx}/revisions` | Original fra talemotoren, alle rettinger og verifiseringer |
| `POST /api/recordings/{id}/check-file` | Regner ut SHA-256 på nytt og sammenligner med importen |
| `GET /api/audit?rec_id=&limit=` | Kontroll av endringsloggen og de siste hendelsene |
| `POST /api/recordings/{id}/retry` / `DELETE /api/recordings/{id}` | Transkriber på nytt (nektes ved rettinger) / slett opptak, tekst, revisjoner og fil |
| `GET /api/recordings/{id}/media` / `…/peaks?from_ms=&to_ms=&n=` | Filen (med Range) / bølgeform |
