import { describe, expect, it } from 'vitest'
import { ByteReader, ByteWriter } from '../src/binary.js'

describe('ByteWriter / ByteReader', () => {
  it('roundtrips các kiểu cố định', () => {
    const w = new ByteWriter()
    w.u8(255).u16(65535).u32(4294967295)
    w.i8(-128).i16(-32768).i32(-2147483648)
    w.f32(1.5).f64(Math.PI)

    const r = new ByteReader(w.finish())
    expect(r.u8()).toBe(255)
    expect(r.u16()).toBe(65535)
    expect(r.u32()).toBe(4294967295)
    expect(r.i8()).toBe(-128)
    expect(r.i16()).toBe(-32768)
    expect(r.i32()).toBe(-2147483648)
    expect(r.f32()).toBe(1.5)
    expect(r.f64()).toBe(Math.PI)
    expect(r.remaining).toBe(0)
  })

  it('roundtrips varint qua các biên LEB128', () => {
    const values = [0, 1, 127, 128, 255, 300, 16383, 16384, 2 ** 31, 2 ** 32, Number.MAX_SAFE_INTEGER]
    const w = new ByteWriter()
    for (const v of values) w.varint(v)
    const r = new ByteReader(w.finish())
    for (const v of values) expect(r.varint()).toBe(v)
  })

  it('mã hóa varint đúng kích thước', () => {
    expect(new ByteWriter().varint(127).finish().length).toBe(1)
    expect(new ByteWriter().varint(128).finish().length).toBe(2)
    expect(new ByteWriter().varint(16384).finish().length).toBe(3)
  })

  it('roundtrips svarint với số âm', () => {
    const values = [0, -1, 1, -64, 64, -12345, 12345, -(2 ** 40), 2 ** 40]
    const w = new ByteWriter()
    for (const v of values) w.svarint(v)
    const r = new ByteReader(w.finish())
    for (const v of values) expect(r.svarint()).toBe(v)
  })

  it('svarint zigzag: số nhỏ quanh 0 tốn 1 byte', () => {
    expect(new ByteWriter().svarint(-1).finish().length).toBe(1)
    expect(new ByteWriter().svarint(63).finish().length).toBe(1)
  })

  it('từ chối varint không hợp lệ', () => {
    expect(() => new ByteWriter().varint(-1)).toThrow(RangeError)
    expect(() => new ByteWriter().varint(1.5)).toThrow(RangeError)
    expect(() => new ByteWriter().varint(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError)
  })

  it('roundtrips string unicode', () => {
    const s = 'xin chào 👋 ước gì được nấy'
    const w = new ByteWriter().string(s).string('')
    const r = new ByteReader(w.finish())
    expect(r.string()).toBe(s)
    expect(r.string()).toBe('')
  })

  it('tự grow buffer vượt capacity ban đầu', () => {
    const w = new ByteWriter(4)
    const big = new Uint8Array(10_000).fill(7)
    w.bytes(big)
    w.u32(123)
    const r = new ByteReader(w.finish())
    expect(r.bytes(10_000)).toEqual(big)
    expect(r.u32()).toBe(123)
  })

  it('reader ném RangeError khi đọc quá buffer', () => {
    const r = new ByteReader(new ByteWriter().u8(1).finish())
    r.u8()
    expect(() => r.u8()).toThrow(RangeError)
    expect(() => new ByteReader(new Uint8Array([0x80])).varint()).toThrow(RangeError)
  })

  it('reader hoạt động đúng trên subarray (byteOffset != 0)', () => {
    const outer = new Uint8Array(16)
    outer.set(new ByteWriter().u16(500).finish(), 4)
    const r = new ByteReader(outer.subarray(4, 6))
    expect(r.u16()).toBe(500)
  })

  it('writer reset() cho phép tái sử dụng', () => {
    const w = new ByteWriter()
    w.u8(1)
    w.reset()
    w.u8(2)
    expect(Array.from(w.finish())).toEqual([2])
  })
})
