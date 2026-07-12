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

/**
 * Thời gian trôi qua giữa hai mốc ms, khi mốc đầu đã đi qua wire dưới dạng u32
 * ([005] §6b: PING/PONG cắt thời gian còn u32, wrap ~49 ngày).
 *
 * `Date.now()` (~1.78e12) KHÔNG lọt u32, nên trừ thẳng `now - clientTimeTrênDây`
 * cho ra ~1.78e12 ms — phải quy cả hai về u32 rồi trừ theo wrap. Diễn giải trong
 * cửa sổ ±2^31 giống {@link seqDistance}: kết quả âm = mốc sau đứng trước mốc
 * đầu (đồng hồ lùi / gói hỏng) — caller tự quyết bỏ mẫu.
 */
export function u32TimeDelta(fromMs: number, toMs: number): number {
  const d = ((toMs >>> 0) - (fromMs >>> 0)) >>> 0;
  return d < 0x8000_0000 ? d : d - 0x1_0000_0000;
}
