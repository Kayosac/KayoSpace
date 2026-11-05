/**
 * Голос для ИИ в приложении (решение 0018): запись с микрофона (MediaRecorder) уходит на хаб,
 * хаб распознаёт её через OpenAI и возвращает текст. Ключ OpenAI живёт только на хабе.
 */

import { useEffect, useState } from 'react';
import { hubHttpUrl } from '@kayospace/sync';
import { hubCall, type Hub } from './devices';

/** Дольше — запись останавливается сама (забыли нажать «Стоп»). */
export const MAX_VOICE_SECONDS = 90;

export function voiceSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined'
  );
}

/** Формат записи: webm/opus (Chrome, Android), иначе mp4 (Safari, macOS). */
export function recordingMime(isSupported: (t: string) => boolean): string {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'])
    if (isSupported(t)) return t;
  return '';
}

/** Что умеет хаб: картинки генератором и голос — только с ключом OpenAI на хабе. */
export function useHubFeatures(hub: Hub | null): { imageGen: boolean; voice: boolean } {
  const [f, setF] = useState({ imageGen: false, voice: false });
  useEffect(() => {
    if (!hub) return setF({ imageGen: false, voice: false });
    let off = false;
    const check = (): void => {
      hubCall<{ imageGen?: boolean; voice?: boolean }>(fetch, hub.url, '/api/features', {
        token: hub.token,
      })
        .then((r) => !off && setF({ imageGen: !!r.imageGen, voice: !!r.voice }))
        .catch(() => {});
    };
    check();
    // Ключ OpenAI могли добавить на хаб, пока приложение открыто, — проверяем, вернувшись в него.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      off = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [hub?.url, hub?.token]);
  return f;
}

export class VoiceRecorder {
  private rec: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private done: ((b: Blob) => void) | null = null;

  async start(): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = (err as { name?: string }).name;
      throw new Error(
        name === 'NotAllowedError'
          ? 'Нет доступа к микрофону — разрешите его в настройках системы'
          : 'Микрофон не нашёлся',
      );
    }
    const mime = recordingMime((t) => MediaRecorder.isTypeSupported(t));
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.onstop = () => {
      const blob = new Blob(this.chunks, { type: this.rec?.mimeType || mime || 'audio/webm' });
      this.release();
      this.done?.(blob);
    };
    this.rec.start(250);
  }

  /** Остановить и получить запись. */
  stop(): Promise<Blob> {
    return new Promise((resolve) => {
      this.done = resolve;
      if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
      else resolve(new Blob());
    });
  }

  cancel(): void {
    this.done = null;
    if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
    this.release();
  }

  private release(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

/** Распознать запись на хабе. */
export async function transcribe(hub: Hub, audio: Blob): Promise<string> {
  const base = hubHttpUrl(hub.url);
  if (!base) throw new Error('Неверный адрес хаба');
  let res: Response;
  try {
    res = await fetch(`${base}/api/voice`, {
      method: 'POST',
      headers: {
        'Content-Type': audio.type || 'audio/webm',
        ...(hub.token ? { Authorization: `Bearer ${hub.token}` } : {}),
      },
      body: audio,
    });
  } catch {
    throw new Error('Хаб не отвечает');
  }
  const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!res.ok) throw new Error(body.error ?? `Хаб ответил ${res.status}`);
  return (body.text ?? '').trim();
}
