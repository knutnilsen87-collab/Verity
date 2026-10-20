# Design

`Living Knowledge Surface.dc.html` er prototypen fra Claude Design (eksportert 2026-10-21) som Verity er bygget etter. Den åpnes i nettleseren sammen med `support.js` og bruker egne eksempeldata.

Avvik i Verity, og hvorfor:

- **Bibliotek** (tredje knapp i menyen) er nytt: import, status, tema og talere. Designet hadde ingen måte å få opptak inn på.
- **Ekte avspilling:** lyd og video spilles av fra opptaket, og bølgeformen er beregnet fra lyden. I designet var begge simulert.
- **Taler** kan endres ved å klikke på navnet i et treff, fordi talemotoren ikke skiller talere ennå.
- **Kildelenken** peker til Verity på maskinen (`http://127.0.0.1:8780/#/opptak/…`) i stedet for `kunnskap.example`.
- **Tilstander** viser fortsatt designets eksempeldata, merket som det.
