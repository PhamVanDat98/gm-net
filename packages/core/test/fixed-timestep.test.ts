import { describe, expect, it } from 'vitest';
import { FixedTimestep } from '../src/index.js';

const STEP = 1000 / 30;

describe('FixedTimestep', () => {
  it('chạy đúng số bước theo thời gian tích lũy', () => {
    const loop = new FixedTimestep({ stepMs: 10 });
    const ticks: number[] = [];
    expect(loop.advance(35, (t) => ticks.push(t))).toBe(3);
    expect(ticks).toEqual([0, 1, 2]);
    expect(loop.tick).toBe(3);
    expect(loop.alpha).toBeCloseTo(0.5);
  });

  it('tích lũy phần dư qua nhiều lần advance', () => {
    const loop = new FixedTimestep({ stepMs: STEP });
    let steps = 0;
    // 16.67ms mỗi frame (60fps render) → trung bình 1 bước sim mỗi 2 frame
    for (let i = 0; i < 60; i++) {
      steps += loop.advance(1000 / 60, () => {});
    }
    expect(steps).toBe(30);
  });

  it('alpha nằm trong [0, 1) và phản ánh phần bước dở dang', () => {
    const loop = new FixedTimestep({ stepMs: 100 });
    loop.advance(150, () => {});
    expect(loop.alpha).toBeCloseTo(0.5);
    expect(loop.alpha).toBeGreaterThanOrEqual(0);
    expect(loop.alpha).toBeLessThan(1);
  });

  it('clamp số bước và bỏ backlog để tránh spiral of death', () => {
    const loop = new FixedTimestep({ stepMs: 100, maxStepsPerAdvance: 5 });
    const ran = loop.advance(2000, () => {});
    expect(ran).toBe(5);
    expect(loop.alpha).toBeLessThan(1);
    // Lần advance sau không được "trả nợ" backlog đã bỏ
    expect(loop.advance(100, () => {})).toBe(1);
  });

  it('từ chối stepMs không hợp lệ', () => {
    expect(() => new FixedTimestep({ stepMs: 0 })).toThrow(RangeError);
    expect(() => new FixedTimestep({ stepMs: -1 })).toThrow(RangeError);
  });
});
