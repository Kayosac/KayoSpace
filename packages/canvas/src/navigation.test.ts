import { describe, expect, it } from 'vitest';
import { isWheelNotch } from './navigation';

describe('колесо мыши или трекпад', () => {
  it('щелчок колеса — плавно', () => {
    expect(isWheelNotch({ deltaMode: 0, deltaX: 0, deltaY: 100, wheelDeltaY: -120 })).toBe(true);
    expect(isWheelNotch({ deltaMode: 0, deltaX: 0, deltaY: -125, wheelDeltaY: 120 })).toBe(true);
    expect(isWheelNotch({ deltaMode: 1, deltaX: 0, deltaY: 3 })).toBe(true); // Firefox: строки
  });

  it('трекпад — сразу', () => {
    expect(isWheelNotch({ deltaMode: 0, deltaX: 0, deltaY: 4.2, wheelDeltaY: -12 })).toBe(false);
    expect(isWheelNotch({ deltaMode: 0, deltaX: 3, deltaY: 60, wheelDeltaY: -180 })).toBe(false);
    expect(isWheelNotch({ deltaMode: 0, deltaX: 0, deltaY: 57.3, wheelDeltaY: -171 })).toBe(false);
  });
});
