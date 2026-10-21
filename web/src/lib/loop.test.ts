import { describe, expect, it } from 'vitest';
import { Coverage, LOOP, loopBounds, weakestWord } from './loop';

describe('lytteløkke', () => {
  it('vinduer for hel tekstenhet og enkeltord', () => {
    const ttu = { start_ms: 10000, end_ms: 14000 };
    const w = { t: 'tjenesten', s: 12000, e: 12500, p: 0.4 };
    expect(loopBounds('ttu', ttu, null, 60000)).toEqual({ start: 10000 - LOOP.ttuPreroll, end: 14000 + LOOP.ttuPostroll });
    expect(loopBounds('word', ttu, w, 60000)).toEqual({ start: 11250, end: 12900 });
    expect(loopBounds('ttu', { start_ms: 100, end_ms: 900 }, null, 1000)).toEqual({ start: 0, end: 1000 });
  });
  it('dekning teller bare sammenhengende avspilling', () => {
    const c = new Coverage(1000, 3000);
    for (let t = 900; t < 2000; t += 16) c.add(t, t + 16);
    expect(c.complete).toBe(false);
    c.add(2000, 2900); // spoling teller ikke
    expect(c.fraction).toBeLessThan(0.6);
    for (let t = 2000; t < 3000; t += 16) c.add(t, t + 16);
    expect(c.complete).toBe(true);
  });
  it('løkken starter på det mest usikre ordet', () => {
    const words = [{ t: 'a', s: 0, e: 1, p: 0.9 }, { t: 'b', s: 1, e: 2, p: 0.3 }, { t: 'c', s: 2, e: 3, p: 0.45 }];
    expect(weakestWord(words)?.t).toBe('b');
    expect(weakestWord([words[0]])).toBeNull();
  });
});
