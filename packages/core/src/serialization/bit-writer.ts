/**
 * Writer dạng cursor cho wire protocol ([docs/design/005-serialization.md] §1):
 * ghi theo bit (cờ, bitmask — LSB-first) lẫn theo byte (u8/u16/u32/i16/f32,
 * little-endian). Byte-ops tự canh biên byte: nếu đang dở một byte bit thì
 * flush (đệm 0 phần còn lại) rồi mới ghi. Buffer tự lớn dần.
 */
export class BitWriter {
  private buf: Uint8Array;
  private view: DataView;
  /** Byte kế tiếp sẽ ghi. Chỉ trỏ tới byte "sạch" khi `bitInByte === 0`. */
  private bytePos = 0;
  /** Số bit đã lấp trong `buf[bytePos]`, trong [0, 8). */
  private bitInByte = 0;

  constructor(initialCapacity = 64) {
    this.buf = new Uint8Array(Math.max(1, initialCapacity));
    this.view = new DataView(this.buf.buffer);
  }

  /** Số byte đã ghi (gồm cả byte bit dở dang, được tính trọn). */
  get byteLength(): number {
    return this.bytePos + (this.bitInByte > 0 ? 1 : 0);
  }

  private ensure(extraBytes: number): void {
    const needed = this.bytePos + extraBytes;
    if (needed <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < needed) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  /** Canh về biên byte: nếu đang dở byte bit thì đóng byte đó lại. */
  private align(): void {
    if (this.bitInByte !== 0) {
      this.bytePos += 1;
      this.bitInByte = 0;
    }
  }

  writeBit(bit: number): void {
    if (this.bitInByte === 0) this.ensure(1);
    if (bit & 1) this.buf[this.bytePos] |= 1 << this.bitInByte;
    this.bitInByte += 1;
    if (this.bitInByte === 8) {
      this.bytePos += 1;
      this.bitInByte = 0;
    }
  }

  /** Ghi `numBits` bit thấp của `value`, thứ tự LSB-first. */
  writeBits(value: number, numBits: number): void {
    for (let i = 0; i < numBits; i++) {
      this.writeBit((value >>> i) & 1);
    }
  }

  writeU8(value: number): void {
    this.align();
    this.ensure(1);
    this.view.setUint8(this.bytePos, value & 0xff);
    this.bytePos += 1;
  }

  writeU16(value: number): void {
    this.align();
    this.ensure(2);
    this.view.setUint16(this.bytePos, value & 0xffff, true);
    this.bytePos += 2;
  }

  writeU32(value: number): void {
    this.align();
    this.ensure(4);
    this.view.setUint32(this.bytePos, value >>> 0, true);
    this.bytePos += 4;
  }

  writeI16(value: number): void {
    this.align();
    this.ensure(2);
    this.view.setInt16(this.bytePos, value, true);
    this.bytePos += 2;
  }

  writeF32(value: number): void {
    this.align();
    this.ensure(4);
    this.view.setFloat32(this.bytePos, value, true);
    this.bytePos += 4;
  }

  /** Bản sao chính xác phần đã ghi. */
  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this.byteLength);
  }
}
