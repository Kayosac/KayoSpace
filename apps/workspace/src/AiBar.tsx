import { useEffect, useRef, useState } from 'react';
import { AI_ACTION_NAMES, type AiState } from './ai';
import type { Hub } from './devices';
import { MicIcon, SparkleIcon } from './icons';
import { finePointer } from './touch';
import { MAX_VOICE_SECONDS, VoiceRecorder, transcribe, voiceSupported } from './voice';

/** Сколько секунд идёт задача — тикает раз в секунду, пока она идёт. */
function useSeconds(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  return since === null ? 0 : Math.max(0, Math.round((now - since) / 1000));
}

const changesText = (n: number): string => {
  const m10 = n % 10;
  const m100 = n % 100;
  const word =
    m10 === 1 && m100 !== 11
      ? 'правка'
      : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)
        ? 'правки'
        : 'правок';
  return `${n} ${word}`;
};

/**
 * Полоса ИИ над панелью инструментов: свой запрос (Ctrl/⌘ J), ход задачи, результат
 * с кнопками «Вставить» и «Отменить».
 */
export function AiBar({
  state,
  promptOpen,
  scope,
  onPrompt,
  onClosePrompt,
  onApply,
  onDiscard,
  voiceHub,
}: {
  state: AiState;
  promptOpen: boolean;
  /** О чём будет запрос: «про выделенное (3)» или «про видимую часть доски». */
  scope: string;
  onPrompt: (text: string) => void;
  onClosePrompt: () => void;
  onApply: () => void;
  onDiscard: () => void;
  /** Хаб с голосом (ключ OpenAI на хабе); null — кнопки микрофона нет. */
  voiceHub: Hub | null;
}) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const recStart = useRef<number | null>(null);
  const seconds = useSeconds(state.kind === 'running' ? state.startedAt : null);
  // Голос (решение 0018): запись → хаб → текст в поле запроса.
  const [voice, setVoice] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const recorder = useRef<VoiceRecorder | null>(null);
  const recSeconds = useSeconds(voice === 'recording' ? recStart.current : null);

  // Курсор в поле — только при мыши: на планшете иначе вылезает клавиатура (а можно и голосом).
  useEffect(() => {
    if (promptOpen && finePointer()) inputRef.current?.focus();
  }, [promptOpen]);

  // Закрыли запрос — запись выбрасываем.
  useEffect(() => {
    if (promptOpen) return;
    recorder.current?.cancel();
    recorder.current = null;
    setVoice('idle');
    setVoiceError(null);
  }, [promptOpen]);

  const stopVoice = async (): Promise<void> => {
    const r = recorder.current;
    if (!r || !voiceHub) return;
    recorder.current = null;
    setVoice('transcribing');
    try {
      const audio = await r.stop();
      const heard = await transcribe(voiceHub, audio);
      if (heard) setText((t) => (t.trim() ? `${t.trim()} ${heard}` : heard));
      else setVoiceError('Ничего не расслышал — попробуйте ещё раз');
    } catch (e) {
      setVoiceError(e instanceof Error ? e.message : 'Голос не распознался');
    } finally {
      setVoice('idle');
    }
  };

  const startVoice = async (): Promise<void> => {
    if (!voiceHub) return;
    setVoiceError(null);
    const r = new VoiceRecorder();
    try {
      await r.start();
    } catch (e) {
      setVoiceError(e instanceof Error ? e.message : 'Микрофон недоступен');
      return;
    }
    recorder.current = r;
    recStart.current = Date.now();
    setVoice('recording');
  };

  // Забыли остановить — останавливаем сами.
  useEffect(() => {
    if (voice === 'recording' && recSeconds >= MAX_VOICE_SECONDS) void stopVoice();
  }, [voice, recSeconds]);

  if (state.kind === 'running') {
    return (
      <div className="ai-bar" role="status" data-testid="ai-bar" data-state="running">
        <span className="ai-spark spinning">
          <SparkleIcon />
        </span>
        <span className="ai-text">
          {state.waitingWorker
            ? 'Жду исполнителя ИИ — он не на связи…'
            : `ИИ думает: ${AI_ACTION_NAMES[state.action].toLowerCase()}…`}
          <span className="ai-muted"> {seconds} с</span>
        </span>
        <button onClick={onDiscard}>Отмена</button>
      </div>
    );
  }

  if (state.kind === 'ready') {
    return (
      <div className="ai-bar" role="status" data-testid="ai-bar" data-state="ready">
        <span className="ai-spark">
          <SparkleIcon />
        </span>
        <span className="ai-text">
          {state.message}
          {state.changes > 0 && <span className="ai-muted"> · {changesText(state.changes)}</span>}
        </span>
        {state.changes > 0 ? (
          <>
            <button onClick={onDiscard}>Отменить</button>
            <button className="primary" onClick={onApply}>
              Вставить
            </button>
          </>
        ) : (
          <button onClick={onDiscard}>Закрыть</button>
        )}
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="ai-bar error" role="alert" data-testid="ai-bar" data-state="error">
        <span className="ai-text">{state.message}</span>
        <button onClick={onDiscard}>Закрыть</button>
      </div>
    );
  }

  if (!promptOpen) return null;
  const send = (): void => {
    const t = text.trim();
    if (!t) return;
    onPrompt(t);
    setText('');
  };
  return (
    <form
      className="ai-bar prompt"
      data-testid="ai-prompt"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <span className="ai-spark">
        <SparkleIcon />
      </span>
      <textarea
        ref={inputRef}
        rows={1}
        value={text}
        placeholder={`Попросите ИИ — ${scope}`}
        aria-label="Запрос к ИИ"
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClosePrompt();
          } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      {voiceHub && voiceSupported() && (
        <button
          type="button"
          className={voice === 'recording' ? 'mic recording' : 'mic'}
          aria-label={voice === 'recording' ? 'Остановить запись' : 'Сказать голосом'}
          aria-pressed={voice === 'recording'}
          disabled={voice === 'transcribing'}
          onClick={() => void (voice === 'recording' ? stopVoice() : startVoice())}
          data-testid="ai-mic"
        >
          <MicIcon />
          {voice === 'recording' && <span>{recSeconds} с · Стоп</span>}
          {voice === 'transcribing' && <span>Распознаю…</span>}
        </button>
      )}
      {voiceError && (
        <span className="ai-muted voice-error" role="alert">
          {voiceError}
        </span>
      )}
      <button type="button" onClick={onClosePrompt}>
        Закрыть
      </button>
      <button type="submit" className="primary" disabled={!text.trim() || voice !== 'idle'}>
        Спросить
      </button>
    </form>
  );
}
