import { describe, expect, it } from 'vitest';
import type { InputMessage } from '@gm-net/core';
import { InputBuffer, seqGreater } from '../src/index.js';

interface P {
  v: number;
}

/** Dựng packet INPUT redundancy: ticks cũ→mới, latestSeq gắn với input cuối. */
function packet(latestSeq: number, entries: Array<{ tick: number; v: number }>): InputMessage<P> {
  return {
    ackTick: 0,
    latestSeq,
    inputs: entries.map((e) => ({ tick: e.tick, payload: { v: e.v } })),
  };
}

const opts = { maxTickSkew: 30, budgetPerTick: 2 };

describe('seqGreater (wrap 16-bit)', () => {
  it('so sánh thường và quanh biên 65535→0', () => {
    expect(seqGreater(5, 4)).toBe(true);
    expect(seqGreater(4, 5)).toBe(false);
    expect(seqGreater(5, 5)).toBe(false);
    expect(seqGreater(0, 65535)).toBe(true); // wrap
    expect(seqGreater(65535, 0)).toBe(false);
  });
});

describe('InputBuffer', () => {
  it('rút input đúng tick, ack = seq đã áp', () => {
    const b = new InputBuffer<P>(opts);
    b.ingest(packet(10, [{ tick: 5, v: 100 }]), 5);
    const taken = b.take(5, true);
    expect(taken?.payload?.v).toBe(100);
    expect(taken?.repeated).toBe(false);
    expect(b.lastProcessedSeq).toBe(10);
  });

  it('thiếu input tại tick → lặp input cuối (repeatLast)', () => {
    const b = new InputBuffer<P>(opts);
    b.ingest(packet(1, [{ tick: 0, v: 7 }]), 0);
    b.take(0, true);
    const repeated = b.take(1, true);
    expect(repeated?.payload?.v).toBe(7);
    expect(repeated?.repeated).toBe(true);
    expect(b.lastProcessedSeq).toBe(1); // ack không đổi khi lặp
  });

  it('chưa có input nào → undefined (không lặp)', () => {
    const b = new InputBuffer<P>(opts);
    expect(b.take(0, true)).toBeUndefined();
    expect(b.lastProcessedSeq).toBe(0);
  });

  it('redundancy: mất 1 packet không mất input, trùng bị dedupe', () => {
    const b = new InputBuffer<P>(opts);
    // Packet 1 (seq 1..3) MẤT. Packet 2 mang lại seq 2,3,4 (redundancy).
    b.ingest(packet(4, [
      { tick: 2, v: 20 },
      { tick: 3, v: 30 },
      { tick: 4, v: 40 },
    ]), 2);
    expect(b.stats.duplicates).toBe(0);
    // Packet 3 lặp seq 3,4,5 → 3,4 trùng, 5 mới.
    b.ingest(packet(5, [
      { tick: 3, v: 30 },
      { tick: 4, v: 40 },
      { tick: 5, v: 50 },
    ]), 3);
    expect(b.stats.duplicates).toBe(2);
    expect(b.take(2, true)?.payload?.v).toBe(20);
    expect(b.take(3, true)?.payload?.v).toBe(30);
    expect(b.take(5, true)?.payload?.v).toBe(50);
  });

  it('input tick ngoài cửa sổ ±maxTickSkew bị bỏ + đếm', () => {
    const b = new InputBuffer<P>({ maxTickSkew: 3, budgetPerTick: 10 });
    b.ingest(packet(1, [{ tick: 100, v: 1 }]), 5); // lệch 95 > 3
    expect(b.stats.droppedWindow).toBe(1);
    expect(b.pendingCount).toBe(0);
    b.ingest(packet(2, [{ tick: 6, v: 2 }]), 5); // lệch 1 ≤ 3 → nhận
    expect(b.pendingCount).toBe(1);
  });

  it('flood: quá ngân sách input mới/tick bị drop + đếm', () => {
    const b = new InputBuffer<P>({ maxTickSkew: 30, budgetPerTick: 2 });
    b.ingest(packet(5, [
      { tick: 1, v: 1 },
      { tick: 2, v: 2 },
      { tick: 3, v: 3 },
      { tick: 4, v: 4 },
      { tick: 5, v: 5 },
    ]), 3);
    expect(b.stats.droppedFlood).toBe(3); // chỉ 2 được nhận
    expect(b.pendingCount).toBe(2);
  });

  it('ngân sách reset khi tick server tiến', () => {
    const b = new InputBuffer<P>({ maxTickSkew: 30, budgetPerTick: 1 });
    b.ingest(packet(1, [{ tick: 1, v: 1 }]), 1);
    b.ingest(packet(2, [{ tick: 2, v: 2 }]), 1); // cùng tick, quá budget
    expect(b.stats.droppedFlood).toBe(1);
    b.ingest(packet(3, [{ tick: 3, v: 3 }]), 2); // tick mới → budget reset
    expect(b.stats.droppedFlood).toBe(1);
    expect(b.pendingCount).toBe(2);
  });

  it('lateInputs: input tới sau khi tick của nó đã qua', () => {
    const b = new InputBuffer<P>(opts);
    b.ingest(packet(1, [{ tick: 2, v: 1 }]), 5); // tick 2 < serverTick 5 → muộn
    expect(b.lateInputs).toBe(1);
    b.ingest(packet(2, [{ tick: 6, v: 2 }]), 5); // đúng giờ
    expect(b.lateInputs).toBe(1);
  });
});
