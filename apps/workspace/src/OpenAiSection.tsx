import { useEffect, useState } from 'react';
import { hubCall, type Hub } from './devices';

type Kind = 'images' | 'voice' | 'handwriting';

interface OpenAiInfo {
  limits: Record<Kind, number>;
  handwriting: boolean;
  usage: Record<Kind, { used: number; limit: number }>;
}

const ROWS: { kind: Kind; name: string; hint: string }[] = [
  { kind: 'images', name: 'Картинки «нарисуй»', hint: '~$0.05 за картинку' },
  { kind: 'voice', name: 'Голосовые запросы', hint: '~$0.005 за минуту' },
  { kind: 'handwriting', name: 'Фрагменты рукописного', hint: 'доли цента за фрагмент' },
];

/**
 * Настройки → OpenAI (решение 0019): сколько потрачено сегодня, дневные лимиты и выключатель
 * распознавания рукописного. Хранится на хабе — менять сервер руками не нужно.
 * Показывается, только если на хабе есть ключ OpenAI.
 */
export function OpenAiSection({ hub }: { hub: Hub }) {
  const [info, setInfo] = useState<OpenAiInfo | null>(null);
  const [draft, setDraft] = useState<Record<Kind, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [missing, setMissing] = useState(false);

  const apply = (i: OpenAiInfo): void => {
    setInfo(i);
    setDraft({
      images: String(i.limits.images),
      voice: String(i.limits.voice),
      handwriting: String(i.limits.handwriting),
    });
  };

  useEffect(() => {
    let off = false;
    hubCall<OpenAiInfo>(fetch, hub.url, '/api/openai', { token: hub.token })
      .then((i) => !off && apply(i))
      .catch(() => !off && setMissing(true));
    return () => {
      off = true;
    };
  }, [hub]);

  if (missing || !info || !draft) return null;

  const save = async (patch: { limits?: Partial<Record<Kind, number>>; handwriting?: boolean }) => {
    setError(null);
    setSaved(false);
    try {
      apply(
        await hubCall<OpenAiInfo>(fetch, hub.url, '/api/openai', {
          method: 'PUT',
          token: hub.token,
          body: patch,
        }),
      );
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не сохранилось');
    }
  };

  const changed = ROWS.some((r) => Number(draft[r.kind]) !== info.limits[r.kind]);

  return (
    <section className="openai" data-testid="openai-settings">
      <h3 className="section-title">OpenAI — лимиты на сутки</h3>
      <p className="muted">
        Сверх лимита запрос в OpenAI не уходит — до завтра. Ещё надёжнее: пополнять баланс OpenAI
        заранее, без автопополнения.
      </p>
      <ul className="openai-limits">
        {ROWS.map((r) => (
          <li key={r.kind}>
            <span>
              {r.name}
              <small>
                сегодня {info.usage[r.kind].used} · {r.hint}
              </small>
            </span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              value={draft[r.kind]}
              aria-label={`Лимит: ${r.name}`}
              data-testid={`limit-${r.kind}`}
              onChange={(e) => {
                setSaved(false);
                setDraft({ ...draft, [r.kind]: e.currentTarget.value });
              }}
            />
          </li>
        ))}
      </ul>
      <div className="row">
        <button
          className="primary"
          disabled={!changed}
          onClick={() =>
            void save({
              limits: Object.fromEntries(ROWS.map((r) => [r.kind, Number(draft[r.kind])])),
            })
          }
          data-testid="save-limits"
        >
          Сохранить лимиты
        </button>
        {saved && <small className="good">Сохранено</small>}
      </div>
      {error && <p className="bad">{error}</p>}
      <label className="check">
        <input
          type="checkbox"
          checked={info.handwriting}
          onChange={(e) => void save({ handwriting: e.currentTarget.checked })}
          data-testid="handwriting-toggle"
        />
        <span>
          Распознавать рукописное
          <small>
            Хаб сам читает написанное пером — его находит поиск и видят агенты. Выключено — новые
            записи не распознаются, уже распознанное остаётся.
          </small>
        </span>
      </label>
    </section>
  );
}
