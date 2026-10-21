// Avspillingsvinduer og dekning for verifisering mot lyd.
//
// Parametrene er rimelige utgangspunkt, ikke målte verdier: de bør justeres
// etter at de er prøvd på ekte opptak.

export type LoopScope = 'ttu' | 'word';
export interface Word { t: string; s: number; e: number; p: number; j?: boolean }

export const LOOP = {
  ttuPreroll: 500, // ms før tekstenheten
  ttuPostroll: 300, // ms etter: ordtidene fra Whisper bommer ofte litt
  wordPreroll: 750, // ms før ordet, så øret får med seg opptakten
  wordPostroll: 400,
  gap: 150, // ms stillhet mellom hver runde, så start og slutt høres
  fade: 25, // ms inn- og uttoning mot knepp
  uncertainWord: 0.5, // ord under denne sannsynligheten understrekes (samme grense som talemotoren)
};

export function loopBounds(scope: LoopScope, ttu: { start_ms: number; end_ms: number }, word: Word | null, durationMs: number) {
  const end = (x: number) => Math.min(durationMs || Infinity, x);
  if (scope === 'word' && word) {
    return { start: Math.max(0, word.s - LOOP.wordPreroll), end: end(word.e + LOOP.wordPostroll) };
  }
  return { start: Math.max(0, ttu.start_ms - LOOP.ttuPreroll), end: end(ttu.end_ms + LOOP.ttuPostroll) };
}

/**
 * Hvilke deler av en tekstenhet som faktisk er spilt av. Bare sammenhengende
 * avspilling teller (hopp lengre enn ``maxStep`` regnes som spoling).
 */
export class Coverage {
  private spans: [number, number][] = [];
  constructor(readonly from: number, readonly to: number, readonly maxStep = 400) {}

  add(prevMs: number, nowMs: number) {
    if (nowMs <= prevMs || nowMs - prevMs > this.maxStep) return;
    const a = Math.max(prevMs, this.from), b = Math.min(nowMs, this.to);
    if (b <= a) return;
    this.spans.push([a, b]);
    this.spans.sort((x, y) => x[0] - y[0]);
    const merged: [number, number][] = [];
    for (const s of this.spans) {
      const l = merged[merged.length - 1];
      if (l && s[0] <= l[1] + 1) l[1] = Math.max(l[1], s[1]);
      else merged.push([s[0], s[1]]);
    }
    this.spans = merged;
  }

  /** Andel av tekstenheten som er spilt av, 0–1. */
  get fraction() {
    const total = this.to - this.from;
    if (total <= 0) return 1;
    return Math.min(1, this.spans.reduce((n, [a, b]) => n + (b - a), 0) / total);
  }

  /** Hele tekstenheten er spilt av (inntil 80 ms kan mangle på grunn av skjermoppdateringen). */
  get complete() {
    return (this.to - this.from) * (1 - this.fraction) <= 80;
  }
}

export function uncertainWords(words: Word[]) {
  return words.filter((w) => w.p < LOOP.uncertainWord);
}

/** Det mest usikre ordet: der lytteløkken starter når det er grunn til tvil. */
export function weakestWord(words: Word[]): Word | null {
  const u = uncertainWords(words);
  return u.length ? u.reduce((a, b) => (b.p < a.p ? b : a)) : null;
}
