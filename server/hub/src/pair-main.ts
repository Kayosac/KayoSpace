/**
 * Подключить устройство к хабу: печатает QR и 6-значный код прямо в терминале.
 *
 *   На сервере:   docker compose exec hub pnpm pair
 *   Локально:     pnpm pair            (хаб из `pnpm hub` на этом компьютере)
 *
 * Обращается к уже запущенному хабу по 127.0.0.1 с ключом администратора HUB_TOKEN (из окружения).
 * Переменные: PORT (4000), HUB_TOKEN, HUB_LOCAL_URL (адрес хаба, если он не на 127.0.0.1:PORT).
 */

import { formatCode, requestPairing, terminalQr } from './pair';

const port = Number(process.env.PORT ?? 4000);
const hubUrl = process.env.HUB_LOCAL_URL?.trim() || `http://127.0.0.1:${port}`;
const token = process.env.HUB_TOKEN?.trim() ?? '';

try {
  const p = await requestPairing(hubUrl, token);
  // Часы сервера могут быть в другом поясе — показываем срок в минутах.
  const minutes = Math.max(1, Math.round((p.expiresAt - Date.now()) / 60_000));
  console.log('');
  console.log(terminalQr(p.link));
  console.log('');
  console.log('Наведите камеру планшета на QR или откройте в приложении');
  console.log('«Подключение к хабу» и введите:');
  console.log('');
  console.log(`  Адрес хаба:  ${p.hub}`);
  console.log(`  Код:         ${formatCode(p.code)}   (одноразовый, действует ${minutes} мин)`);
  console.log('');
  console.log(`Ссылка: ${p.link}`);
} catch (err) {
  console.error(`Не получилось выдать код: ${(err as Error).message}`);
  process.exit(1);
}
