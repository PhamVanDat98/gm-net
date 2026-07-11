/**
 * M4 task 4.5: visual smoothing — render transform đuổi theo simulation
 * transform, snap khi teleport, góc đi đường ngắn (wrap).
 */
import { describe, expect, it } from 'vitest';
import { TransformSmoother } from '../src/index.js';

describe('TransformSmoother', () => {
  it('update đầu tiên snap thẳng vào target', () => {
    const s = new TransformSmoother();
    const out = s.update({ posX: 3, posY: -2, rot: 1 }, 16);
    expect(out).toEqual({ posX: 3, posY: -2, rot: 1 });
  });

  it('correction nhỏ được trải mượt: tiến dần về target, không nhảy', () => {
    const s = new TransformSmoother({ tauMs: 80 });
    s.update({ posX: 0, posY: 0, rot: 0 }, 16);
    // Simulation nhảy 0.5m (correction) — render đuổi theo từng frame
    let prev = 0;
    let cur = s.update({ posX: 0.5, posY: 0, rot: 0 }, 16);
    const firstStep = cur.posX;
    expect(firstStep).toBeGreaterThan(0);
    expect(firstStep).toBeLessThan(0.5); // không snap
    for (let i = 0; i < 40; i++) {
      prev = cur.posX;
      cur = s.update({ posX: 0.5, posY: 0, rot: 0 }, 16);
      expect(cur.posX).toBeGreaterThanOrEqual(prev); // đơn điệu tiến về target
    }
    expect(cur.posX).toBeCloseTo(0.5, 3); // hội tụ sau ~0.6s
  });

  it('lệch vượt teleportDistance → snap, không kéo lê', () => {
    const s = new TransformSmoother({ teleportDistance: 3 });
    s.update({ posX: 0, posY: 0, rot: 0 }, 16);
    const out = s.update({ posX: 10, posY: 10, rot: 0 }, 16);
    expect(out.posX).toBe(10);
    expect(out.posY).toBe(10);
  });

  it('góc đi đường ngắn nhất qua wrap 2π', () => {
    const s = new TransformSmoother({ tauMs: 80 });
    s.update({ posX: 0, posY: 0, rot: 0.1 }, 16);
    // target 2π - 0.1 ≈ ngay "phía sau" 0.1 → phải đi lùi qua 0, không vòng cả vòng
    const out = s.update({ posX: 0, posY: 0, rot: Math.PI * 2 - 0.1 }, 16);
    expect(out.rot).toBeLessThan(0.1);
  });

  it('reset → update sau snap lại', () => {
    const s = new TransformSmoother();
    s.update({ posX: 0, posY: 0, rot: 0 }, 16);
    s.reset();
    expect(s.current).toBeUndefined();
    expect(s.update({ posX: 1, posY: 1, rot: 0 }, 16).posX).toBe(1);
  });
});
