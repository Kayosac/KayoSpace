import { describe, expect, it } from 'vitest';
import { boardIdFromName, hubHttpUrl, hubSyncUrl } from './address';
import { isValidBoardId } from './protocol';

describe('адреса хаба', () => {
  it('HTTP-адрес по тому же вводу, что и синхронизация', () => {
    expect(hubHttpUrl('192.168.1.10')).toBe('http://192.168.1.10:4000');
    expect(hubHttpUrl('1-2-3-4.sslip.io:8443')).toBe('https://1-2-3-4.sslip.io:8443');
    expect(hubHttpUrl('https://hub.example.com/')).toBe('https://hub.example.com');
    expect(hubHttpUrl('')).toBeNull();
    expect(hubSyncUrl('hub.example.com', 'main', 't')).toBe(
      'wss://hub.example.com/sync/main?token=t',
    );
  });

  it('id доски из русского названия — латиницей и годится для хаба', () => {
    const id = boardIdFromName('План на неделю!', 1_700_000_000_000);
    expect(id.startsWith('plan-na-nedelyu-')).toBe(true);
    expect(isValidBoardId(id)).toBe(true);
    expect(boardIdFromName('🙂', 1).startsWith('board-')).toBe(true);
    expect(isValidBoardId(boardIdFromName('x'.repeat(200)))).toBe(true);
  });
});
