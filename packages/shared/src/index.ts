/**
 * @gm-net/shared — simulation logic, input schema và constants dùng chung
 * giữa client và server, đảm bảo prediction khớp authoritative simulation.
 */

/** Tần số mô phỏng phía server (Hz). */
export const SERVER_TICK_RATE = 30;

/** Độ dài một tick mô phỏng (ms). */
export const SERVER_TICK_MS = 1000 / SERVER_TICK_RATE;

/**
 * Một input của người chơi, client gửi lên server kèm sequence number.
 * Server ack `seq` cao nhất đã xử lý trong mỗi snapshot; client dùng nó
 * để cắt input buffer và replay phần chưa ack khi reconcile.
 */
export interface InputCommand {
  /** Sequence number đơn điệu tăng theo từng client. */
  seq: number;
  /** Tick mô phỏng mà input này nhắm tới. */
  tick: number;
}
