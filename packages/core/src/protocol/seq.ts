/**
 * So sánh sequence number 16-bit có xét wrap-around ([docs/design/005-serialization.md]
 * §6). Seq đơn điệu tăng per-client nhưng chỉ mang trên wire dưới dạng u16, nên
 * sau 65536 input sẽ cuộn về 0. Cả server (dedupe input) lẫn client (cắt
 * pendingInputs theo ack) đều cần cùng một phép so sánh — đặt ở core để không
 * lệch giữa hai bên.
 */

/** Khoảng cách quanh wrap: hiệu `(a - b)` diễn giải trong cửa sổ ±32768. */
export function seqDistance(a: number, b: number): number {
  const d = (a - b) & 0xffff;
  return d < 0x8000 ? d : d - 0x10000;
}

/** `a` mới hơn `b` (đứng sau trong dòng seq). */
export function seqGreater(a: number, b: number): boolean {
  return a !== b && seqDistance(a, b) > 0;
}

/** `a` mới hơn hoặc bằng `b`. */
export function seqGreaterEqual(a: number, b: number): boolean {
  return a === b || seqDistance(a, b) > 0;
}
