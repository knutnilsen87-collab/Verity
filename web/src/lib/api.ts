// All trafikk går til Verity-tjenesten på samme adresse. Tjenesten snakker med
// talemotoren; nettleseren gjør det aldri.
import type { Recording, Ttu } from './search';

export type Status = 'queued' | 'transcribing' | 'ready' | 'failed';
export interface RecordingInfo {
  id: string; name: string; kind: 'lyd' | 'video'; theme: string; file: string; duration_ms: number; status: Status;
  error: string; speaker: string; hotwords: string; model: string; created: number; processing_seconds: number;
  ttu_count: number; revision_count: number; verified_count: number; speakers: string[]; sha256: string;
}
export interface Revision { field: 'text' | 'speaker'; old: string; new: string; actor: string; ts: number; audit_seq: number }
export interface Verification { actor: string; ts: number; detail: { loops?: number; slowest_rate?: number; listened_ms?: number } }
export interface AuditStatus { ok: boolean; entries: number; broken_at: number | null; head?: string }
export interface Health { version: string; engine: { ok: boolean; model?: string; device?: string; error?: string } }

async function json<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let detail = `${r.status}`;
    try { detail = (await r.json()).detail ?? detail; } catch { /* ikke JSON */ }
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return r.json() as Promise<T>;
}

export const api = {
  health: () => fetch('/api/health').then((r) => json<Health>(r)),
  library: () => fetch('/api/library').then((r) => json<{ recordings: Recording[] }>(r)).then((d) => d.recordings),
  recordings: () => fetch('/api/recordings').then((r) => json<{ recordings: RecordingInfo[] }>(r)).then((d) => d.recordings),
  edit: (id: string, body: { name?: string; theme?: string; speakers?: Record<string, string> }) =>
    fetch(`/api/recordings/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => json<RecordingInfo>(r)),
  setSpeaker: (id: string, idx: number, speaker: string) =>
    fetch(`/api/recordings/${id}/ttus/${idx}/speaker`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ speaker }) })
      .then((r) => json(r)),
  setText: (id: string, idx: number, text: string) =>
    fetch(`/api/recordings/${id}/ttus/${idx}/text`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
      .then((r) => json<{ ok: boolean; changed: boolean }>(r)),
  ttu: (id: string, idx: number) => fetch(`/api/recordings/${id}/ttus/${idx}`).then((r) => json<Ttu>(r)),
  verify: (id: string, idx: number, body: { text: string; full_playback: boolean; loops: number; slowest_rate: number; listened_ms: number }) =>
    fetch(`/api/recordings/${id}/ttus/${idx}/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => json<Ttu>(r)),
  revisions: (id: string, idx: number) =>
    fetch(`/api/recordings/${id}/ttus/${idx}/revisions`).then((r) => json<{ text_raw: string; speaker_raw: string; revisions: Revision[]; verifications: Verification[] }>(r)),
  checkFile: (id: string) =>
    fetch(`/api/recordings/${id}/check-file`, { method: 'POST' })
      .then((r) => json<{ ok: boolean; expected: string; actual: string; first_check: boolean }>(r)),
  audit: () => fetch('/api/audit?limit=1').then((r) => json<{ verify: AuditStatus }>(r)).then((d) => d.verify),
  retry: (id: string) => fetch(`/api/recordings/${id}/retry`, { method: 'POST' }).then((r) => json<RecordingInfo>(r)),
  remove: (id: string) => fetch(`/api/recordings/${id}`, { method: 'DELETE' }).then((r) => json(r)),
  peaks: (id: string, from: number, to: number, n: number) =>
    fetch(`/api/recordings/${id}/peaks?from_ms=${Math.round(from)}&to_ms=${Math.round(to)}&n=${n}`)
      .then((r) => json<{ bars: number[] }>(r)).then((d) => d.bars),
  mediaUrl: (id: string) => `/api/recordings/${id}/media`,

  /** Laster opp med fremdrift (fetch kan ikke vise opplasting). */
  upload(file: File, meta: { name: string; theme: string; speaker: string; hotwords: string }, onProgress: (f: number) => void) {
    return new Promise<RecordingInfo>((resolve, reject) => {
      const q = new URLSearchParams({ filename: file.name, ...meta });
      const x = new XMLHttpRequest();
      x.open('POST', `/api/recordings?${q}`);
      x.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      x.onload = () => {
        if (x.status === 201) resolve(JSON.parse(x.responseText));
        else {
          let msg = `opplastingen feilet (${x.status})`;
          try { msg = JSON.parse(x.responseText).detail ?? msg; } catch { /* ikke JSON */ }
          reject(new Error(msg));
        }
      };
      x.onerror = () => reject(new Error('Verity-tjenesten svarer ikke'));
      x.send(file);
    });
  },
};
