/**
 * Reader dạng cursor, đối xứng với {@link BitWriter}
 * ([docs/design/005-serialization.md] §1). Đọc quá biên buffer ném
 * `RangeError` — quan trọng cho fuzz decoder: dữ liệu rác phải dừng bằng
 * exception bắt được, không được đọc lung tung ngoài vùng nhớ.
 */
export class BitReader {
  private view: DataView;
  private len: number;
  private bytePos = 0;
  private bitInByte = 0;

  constructor(bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.len = bytes.byteLength;
  }

  /** Số byte đã đọc (byte bit dở dang tính trọn). */
  get bytesRead(): number {
    return this.bytePos + (this.bitInByte > 0 ? 1 : 0);
  }

  /** Còn byte chưa đọc không. */
  get hasMore(): boolean {
    return this.bytesRead < this.len;
  }

  private requireBytes(n: number): void {
    if (this.bytePos + n > this.len) {
      throw new RangeError(
        `BitReader: đọc vượt biên (cần ${n} byte tại ${this.bytePos}/${this.len})`,
      );
    }
  }

  private align(): void {
    if (this.bitInByte !== 0) {
      this.bytePos += 1;
      this.bitInByte = 0;
    }
  }

  readBit(): number {
    if (this.bytePos >= this.len) {
      throw new RangeError(`BitReader: đọc bit vượt biên (${this.bytePos}/${this.len})`);
    }
    const bit = (this.view.getUint8(this.bytePos) >> this.bitInByte) & 1;
    this.bitInByte += 1;
    if (this.bitInByte === 8) {
      this.bytePos += 1;
      this.bitInByte = 0;
    }
    return bit;
  }

  /** Đọc `numBits` bit, tái dựng số theo thứ tự LSB-first của writer. */
  readBits(numBits: number): number {
    let value = 0;
    for (let i = 0; i < numBits; i++) {
      value |= this.readBit() << i;
    }
    return value >>> 0;
  }

  readU8(): number {
    this.align();
    this.requireBytes(1);
    const v = this.view.getUint8(this.bytePos);
    this.bytePos += 1;
    return v;
  }

  readU16(): number {
    this.align();
    this.requireBytes(2);
    const v = this.view.getUint16(this.bytePos, true);
    this.bytePos += 2;
    return v;
  }

  readU32(): number {
    this.align();
    this.requireBytes(4);
    const v = this.view.getUint32(this.bytePos, true);
    this.bytePos += 4;
    return v;
  }

  readI16(): number {
    this.align();
    this.requireBytes(2);
    const v = this.view.getInt16(this.bytePos, true);
    this.bytePos += 2;
    return v;
  }

  readF32(): number {
    this.align();
    this.requireBytes(4);
    const v = this.view.getFloat32(this.bytePos, true);
    this.bytePos += 4;
    return v;
  }
}
