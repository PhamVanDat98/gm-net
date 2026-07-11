/**
 * M4 task 4.6: metrics prediction — misprediction/s theo cửa sổ trượt + biên độ.
 */
import { describe, expect, it } from 'vitest';
import { PredictionMetrics } from '../src/index.js';

describe('PredictionMetrics', () => {
  it('chưa có correction → rate 0, magnitude NaN', () => {
    const m = new PredictionMetrics();
    const snap = m.read(1000);
    expect(snap.corrections).toBe(0);
    expect(snap.correctionsPerSecond).toBe(0);
    expect(Number.isNaN(snap.lastMagnitude)).toBe(true);
    expect(Number.isNaN(snap.maxMagnitude)).toBe(true);
  });

  it('đếm rate trong cửa sổ trượt, correction cũ rơi ra', () => {
    const m = new PredictionMetrics({ windowMs: 1000 });
    m.onCorrection(0.1, 100);
    m.onCorrection(0.2, 500);
    m.onCorrection(0.05, 900);
    expect(m.read(1000).correctionsPerSecond).toBe(3);
    expect(m.read(1400).correctionsPerSecond).toBe(2); // mốc 100 đã rơi
    expect(m.read(2000).correctionsPerSecond).toBe(0);
    expect(m.read(2000).corrections).toBe(3); // tổng trọn đời giữ nguyên
  });

  it('theo dõi last/max magnitude', () => {
    const m = new PredictionMetrics();
    m.onCorrection(0.3, 0);
    m.onCorrection(0.1, 10);
    const snap = m.read(20);
    expect(snap.lastMagnitude).toBe(0.1);
    expect(snap.maxMagnitude).toBe(0.3);
  });
});
