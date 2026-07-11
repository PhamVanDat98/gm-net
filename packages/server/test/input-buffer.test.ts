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
    const b = new InputBuffer<P>({ maxTickSkew: 30, budgetPerTick: 10 });
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

  it('flood: quá ngân sách input mới/tick → hoãn phần còn lại + đếm', () => {
    const b = new InputBuffer<P>({ maxTickSkew: 30, budgetPerTick: 2 });
    b.ingest(packet(5, [
      { tick: 3, v: 3 },
      { tick: 4, v: 4 },
      { tick: 5, v: 5 },
      { tick: 6, v: 6 },
      { tick: 7, v: 7 },
    ]), 3);
    expect(b.stats.droppedFlood).toBe(3); // chỉ 2 được nhận tick này
    expect(b.pendingCount).toBe(2);
  });

  it('flood không mất input: phần bị hoãn được nhận lại từ redundancy sau khi budget reset', () => {
    const b = new InputBuffer<P>({ maxTickSkew: 30, budgetPerTick: 2 });
    // Burst phục hồi sau mất gói: 5 input mới (seq 1..5) đến cùng lúc tại tick 10.
    b.ingest(packet(5, [
      { tick: 10, v: 10 },
      { tick: 11, v: 11 },
      { tick: 12, v: 12 },
      { tick: 13, v: 13 },
      { tick: 14, v: 14 },
    ]), 10);
    expect(b.pendingCount).toBe(2); // seq 1,2 nhận; 3..5 hoãn, KHÔNG đánh dấu đã thấy

    // Packet kế (seq 2..6, redundancy 5) tới ở tick 11 — budget đã reset.
    b.ingest(packet(6, [
      { tick: 11, v: 11 },
      { tick: 12, v: 12 },
      { tick: 13, v: 13 },
      { tick: 14, v: 14 },
      { tick: 15, v: 15 },
    ]), 11);
    expect(b.stats.duplicates).toBe(1); // chỉ seq 2 là trùng thật
    expect(b.pendingCount).toBe(4); // + seq 3,4 (seq 5,6 hoãn tiếp)

    // Backlog rút dần mỗi tick (budget 2 > tốc độ input 1/tick) tới khi sạch.
    b.ingest(packet(7, [
      { tick: 12, v: 12 },
      { tick: 13, v: 13 },
      { tick: 14, v: 14 },
      { tick: 15, v: 15 },
      { tick: 16, v: 16 },
    ]), 12); // nhận seq 5,6 (tick 14,15); seq 7 hoãn
    b.ingest(packet(8, [
      { tick: 13, v: 13 },
      { tick: 14, v: 14 },
      { tick: 15, v: 15 },
      { tick: 16, v: 16 },
      { tick: 17, v: 17 },
    ]), 13); // nhận nốt seq 7,8 (tick 16,17)

    // Mọi tick 10..17 đều rút được — không input nào mất vĩnh viễn.
    for (let t = 10; t <= 17; t++) {
      expect(b.take(t, false)?.payload?.v).toBe(t);
    }
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
    expect(b.pendingCount).toBe(0); // muộn không vào pending (không bao giờ rút được)
    b.ingest(packet(2, [{ tick: 6, v: 2 }]), 5); // đúng giờ
    expect(b.lateInputs).toBe(1);
  });

  it('input muộn không ăn budget của input tươi trong cùng packet', () => {
    const b = new InputBuffer<P>({ maxTickSkew: 30, budgetPerTick: 1 });
    b.ingest(packet(3, [
      { tick: 3, v: 3 }, // muộn
      { tick: 4, v: 4 }, // muộn
      { tick: 6, v: 6 }, // tươi — vẫn còn budget
    ]), 5);
    expect(b.lateInputs).toBe(2);
    expect(b.take(6, false)?.payload?.v).toBe(6);
  });

  it('consumeLateInputs: đọc theo cửa sổ rồi reset (không tích lũy trọn đời)', () => {
    const b = new InputBuffer<P>(opts);
    b.ingest(packet(1, [{ tick: 1, v: 1 }]), 5); // muộn
    b.ingest(packet(2, [{ tick: 2, v: 2 }]), 5); // muộn
    expect(b.consumeLateInputs()).toBe(2);
    expect(b.consumeLateInputs()).toBe(0); // đã reset — snapshot sau báo 0
    b.ingest(packet(3, [{ tick: 3, v: 3 }]), 6); // muộn tiếp
    expect(b.consumeLateInputs()).toBe(1);
    expect(b.lateInputs).toBe(3); // tổng trọn đời cho metrics vẫn giữ
  });
});
