import { useCallback, useEffect, useMemo, useState } from 'react';
import { renderSVG } from 'uqr';
import {
  PLATFORM_NAMES,
  lastSeenText,
  listDevices,
  pair,
  revokeDevice,
  type DeviceInfo,
  type Hub,
  type Pairing,
} from './devices';
import { CloseIcon, PlusIcon } from './icons';

/** Настройки → Устройства: кто подключён к хабу, «+ Добавить» (QR и код), «Отключить». */
export function DevicesSection({ hub, onSelfRevoked }: { hub: Hub; onSelfRevoked: () => void }) {
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await listDevices(hub);
      setDevices(r.devices);
      setCurrent(r.current);
      setError(null);
      return r.devices;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Хаб недоступен');
      return null;
    }
  }, [hub]);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (d: DeviceInfo): Promise<void> => {
    if (confirming !== d.id) {
      setConfirming(d.id);
      return;
    }
    setConfirming(null);
    try {
      await revokeDevice(hub, d.id);
      if (d.id === current) onSelfRevoked();
      else await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не получилось отключить');
    }
  };

  return (
    <section className="devices" aria-label="Устройства">
      <div className="section-head">
        <h3>Устройства</h3>
        <button className="add-btn" onClick={() => setAdding(true)} data-testid="add-device">
          <PlusIcon />
          Добавить
        </button>
      </div>
      {error && <small className="bad">{error}</small>}
      {devices && devices.length === 0 && (
        <small>
          Устройства подключаются по коду. Этот компьютер работает с ключом администратора.
        </small>
      )}
      <ul className="device-list" data-testid="device-list">
        {devices?.map((d) => (
          <li key={d.id} data-testid="device" data-current={d.id === current || undefined}>
            <div>
              <b>{d.name}</b>
              {d.id === current && <span className="tag">это устройство</span>}
              <small>
                {PLATFORM_NAMES[d.platform] ?? d.platform} · {lastSeenText(d.lastSeenAt)}
              </small>
            </div>
            <button
              className={confirming === d.id ? 'danger-btn confirm' : 'danger-btn'}
              onClick={() => void revoke(d)}
              onBlur={() => setConfirming((c) => (c === d.id ? null : c))}
            >
              {confirming === d.id ? 'Точно отключить?' : 'Отключить'}
            </button>
          </li>
        ))}
      </ul>
      {adding && (
        <PairDialog
          hub={hub}
          reload={load}
          onClose={() => {
            setAdding(false);
            void load();
          }}
        />
      )}
    </section>
  );
}

/** Окно «Добавить устройство»: QR, код и обратный отсчёт; новое устройство появляется само. */
function PairDialog({
  hub,
  reload,
  onClose,
}: {
  hub: Hub;
  reload: () => Promise<DeviceInfo[] | null>;
  onClose: () => void;
}) {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [added, setAdded] = useState<DeviceInfo | null>(null);
  /** Устройства, которые уже были, когда выдали код: новое — то, которого среди них нет. */
  const [knownIds, setKnownIds] = useState<Set<string> | null>(null);

  const fresh = useCallback(async () => {
    setError(null);
    setPairing(null);
    try {
      const before = await reload();
      setKnownIds(new Set((before ?? []).map((d) => d.id)));
      setPairing(await pair(hub));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не получилось получить код');
    }
  }, [hub, reload]);

  useEffect(() => {
    void fresh();
  }, [fresh]);

  // Отсчёт и ожидание нового устройства.
  useEffect(() => {
    if (!pairing || added || !knownIds) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => {
      void reload().then((list) => {
        const fresh = list?.find((d) => !knownIds.has(d.id));
        if (fresh) setAdded(fresh);
      });
    }, 2000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [pairing, added, reload, knownIds]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const qr = useMemo(
    () =>
      pairing
        ? // Чёрным по белому в любой теме: инвертированный QR читают не все камеры.
          renderSVG(pairing.link, { border: 2, ecc: 'M', whiteColor: '#fff', blackColor: '#000' })
        : null,
    [pairing],
  );
  const left = pairing ? Math.max(0, Math.round((pairing.expiresAt - now) / 1000)) : 0;
  const expired = pairing !== null && left === 0;

  return (
    <div className="connect-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="connect pair"
        role="dialog"
        aria-label="Добавить устройство"
        data-testid="pair"
      >
        <div className="panel-head">
          <h2>Добавить устройство</h2>
          <button className="icon-btn" aria-label="Закрыть" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        {added ? (
          <>
            <p className="lead ok" data-testid="pair-done">
              Подключено: <b>{added.name}</b>
            </p>
            <div className="row">
              <button className="primary" onClick={onClose}>
                Готово
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="lead">
              На новом устройстве откройте Kayospace и наведите камеру на QR — или введите адрес
              хаба и код.
            </p>
            {error && <p className="bad">{error}</p>}
            {pairing && qr && (
              <>
                <div
                  className={expired ? 'qr expired' : 'qr'}
                  // SVG собран библиотекой из нашей же ссылки — в нём нет внешнего содержимого.
                  dangerouslySetInnerHTML={{ __html: qr }}
                />
                <div className="code" data-testid="pair-code" data-code={pairing.code}>
                  {pairing.code.slice(0, 3)} {pairing.code.slice(3)}
                </div>
                <p className="muted center">
                  Адрес хаба: <b className="mono">{pairing.hub}</b>
                </p>
                <p className={expired ? 'bad center' : 'muted center'}>
                  {expired
                    ? 'Код истёк.'
                    : `Код одноразовый, действует ещё ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`}
                </p>
              </>
            )}
            {expired && (
              <div className="row center">
                <button className="primary" onClick={() => void fresh()}>
                  Новый код
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
