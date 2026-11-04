/**
 * Идентификаторы в духе ULID: 10 символов времени + 16 случайных, Crockford base32.
 * Сортируются по времени создания, не требуют координации между устройствами.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newId(now: number = Date.now()): string {
  let time = '';
  let t = Math.floor(now);
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let rand = '';
  for (const b of bytes) rand += ALPHABET[b % 32];
  return time + rand;
}
