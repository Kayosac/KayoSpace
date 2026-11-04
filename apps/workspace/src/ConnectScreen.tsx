import { useEffect, useRef, useState, type FormEvent } from 'react';
import { hubHttpUrl } from '@kayospace/sync';
import type { Connection } from './connection';
import { PLATFORM_NAMES, normalizeCode, parseConnectLink } from './devices';
import { CloseIcon, ScanIcon } from './icons';

export type ConnectReason = 'first' | 'revoked' | 'link' | 'manual';

const LEAD: Record<ConnectReason, string> = {
  first: 'Чтобы доски были на всех устройствах, подключите это устройство к хабу.',
  revoked:
    'Хаб больше не пускает это устройство: его отключили или ключ устарел. Подключите заново.',
  link: 'Проверьте адрес хаба и подтвердите подключение.',
  manual: 'Подключите это устройство к хабу.',
};

/** Можно ли сканировать QR камерой (сканер есть в приложении на Android и iOS). */
const canScan = (platform: string): boolean => platform === 'android' || platform === 'ios';

/**
 * Экран «Подключение к хабу»: адрес хаба (заполнен адресом по умолчанию) и 6 цифр.
 * Код показывает уже подключённое устройство (Настройки → Устройства → «+ Добавить») или `pnpm pair` на сервере.
 */
export function ConnectScreen({
  connection,
  reason,
  initialHub,
  initialCode,
  onDone,
  onSkip,
}: {
  connection: Connection;
  reason: ConnectReason;
  initialHub: string;
  initialCode?: string | null;
  onDone: () => void;
  onSkip: () => void;
}) {
  const platform = connection.platform;
  const [hub, setHub] = useState(initialHub);
  const [code, setCode] = useState(initialCode ?? '');
  const [name, setName] = useState(PLATFORM_NAMES[platform] ?? 'Устройство');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const submitted = useRef(false);

  const hubOk = hubHttpUrl(hub) !== null;
  const digits = normalizeCode(code);

  const submit = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault();
    if (!hubOk || !digits || busy) return;
    setBusy(true);
    setError(null);
    try {
      await connection.connect(hub, digits, name || PLATFORM_NAMES[platform] || 'Устройство');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не получилось подключиться');
      setCode('');
      codeRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  // Пришли по ссылке из QR — адрес и код уже есть, подключаемся сразу.
  useEffect(() => {
    if (reason === 'link' && initialCode && hubOk && !submitted.current) {
      submitted.current = true;
      void submit();
    }
    // Один раз при открытии по ссылке.
  }, []);

  useEffect(() => {
    if (hubOk && !initialCode) codeRef.current?.focus();
    // Только при открытии.
  }, []);

  const scanQr = async (): Promise<void> => {
    setError(null);
    try {
      const { scan, Format, checkPermissions, requestPermissions } =
        await import('@tauri-apps/plugin-barcode-scanner');
      let perm = await checkPermissions();
      if (perm !== 'granted') perm = await requestPermissions();
      if (perm !== 'granted') {
        setError('Нет доступа к камере. Разрешите его в настройках Android или введите код.');
        return;
      }
      const { content } = await scan({ windowed: false, formats: [Format.QRCode] });
      const link = parseConnectLink(content);
      if (!link) {
        setError('Это не QR подключения Kayospace.');
        return;
      }
      setHub(link.hub);
      if (link.code) {
        setCode(link.code);
        setBusy(true);
        try {
          await connection.connect(link.hub, link.code, name || PLATFORM_NAMES[platform] || '');
          onDone();
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Не получилось подключиться');
          setCode('');
        } finally {
          setBusy(false);
        }
      }
    } catch (err) {
      // Отмена сканирования — не ошибка.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/cancel/i.test(msg)) setError(`Сканер не открылся: ${msg}`);
    }
  };

  return (
    <div className="connect-backdrop" data-testid="connect-screen">
      <form className="connect" onSubmit={(e) => void submit(e)} aria-label="Подключение к хабу">
        <div className="panel-head">
          <h2>Подключение к хабу</h2>
          <button type="button" className="icon-btn" aria-label="Закрыть" onClick={onSkip}>
            <CloseIcon />
          </button>
        </div>
        <p className={reason === 'revoked' ? 'lead bad' : 'lead'}>{LEAD[reason]}</p>

        {canScan(platform) && (
          <>
            <button
              type="button"
              className="scan-btn"
              onClick={() => void scanQr()}
              disabled={busy}
            >
              <ScanIcon />
              Сканировать QR
            </button>
            <p className="or">
              <span>или введите код</span>
            </p>
          </>
        )}

        <label className="field">
          <span>Адрес хаба</span>
          <input
            value={hub}
            onChange={(e) => setHub(e.target.value)}
            placeholder="например, 1-2-3-4.sslip.io:8443"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            inputMode="url"
            data-testid="connect-hub"
          />
          {hub.trim() && !hubOk && <small className="bad">Адрес не похож на адрес хаба.</small>}
        </label>
        <label className="field">
          <span>Код подключения</span>
          <input
            ref={codeRef}
            className="code-input"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^\d\s-]/g, '').slice(0, 7))}
            placeholder="000 000"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            data-testid="connect-code"
          />
          <small>
            На подключённом устройстве: Настройки → Устройства → «+ Добавить». Код действует 5
            минут.
          </small>
        </label>
        <label className="field">
          <span>Имя этого устройства</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            data-testid="connect-name"
          />
        </label>
        {error && (
          <p className="bad" role="alert" data-testid="connect-error">
            {error}
          </p>
        )}
        <div className="row">
          <button
            type="submit"
            className="primary"
            disabled={!hubOk || !digits || busy}
            data-testid="connect-submit"
          >
            {busy ? 'Подключаю…' : 'Подключить'}
          </button>
          <button type="button" className="link-btn" onClick={onSkip}>
            Пока без хаба
          </button>
        </div>
      </form>
    </div>
  );
}
