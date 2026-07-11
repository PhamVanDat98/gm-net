import { describe, expect, it } from 'vitest';
import { TickScheduler, nextTickDelay } from '../src/index.js';

/** Đồng hồ + timer ảo để test cadence deterministic. */
class FakeTimers {
  time = 0;
  private timers: Array<{ id: number; fireAt: number; cb: () => void }> = [];
  private nextId = 1;
  now = (): number => this.time;
  setTimer = (cb: () => void, delay: number): number => {
    const id = this.nextId++;
    this.timers.push({ id, fireAt: this.time + delay, cb });
    return id;
  };
  clearTimer = (h: unknown): void => {
    this.timers = this.timers.filter((t) => t.id !== h);
  };
  runNext(): boolean {
    if (this.timers.length === 0) return false;
    this.timers.sort((a, b) => a.fireAt - b.fireAt);
    const t = this.timers.shift()!;
    this.time = Math.max(this.time, t.fireAt);
    t.cb();
    return true;
  }
}

describe('nextTickDelay', () => {
  it('đúng giờ → delay 0', () => {
    expect(nextTickDelay(100, 100, 10, 5)).toEqual({ delayMs: 0 });
  });
  it('còn sớm → chờ cho tới mốc', () => {
    expect(nextTickDelay(100, 95, 10, 5)).toEqual({ delayMs: 5 });
  });
  it('trễ ít (≤ maxCatchup) → fire ngay để bù, không resync', () => {
    expect(nextTickDelay(100, 115, 10, 5)).toEqual({ delayMs: 0 });
  });
  it('trễ quá nhiều → bỏ nợ, đặt lại mốc', () => {
    expect(nextTickDelay(100, 200, 10, 5)).toEqual({ delayMs: 10, resyncTo: 210 });
  });
});

describe('TickScheduler', () => {
  it('cadence khóa vào lưới stepMs dù callback tốn thời gian biến thiên (100 tick, drift < 1 tick)', () => {
    const fake = new FakeTimers();
    const jitter = [0, 2, 5, 8, 1, 3, 7, 4]; // luôn < stepMs
    let k = 0;
    const fireTimes: number[] = [];
    const s = new TickScheduler({
      stepMs: 10,
      now: fake.now,
      setTimer: fake.setTimer,
      clearTimer: fake.clearTimer,
      onTick: () => {
        fireTimes.push(fake.time);
        fake.time += jitter[k % jitter.length]; // giả lập chi phí callback
        k++;
      },
    });
    s.start();
    for (let i = 0; i < 100; i++) fake.runNext();

    expect(fireTimes.length).toBe(100);
    for (let t = 0; t < fireTimes.length; t++) {
      const ideal = 10 * (t + 1);
      expect(Math.abs(fireTimes[t] - ideal)).toBeLessThan(10); // drift < 1 tick
    }
  });

  it('onTick ném exception → loop sống tiếp, lỗi đi qua onError', () => {
    const fake = new FakeTimers();
    const seen: number[] = [];
    const errors: Array<{ tick: number; err: unknown }> = [];
    const s = new TickScheduler({
      stepMs: 10,
      now: fake.now,
      setTimer: fake.setTimer,
      clearTimer: fake.clearTimer,
      onTick: (tick) => {
        if (tick === 1 || tick === 3) throw new Error(`bùm ${tick}`);
        seen.push(tick);
      },
      onError: (err, tick) => errors.push({ tick, err }),
    });
    s.start();
    for (let i = 0; i < 6; i++) fake.runNext();

    expect(seen).toEqual([0, 2, 4, 5]); // tick lỗi bị bỏ nhưng loop không chết
    expect(errors.map((e) => e.tick)).toEqual([1, 3]);
    expect((errors[0].err as Error).message).toBe('bùm 1');
    expect(s.isRunning).toBe(true);
  });

  it('stop() gọi từ trong onTick → không schedule thêm timer nào', () => {
    const fake = new FakeTimers();
    const seen: number[] = [];
    const s = new TickScheduler({
      stepMs: 10,
      now: fake.now,
      setTimer: fake.setTimer,
      clearTimer: fake.clearTimer,
      onTick: (tick) => {
        seen.push(tick);
        if (tick === 2) s.stop();
      },
    });
    s.start();
    while (fake.runNext()) {
      // chạy tới khi hết timer — stop() trong onTick không được để lại timer treo
    }
    expect(seen).toEqual([0, 1, 2]);
    expect(s.isRunning).toBe(false);
  });

  it('tick tăng đơn điệu và stop() dừng hẳn', () => {
    const fake = new FakeTimers();
    const seen: number[] = [];
    const s = new TickScheduler({
      stepMs: 10,
      now: fake.now,
      setTimer: fake.setTimer,
      clearTimer: fake.clearTimer,
      onTick: (tick) => seen.push(tick),
    });
    s.start();
    for (let i = 0; i < 5; i++) fake.runNext();
    s.stop();
    const countAfterStop = seen.length;
    for (let i = 0; i < 5; i++) fake.runNext(); // không còn timer nào
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    expect(seen.length).toBe(countAfterStop);
    expect(s.isRunning).toBe(false);
  });
});
