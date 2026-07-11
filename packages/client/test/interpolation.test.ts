import { describe, expect, it } from 'vitest';
import type { Snapshot, SnapshotEntity } from '@gm-net/core';
import { InterpolationBuffer } from '../src/interpolation.js';

/**
 * Đồng hồ ảo + tickMs=100 cho số tròn: delay min 300ms = 3 tick.
 * Stream clock neo tại push đầu tiên (offset = tick − now/tickMs).
 */
const TICK_MS = 100;

function ent(entityId: number, posX: number, posY: number, velX = 0, velY = 0, rot = 0): SnapshotEntity {
  return { entityId, entityType: 0, posX, posY, rot, velX, velY };
}

function snap(serverTick: number, entities: SnapshotEntity[]): Snapshot {
  return { serverTick, lastProcessedSeq: 0, lateInputs: 0, entities };
}

function makeBuffer(overrides: ConstructorParameters<typeof InterpolationBuffer>[0] = {}) {
  return new InterpolationBuffer({
    tickMs: TICK_MS,
    minDelayMs: 300,
    maxDelayMs: 600,
    ...overrides,
  });
}

describe('InterpolationBuffer', () => {
  it('lerp position/rotation giữa hai snapshot kẹp renderTick', () => {
    const buf = makeBuffer();
    buf.push(snap(10, [ent(1, 0, 0, 0, 0, 0)]), 0); // offset = 10
    buf.push(snap(11, [ent(1, 2, 4, 0, 0, Math.PI / 2)]), TICK_MS);

    // renderTick = now/100 + 10 − 3 = 10.5
    const out = buf.sample(350);
    const e = out.get(1)!;
    expect(e.mode).toBe('interp');
    expect(e.posX).toBeCloseTo(1, 10);
    expect(e.posY).toBeCloseTo(2, 10);
    expect(e.rot).toBeCloseTo(Math.PI / 4, 10);
  });

  it('rotation lerp đi đường ngắn qua ranh ±π (không quay ngược cả vòng)', () => {
    const buf = makeBuffer();
    buf.push(snap(10, [ent(1, 0, 0, 0, 0, Math.PI - 0.1)]), 0);
    buf.push(snap(11, [ent(1, 0, 0, 0, 0, -Math.PI + 0.1)]), TICK_MS);

    const e = buf.sample(350).get(1)!; // renderTick 10.5 — giữa hai mẫu
    // Trung điểm đường ngắn: π − 0.1 + 0.1 = π (hoặc −π tương đương)
    expect(Math.abs(Math.abs(e.rot) - Math.PI)).toBeLessThan(1e-10);
  });

  it('thiếu snapshot → extrapolate theo velocity cuối tối đa cap, rồi freeze', () => {
    const buf = makeBuffer({ extrapolateMaxTicks: 2 });
    buf.push(snap(10, [ent(1, 0, 0, 10, 0)]), 0);
    buf.push(snap(11, [ent(1, 1, 0, 10, 0)]), TICK_MS);
    // Không còn snapshot nào nữa (loss kéo dài).

    // renderTick 12 = 1 tick quá mẫu cuối → extrapolate 0.1s × 10m/s = +1m.
    const e1 = buf.sample(500).get(1)!;
    expect(e1.mode).toBe('extrapolate');
    expect(e1.posX).toBeCloseTo(2, 10);

    // renderTick 13 = đúng cap 2 tick.
    const e2 = buf.sample(600).get(1)!;
    expect(e2.mode).toBe('extrapolate');
    expect(e2.posX).toBeCloseTo(3, 10);

    // renderTick 15 = quá cap → freeze tại vị trí cap, không trôi tiếp.
    const e3 = buf.sample(800).get(1)!;
    expect(e3.mode).toBe('freeze');
    expect(e3.posX).toBeCloseTo(3, 10);
  });

  it('renderTick trước mẫu đầu tiên → giữ mẫu đầu (mode old)', () => {
    const buf = makeBuffer();
    buf.push(snap(100, [ent(1, 7, 8)]), 0); // offset = 100
    // renderTick = 0/100 + 100 − 3 = 97 < 100.
    const e = buf.sample(0).get(1)!;
    expect(e.mode).toBe('old');
    expect(e.posX).toBe(7);
  });

  it('adaptive delay: buffer cạn đẩy target lên (≤ max), delay hiệu dụng trượt dần', () => {
    const buf = makeBuffer({ starveBumpMs: 50, slewPerSecond: 100 });
    buf.push(snap(10, [ent(1, 0, 0)]), 0);
    buf.push(snap(11, [ent(1, 1, 0)]), TICK_MS);

    expect(buf.stats().delayMs).toBe(300);
    // Loạt frame cạn (renderTick vượt newestTick=11): now từ 500, mỗi frame +16ms.
    let now = 500;
    for (let i = 0; i < 20; i++) {
      buf.sample(now);
      now += 16;
    }
    const s = buf.stats();
    expect(s.targetDelayMs).toBeGreaterThan(300);
    expect(s.targetDelayMs).toBeLessThanOrEqual(600);
    expect(s.starvedSamples).toBeGreaterThan(0);
    // Delay hiệu dụng trượt: sau ~304ms thực, đi được tối đa ~30.4ms (slew 100/s).
    expect(s.delayMs).toBeGreaterThan(300);
    expect(s.delayMs).toBeLessThan(335);
  });

  it('mạng sạch → target delay rỉ dần về min', () => {
    const buf = makeBuffer({ starveBumpMs: 50, decayPerSecond: 100 });
    buf.push(snap(10, [ent(1, 0, 0)]), 0);
    buf.push(snap(11, [ent(1, 1, 0)]), TICK_MS);
    // Gây cạn một lần để target > min.
    buf.sample(500);
    expect(buf.stats().targetDelayMs).toBe(350);

    // Stream tiếp tục về đều: sample luôn nằm trong buffer → decay.
    let now = 500;
    let tick = 12;
    for (let i = 0; i < 40; i++) {
      buf.push(snap(tick, [ent(1, 0, 0)]), now);
      buf.sample(now);
      now += TICK_MS;
      tick++;
    }
    expect(buf.stats().targetDelayMs).toBe(300);
  });

  it('entity vắng mặt khỏi stream (despawn) bị gỡ sau khi render đi qua lịch sử của nó', () => {
    const buf = makeBuffer({ despawnGraceTicks: 2, extrapolateMaxTicks: 2 });
    buf.push(snap(10, [ent(1, 0, 0), ent(2, 5, 5)]), 0);
    buf.push(snap(11, [ent(1, 1, 0), ent(2, 5, 5)]), TICK_MS);
    // Entity 2 despawn: các snapshot sau chỉ còn entity 1.
    for (let t = 12; t <= 20; t++) buf.push(snap(t, [ent(1, t - 10, 0)]), (t - 10) * TICK_MS);

    // renderTick 14 > 11 + 2: entity 2 bị gỡ, entity 1 vẫn interp.
    const out = buf.sample(700);
    expect(out.get(2)).toBeUndefined();
    expect(out.get(1)?.mode).toBe('interp');
  });

  it('snapshot cũ hơn bản đã có bị bỏ; stats trước snapshot đầu tiên rỗng', () => {
    const buf = makeBuffer();
    expect(buf.sample(0).size).toBe(0);
    expect(buf.stats().totalSamples).toBe(0);

    buf.push(snap(10, [ent(1, 1, 1)]), 0);
    buf.push(snap(9, [ent(1, 99, 99)]), 10); // cũ → bỏ
    const e = buf.sample(300).get(1)!; // renderTick = 3 + 10 − 3 = 10 → mẫu duy nhất
    expect(e.posX).toBe(1);
  });
});
