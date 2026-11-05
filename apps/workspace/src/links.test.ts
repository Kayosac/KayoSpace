import { describe, expect, it } from 'vitest';
import { parseBoardLink, parseConnectLink } from './devices';

describe('ссылки kayospace://', () => {
  it('ссылка на доску — от агента', () => {
    expect(parseBoardLink('kayospace://board/plan')).toEqual({ board: 'plan', element: null });
    expect(parseBoardLink('kayospace://board/plan?element=01ABC')).toEqual({
      board: 'plan',
      element: '01ABC',
    });
    // На части платформ «board» оказывается в пути, а не в host.
    expect(parseBoardLink('kayospace:///board/e2e-find-a')).toEqual({
      board: 'e2e-find-a',
      element: null,
    });
  });

  it('чужое и опасное — не ссылка на доску', () => {
    expect(parseBoardLink('https://board/plan')).toBeNull();
    expect(parseBoardLink('kayospace://board/a%2F..%2Fb')).toBeNull();
    expect(parseBoardLink('kayospace://board/_workspace')).toBeNull();
    expect(parseBoardLink('kayospace://connect?hub=x&code=123456')).toBeNull();
    expect(parseConnectLink('kayospace://board/plan')).toBeNull();
  });
});
