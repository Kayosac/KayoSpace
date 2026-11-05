import { useEffect, useRef, useState } from 'react';
import type { AiState } from './ai';
import { chatMessages, clearChat, type ChatMessage } from './chat';
import type { Hub } from './devices';
import { CloseIcon, MicIcon } from './icons';
import { finePointer } from './touch';
import { MAX_VOICE_SECONDS, VoiceRecorder, transcribe, voiceSupported } from './voice';

/**
 * Чат с ИИ на доске (решение 0019): разговор, который помнит прошлые реплики. Ответ с правками
 * доски показывается предпросмотром — «Вставить» в полосе ИИ внизу, как у обычного запроса.
 */
export function ChatPanel({
  hub,
  board,
  ai,
  blocked,
  voice,
  onSend,
  onClose,
}: {
  hub: Hub | null;
  board: string;
  ai: AiState;
  /** null — ИИ доступен; строка — почему нет. */
  blocked: string | null;
  /** Голос включён на хабе. */
  voice: boolean;
  onSend: (text: string) => void;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [rec, setRec] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [recSince, setRecSince] = useState(0);
  const [now, setNow] = useState(Date.now());
  const recorder = useRef<VoiceRecorder | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const running = ai.kind === 'running';

  // Переписка: при открытии и когда ИИ закончил очередной ответ.
  useEffect(() => {
    if (!hub) return;
    let off = false;
    chatMessages(hub, board)
      .then((m) => !off && setMessages(m))
      .catch((e: unknown) => !off && setError(e instanceof Error ? e.message : 'Хаб недоступен'));
    return () => {
      off = true;
    };
  }, [hub, board, ai.kind]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, running]);

  useEffect(() => {
    if (finePointer()) inputRef.current?.focus();
    return () => recorder.current?.cancel();
  }, []);

  useEffect(() => {
    if (rec !== 'recording') return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [rec]);
  const recSeconds = rec === 'recording' ? Math.round((now - recSince) / 1000) : 0;

  const send = (): void => {
    const t = text.trim();
    if (!t || running || blocked) return;
    onSend(t);
    setMessages((m) => [...(m ?? []), { role: 'user', text: t, at: Date.now() }]);
    setText('');
  };

  const toggleVoice = async (): Promise<void> => {
    if (!hub) return;
    if (rec === 'recording') {
      const r = recorder.current;
      recorder.current = null;
      setRec('transcribing');
      try {
        const heard = await transcribe(hub, await r!.stop());
        if (heard) setText((t) => (t.trim() ? `${t.trim()} ${heard}` : heard));
        else setError('Ничего не расслышал — попробуйте ещё раз');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Голос не распознался');
      } finally {
        setRec('idle');
      }
      return;
    }
    setError(null);
    const r = new VoiceRecorder();
    try {
      await r.start();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Микрофон недоступен');
      return;
    }
    recorder.current = r;
    setRecSince(Date.now());
    setNow(Date.now());
    setRec('recording');
  };
  useEffect(() => {
    if (rec === 'recording' && recSeconds >= MAX_VOICE_SECONDS) void toggleVoice();
  }, [rec, recSeconds]);

  return (
    <aside className="panel chat-panel" aria-label="Чат с ИИ" data-testid="chat-panel">
      <div className="panel-head">
        <h2>Чат с ИИ</h2>
        <button
          className="link-btn"
          disabled={!hub || !messages?.length || running}
          onClick={async () => {
            if (!hub) return;
            await clearChat(hub, board).catch(() => {});
            setMessages([]);
          }}
        >
          Новый разговор
        </button>
        <button className="icon-btn" aria-label="Закрыть" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      {!hub && <p className="muted">ИИ работает через хаб — включите синхронизацию.</p>}
      <ul className="chat-list" ref={listRef} data-testid="chat-list">
        {messages?.length === 0 && (
          <li className="muted chat-hint">
            Спросите про доску или попросите что-то сделать: «разложи стикеры по темам», «что я не
            успел на этой неделе?», «нарисуй схему процесса». Помощник помнит разговор.
          </li>
        )}
        {messages?.map((m, i) => (
          <li key={`${m.at}:${i}`} className={`chat-msg ${m.role}${m.error ? ' error' : ''}`}>
            {m.text}
            {!!m.changes && (
              <small>
                {i === messages.length - 1 && ai.kind === 'ready'
                  ? 'Правки — в предпросмотре: «Вставить» внизу'
                  : `Предлагал правок: ${m.changes}`}
              </small>
            )}
          </li>
        ))}
        {running && <li className="chat-msg assistant thinking">Думаю…</li>}
      </ul>
      {(error || blocked) && <p className="bad">{error ?? blocked}</p>}
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          ref={inputRef}
          rows={2}
          value={text}
          placeholder="Сообщение помощнику"
          aria-label="Сообщение помощнику"
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          data-testid="chat-text"
        />
        <div className="row">
          {voice && hub && voiceSupported() && (
            <button
              type="button"
              className={rec === 'recording' ? 'mic recording' : 'mic'}
              aria-label={rec === 'recording' ? 'Остановить запись' : 'Сказать голосом'}
              aria-pressed={rec === 'recording'}
              disabled={rec === 'transcribing'}
              onClick={() => void toggleVoice()}
            >
              <MicIcon />
              {rec === 'recording' && <span>{recSeconds} с · Стоп</span>}
              {rec === 'transcribing' && <span>Распознаю…</span>}
            </button>
          )}
          <button
            type="submit"
            className="primary"
            disabled={!text.trim() || running || !!blocked || rec !== 'idle' || !hub}
            data-testid="chat-send"
          >
            Отправить
          </button>
        </div>
      </form>
    </aside>
  );
}
