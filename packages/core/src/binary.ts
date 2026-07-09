/**
 * Binary primitives cho wire protocol (design 002).
 * Little-endian. varint = unsigned LEB128, svarint = zigzag + LEB128.
 * Hỗ trợ số nguyên đến Number.MAX_SAFE_INTEGER (không dùng bitwise 32-bit).
 */

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/** Giới hạn an toàn: 8 byte LEB128 mã hóa được tới 2^56 > MAX_SAFE_INTEGER. */
const MAX_VARINT_BYTES = 8

export class ByteWriter {
  private buf: Uint8Array
  private view: DataView
  private pos = 0

  constructor(initialCapacity = 256) {
    this.buf = new Uint8Array(initialCapacity)
    this.view = new DataView(this.buf.buffer)
  }

  get length(): number {
    return this.pos
  }

  private ensure(extra: number): void {
    const needed = this.pos + extra
    if (needed <= this.buf.length) return
    let capacity = this.buf.length * 2
    while (capacity < needed) capacity *= 2
    const next = new Uint8Array(capacity)
    next.set(this.buf)
    this.buf = next
    this.view = new DataView(next.buffer)
  }

  u8(value: number): this {
    this.ensure(1)
    this.view.setUint8(this.pos, value)
    this.pos += 1
    return this
  }

  u16(value: number): this {
    this.ensure(2)
    this.view.setUint16(this.pos, value, true)
    this.pos += 2
    return this
  }

  u32(value: number): this {
    this.ensure(4)
    this.view.setUint32(this.pos, value, true)
    this.pos += 4
    return this
  }

  i8(value: number): this {
    this.ensure(1)
    this.view.setInt8(this.pos, value)
    this.pos += 1
    return this
  }

  i16(value: number): this {
    this.ensure(2)
    this.view.setInt16(this.pos, value, true)
    this.pos += 2
    return this
  }

  i32(value: number): this {
    this.ensure(4)
    this.view.setInt32(this.pos, value, true)
    this.pos += 4
    return this
  }

  f32(value: number): this {
    this.ensure(4)
    this.view.setFloat32(this.pos, value, true)
    this.pos += 4
    return this
  }

  f64(value: number): this {
    this.ensure(8)
    this.view.setFloat64(this.pos, value, true)
    this.pos += 8
    return this
  }

  /** Unsigned LEB128. value phải là số nguyên trong [0, MAX_SAFE_INTEGER]. */
  varint(value: number): this {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`varint requires a non-negative safe integer, got ${value}`)
    }
    this.ensure(MAX_VARINT_BYTES)
    while (value > 0x7f) {
      this.buf[this.pos++] = (value % 0x80) | 0x80
      value = Math.floor(value / 0x80)
    }
    this.buf[this.pos++] = value
    return this
  }

  /** Zigzag + LEB128, cho số nguyên có dấu. */
  svarint(value: number): this {
    const zigzag = value >= 0 ? value * 2 : -value * 2 - 1
    return this.varint(zigzag)
  }

  /** varint length prefix + UTF-8 bytes. */
  string(value: string): this {
    const encoded = textEncoder.encode(value)
    this.varint(encoded.length)
    return this.bytes(encoded)
  }

  bytes(value: Uint8Array): this {
    this.ensure(value.length)
    this.buf.set(value, this.pos)
    this.pos += value.length
    return this
  }

  /** Trả về bản copy vùng đã ghi — writer có thể tái sử dụng sau reset(). */
  finish(): Uint8Array {
    return this.buf.slice(0, this.pos)
  }

  reset(): void {
    this.pos = 0
  }
}

export class ByteReader {
  private view: DataView
  private pos = 0

  constructor(private data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  }

  get offset(): number {
    return this.pos
  }

  get remaining(): number {
    return this.data.length - this.pos
  }

  private need(n: number): void {
    if (this.pos + n > this.data.length) {
      throw new RangeError(
        `Buffer underrun: need ${n} byte(s) at offset ${this.pos}, only ${this.remaining} left`,
      )
    }
  }

  u8(): number {
    this.need(1)
    const v = this.view.getUint8(this.pos)
    this.pos += 1
    return v
  }

  u16(): number {
    this.need(2)
    const v = this.view.getUint16(this.pos, true)
    this.pos += 2
    return v
  }

  u32(): number {
    this.need(4)
    const v = this.view.getUint32(this.pos, true)
    this.pos += 4
    return v
  }

  i8(): number {
    this.need(1)
    const v = this.view.getInt8(this.pos)
    this.pos += 1
    return v
  }

  i16(): number {
    this.need(2)
    const v = this.view.getInt16(this.pos, true)
    this.pos += 2
    return v
  }

  i32(): number {
    this.need(4)
    const v = this.view.getInt32(this.pos, true)
    this.pos += 4
    return v
  }

  f32(): number {
    this.need(4)
    const v = this.view.getFloat32(this.pos, true)
    this.pos += 4
    return v
  }

  f64(): number {
    this.need(8)
    const v = this.view.getFloat64(this.pos, true)
    this.pos += 8
    return v
  }

  varint(): number {
    let result = 0
    let factor = 1
    for (let i = 0; i < MAX_VARINT_BYTES; i++) {
      const byte = this.u8()
      result += (byte & 0x7f) * factor
      if ((byte & 0x80) === 0) {
        if (!Number.isSafeInteger(result)) {
          throw new RangeError(`varint exceeds MAX_SAFE_INTEGER at offset ${this.pos}`)
        }
        return result
      }
      factor *= 0x80
    }
    throw new RangeError(`Malformed varint: no terminator within ${MAX_VARINT_BYTES} bytes`)
  }

  svarint(): number {
    const zigzag = this.varint()
    return zigzag % 2 === 0 ? zigzag / 2 : -(zigzag + 1) / 2
  }

  string(): string {
    const length = this.varint()
    return textDecoder.decode(this.bytes(length))
  }

  bytes(length: number): Uint8Array {
    this.need(length)
    const v = this.data.subarray(this.pos, this.pos + length)
    this.pos += length
    return v
  }
}
