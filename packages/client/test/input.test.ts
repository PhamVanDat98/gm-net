import { describe, expect, it } from 'vitest';
import { InputPipeline, InputLeadController } from '../src/index.js';

interface P {
  v: number;
}

describe('InputPipeline', () => {
  it('seq bắt đầu từ 1, packet kèm redundancy N input đuôi + ackTick', () => {
    const p = new InputPipeline<P>({ redundancy: 3 });
    const s0 = p.sample({ v: 0 }, 10, 7);
    expect(s0.seq).toBe(1); // không phải 0 (né nhập nhằng ack=0)
    expect(s0.packet.latestSeq).toBe(1);
    expect(s0.packet.ackTick).toBe(7);

    p.sample({ v: 1 }, 11, 7);
    p.sample({ v: 2 }, 12, 7);
    const s3 = p.sample({ v: 3 }, 13, 9);
    expect(s3.seq).toBe(4);
    expect(s3.packet.inputs.map((e) => e.payload!.v)).toEqual([1, 2, 3]); // 3 input mới nhất
    expect(s3.packet.inputs.map((e) => e.tick)).toEqual([11, 12, 13]);
    expect(p.pendingCount).toBe(4);
  });

  it('ack cắt phần đầu đã xử lý (xét wrap qua seqGreaterEqual)', () => {
    const p = new InputPipeline<P>({ redundancy: 5 });
    for (let i = 0; i < 5; i++) p.sample({ v: i }, i, 0); // seq 1..5
    p.ack(2); // seq ≤ 2 bỏ
    expect(p.pendingCount).toBe(3); // 3,4,5
    expect(p.unacked().map((u) => u.seq)).toEqual([3, 4, 5]);
    p.ack(0); // ack cũ hơn không cắt gì
    expect(p.pendingCount).toBe(3);
  });

  it('redundancy: mất 1 packet giữa chừng, mọi seq vẫn tới nơi', () => {
    const p = new InputPipeline<P>({ redundancy: 3 });
    const packets = [];
    for (let i = 0; i < 5; i++) packets.push(p.sample({ v: i }, i, 0).packet);

    // Server nhận tất cả trừ packet index 1 (mất gói).
    const delivered = new Set<number>();
    packets.forEach((pk, idx) => {
      if (idx === 1) return;
      const count = pk.inputs.length;
      for (let j = 0; j < count; j++) delivered.add((pk.latestSeq - (count - 1) + j) & 0xffff);
    });
    for (let seq = 1; seq <= 5; seq++) expect(delivered.has(seq)).toBe(true);
  });
});

describe('InputLeadController', () => {
  it('applyBase một lần theo RTT, sau đó tự thích ứng', () => {
    const c = new InputLeadController({ initial: 2, min: 1, max: 10, hysteresis: 3 });
    expect(c.lead).toBe(2);
    c.applyBase(5);
    expect(c.lead).toBe(5);
    c.applyBase(8); // chỉ nhận lần đầu
    expect(c.lead).toBe(5);
  });

  it('tăng ngay khi có input muộn, giảm sau hysteresis snapshot sạch', () => {
    const c = new InputLeadController({ initial: 4, min: 1, max: 10, hysteresis: 3 });
    c.onSnapshot(2); // muộn → +1
    expect(c.lead).toBe(5);
    c.onSnapshot(0);
    c.onSnapshot(0);
    expect(c.lead).toBe(5); // chưa đủ streak
    c.onSnapshot(0); // đủ 3 sạch → -1
    expect(c.lead).toBe(4);
    c.onSnapshot(1); // muộn lại reset streak + tăng
    expect(c.lead).toBe(5);
  });

  it('clamp trong [min, max]', () => {
    const lo = new InputLeadController({ initial: 1, min: 1, hysteresis: 1 });
    lo.onSnapshot(0); // muốn -1 → clamp min 1
    expect(lo.lead).toBe(1);
    const hi = new InputLeadController({ initial: 3, max: 3 });
    hi.onSnapshot(5);
    expect(hi.lead).toBe(3); // clamp max
  });
});
