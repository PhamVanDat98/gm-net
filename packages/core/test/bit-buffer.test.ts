import { describe, expect, it } from 'vitest';
import { BitReader, BitWriter } from '../src/index.js';

/** PRNG xác định (mulberry32) để test lặp lại được. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('BitWriter/BitReader', () => {
  it('round-trip từng kiểu byte little-endian', () => {
    const w = new BitWriter();
    w.writeU8(0xab);
    w.writeU16(0x1234);
    w.writeU32(0xdeadbeef);
    w.writeI16(-12345);
    w.writeF32(3.14159);
    const r = new BitReader(w.toUint8Array());
    expect(r.readU8()).toBe(0xab);
    expect(r.readU16()).toBe(0x1234);
    expect(r.readU32()).toBe(0xdeadbeef);
    expect(r.readI16()).toBe(-12345);
    expect(r.readF32()).toBeCloseTo(3.14159, 5);
  });

  it('u32 giữ nguyên giá trị không dấu > 2^31', () => {
    const w = new BitWriter();
    w.writeU32(0xffffffff);
    expect(new BitReader(w.toUint8Array()).readU32()).toBe(0xffffffff);
  });

  it('bit LSB-first round-trip', () => {
    const w = new BitWriter();
    // 0b1011 ghi LSB-first: 1,1,0,1
    w.writeBits(0b1011, 4);
    w.writeBit(1);
    w.writeBits(0x1ff, 9); // vượt biên byte
    const r = new BitReader(w.toUint8Array());
    expect(r.readBits(4)).toBe(0b1011);
    expect(r.readBit()).toBe(1);
    expect(r.readBits(9)).toBe(0x1ff);
  });

  it('byte-op tự canh biên (đệm 0 các bit dở dang)', () => {
    const w = new BitWriter();
    w.writeBits(0b101, 3); // 3 bit → byte 0 còn 5 bit trống
    w.writeU8(0xcd); // phải nhảy sang byte 1
    const bytes = w.toUint8Array();
    expect(bytes.length).toBe(2);
    expect(bytes[0]).toBe(0b101); // 5 bit cao là 0
    expect(bytes[1]).toBe(0xcd);
    const r = new BitReader(bytes);
    expect(r.readBits(3)).toBe(0b101);
    expect(r.readU8()).toBe(0xcd);
  });

  it('byteLength tính cả byte bit dở dang', () => {
    const w = new BitWriter();
    expect(w.byteLength).toBe(0);
    w.writeBit(1);
    expect(w.byteLength).toBe(1);
    w.writeBits(0, 7); // đủ 1 byte
    expect(w.byteLength).toBe(1);
    w.writeBit(1);
    expect(w.byteLength).toBe(2);
  });

  it('tự lớn buffer khi ghi vượt dung lượng khởi tạo', () => {
    const w = new BitWriter(4);
    for (let i = 0; i < 100; i++) w.writeU32(i);
    const r = new BitReader(w.toUint8Array());
    for (let i = 0; i < 100; i++) expect(r.readU32()).toBe(i);
  });

  it('reader ném RangeError khi đọc vượt biên', () => {
    const r = new BitReader(new Uint8Array([0x01]));
    expect(() => r.readU16()).toThrow(RangeError);
    const r2 = new BitReader(new Uint8Array(0));
    expect(() => r2.readBit()).toThrow(RangeError);
  });

  it('property: chuỗi ghi ngẫu nhiên đọc lại khớp', () => {
    const rng = makeRng(12345);
    for (let iter = 0; iter < 200; iter++) {
      const w = new BitWriter(8);
      const ops: Array<{ kind: string; value: number }> = [];
      const n = 1 + Math.floor(rng() * 20);
      for (let i = 0; i < n; i++) {
        const pick = Math.floor(rng() * 5);
        if (pick === 0) {
          const value = Math.floor(rng() * 256);
          w.writeU8(value);
          ops.push({ kind: 'u8', value });
        } else if (pick === 1) {
          const value = Math.floor(rng() * 65536);
          w.writeU16(value);
          ops.push({ kind: 'u16', value });
        } else if (pick === 2) {
          const value = (rng() * 0xffffffff) >>> 0;
          w.writeU32(value);
          ops.push({ kind: 'u32', value });
        } else if (pick === 3) {
          const value = Math.floor(rng() * 65536) - 32768;
          w.writeI16(value);
          ops.push({ kind: 'i16', value });
        } else {
          const bits = 1 + Math.floor(rng() * 16);
          const value = Math.floor(rng() * (1 << bits));
          w.writeBits(value, bits);
          ops.push({ kind: `bits${bits}`, value });
        }
      }
      const r = new BitReader(w.toUint8Array());
      for (const op of ops) {
        if (op.kind === 'u8') expect(r.readU8()).toBe(op.value);
        else if (op.kind === 'u16') expect(r.readU16()).toBe(op.value);
        else if (op.kind === 'u32') expect(r.readU32()).toBe(op.value);
        else if (op.kind === 'i16') expect(r.readI16()).toBe(op.value);
        else expect(r.readBits(Number(op.kind.slice(4)))).toBe(op.value);
      }
    }
  });
});
