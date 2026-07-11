/**
 * @gm-net/shared — simulation logic, input schema và constants dùng chung
 * giữa client và server, đảm bảo prediction khớp authoritative simulation.
 */
import type { WorldBounds } from '@gm-net/core';

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

/**
 * Handshake JSON server gửi cho client lúc join ([docs/design/006-server-rooms.md]
 * §1, [004] §7). Đi qua kênh Colyseus có sẵn (JSON, tần suất thấp). Hợp đồng
 * dùng chung nên đặt ở shared — cả server (phát) lẫn client (nhận) đều import.
 */
export interface Handshake {
  /** Version wire protocol; lệch → client từ chối chơi tiếp. */
  protocolVersion: number;
  /** Tần số tick server (Hz) — client dùng để căn timestep sim. */
  tickRate: number;
  /** Biên thế giới để dequantize position. */
  worldBounds: WorldBounds;
  /** Entity mà client này điều khiển (local player). */
  entityId: number;
}
