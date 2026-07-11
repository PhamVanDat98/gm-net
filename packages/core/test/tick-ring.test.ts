import { describe, expect, it } from 'vitest';
import { TickRing } from '../src/index.js';

describe('TickRing', () => {
  it('set/get theo tick, đúng slot modulo', () => {
    const ring = new TickRing<string>(4);
    ring.set(0, 'a');
    ring.set(1, 'b');
    ring.set(5, 'f'); // slot 1 bị ghi đè (5 % 4 === 1)
    expect(ring.get(0)).toBe('a');
    expect(ring.get(1)).toBeUndefined(); // đã bị 5 ghi đè, không trả nhầm 'f'
    expect(ring.get(5)).toBe('f');
    expect(ring.has(5)).toBe(true);
    expect(ring.has(9)).toBe(false); // cùng slot với 5 nhưng chưa ghi
  });

  it('tick chưa ghi / ngoài ring → undefined', () => {
    const ring = new TickRing<number>(3);
    expect(ring.get(2)).toBeUndefined();
    ring.set(10, 1);
    expect(ring.get(7)).toBeUndefined(); // tick cũ cùng slot
    expect(ring.get(-1)).toBeUndefined();
  });

  it('clear xóa toàn bộ', () => {
    const ring = new TickRing<number>(2);
    ring.set(0, 1);
    ring.set(1, 2);
    ring.clear();
    expect(ring.get(0)).toBeUndefined();
    expect(ring.get(1)).toBeUndefined();
  });

  it('capacity không hợp lệ / tick âm → ném', () => {
    expect(() => new TickRing(0)).toThrow(RangeError);
    expect(() => new TickRing(1.5)).toThrow(RangeError);
    const ring = new TickRing<number>(2);
    expect(() => ring.set(-1, 0)).toThrow(RangeError);
  });

  it('giữ đúng capacity giá trị gần nhất', () => {
    const ring = new TickRing<number>(30);
    for (let t = 0; t < 100; t++) ring.set(t, t * 2);
    for (let t = 70; t < 100; t++) expect(ring.get(t)).toBe(t * 2);
    for (let t = 0; t < 70; t++) expect(ring.get(t)).toBeUndefined();
  });
});
