import { describe, expect, it } from 'vitest';
import { recordingMime } from './voice';

describe('голос', () => {
  it('формат записи: webm/opus, где есть, иначе mp4 (Safari)', () => {
    expect(recordingMime((t) => t.startsWith('audio/webm'))).toBe('audio/webm;codecs=opus');
    expect(recordingMime((t) => t === 'audio/mp4')).toBe('audio/mp4');
    expect(recordingMime(() => false)).toBe('');
  });
});
