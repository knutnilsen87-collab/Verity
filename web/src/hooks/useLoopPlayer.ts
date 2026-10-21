import { useCallback, useEffect, useRef, useState } from 'react';
import { LOOP } from '../lib/loop';

interface Range { start: number; end: number }

/**
 * Spiller et tidsvindu i løkke med kort pause mellom rundene og myk inn- og
 * uttoning. ``onFrame(prevMs, nowMs)`` kalles for hver skjermoppdatering mens
 * lyden går, slik at kallende kode kan føre hva som faktisk er spilt av.
 */
export function useLoopPlayer(src: string | null, onFrame?: (prevMs: number, nowMs: number) => void) {
  const el = useRef<HTMLAudioElement | null>(null);
  const range = useRef<Range>({ start: 0, end: 0 });
  const raf = useRef(0);
  const gapTimer = useRef(0);
  const last = useRef<number | null>(null);
  const frameCb = useRef(onFrame);
  frameCb.current = onFrame;
  const [playing, setPlaying] = useState(false);
  const [posMs, setPosMs] = useState(0);
  const [rate, setRate] = useState<1 | 0.75>(1);
  const [loops, setLoops] = useState(0);
  const [error, setError] = useState('');
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const a = new Audio();
    a.preload = 'auto';
    a.preservesPitch = true;
    a.onerror = () => setError('Opptaket kan ikke spilles av i nettleseren.');
    a.onloadedmetadata = () => setDuration(a.duration * 1000);
    el.current = a;
    return () => { a.pause(); cancelAnimationFrame(raf.current); clearTimeout(gapTimer.current); a.src = ''; };
  }, []);

  useEffect(() => {
    if (el.current && src) { el.current.src = src; setError(''); }
  }, [src]);

  const stop = useCallback(() => {
    cancelAnimationFrame(raf.current);
    clearTimeout(gapTimer.current);
    el.current?.pause();
    last.current = null;
    setPlaying(false);
  }, []);

  const tick = useCallback(() => {
    const a = el.current;
    if (!a) return;
    const now = a.currentTime * 1000;
    const { start, end } = range.current;
    if (last.current != null) frameCb.current?.(last.current, now);
    last.current = now;
    setPosMs(now);
    const left = (end - now) / a.playbackRate;
    const sinceStart = (now - start) / a.playbackRate;
    a.volume = Math.max(0, Math.min(1, left / LOOP.fade, sinceStart / LOOP.fade));
    if (now >= end) {
      // Pause mellom rundene, så øret hører hvor klippet starter og slutter.
      a.pause();
      a.currentTime = start / 1000;
      last.current = null;
      setLoops((n) => n + 1);
      gapTimer.current = window.setTimeout(() => {
        a.volume = 0;
        a.play().then(() => { raf.current = requestAnimationFrame(tick); }).catch((e) => { setError(`kan ikke spille av: ${e.message}`); setPlaying(false); });
      }, LOOP.gap);
      return;
    }
    raf.current = requestAnimationFrame(tick);
  }, []);

  const play = useCallback((r: Range) => {
    const a = el.current;
    if (!a) return;
    stop();
    range.current = r;
    setLoops(0);
    const go = () => {
      a.currentTime = r.start / 1000;
      a.playbackRate = rate;
      a.volume = 0;
      a.play().then(() => { setPlaying(true); raf.current = requestAnimationFrame(tick); })
        .catch((e) => setError(`kan ikke spille av: ${e.message}`));
    };
    if (a.readyState >= 1) go();
    else a.addEventListener('loadedmetadata', go, { once: true });
  }, [rate, stop, tick]);

  const toggleRate = useCallback(() => {
    setRate((r) => {
      const next = r === 1 ? 0.75 : 1;
      if (el.current) el.current.playbackRate = next;
      return next;
    });
  }, []);

  const togglePause = useCallback(() => {
    const a = el.current;
    if (!a) return;
    if (playing) stop();
    else play(range.current);
  }, [playing, play, stop]);

  return { play, stop, togglePause, toggleRate, playing, posMs, rate, loops, error, duration, range: range.current };
}
