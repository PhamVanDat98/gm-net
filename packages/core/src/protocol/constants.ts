/**
 * Hằng số protocol wire — xem đặc tả [docs/design/005-serialization.md].
 *
 * `protocolVersion` trao trong handshake join (không lặp lại trong từng
 * message); lệch version → server từ chối join. Mỗi message mở đầu bằng 1 byte
 * `messageType`.
 */

/** Phiên bản wire protocol hiện tại (u8). Tăng khi format thay đổi phá vỡ. */
export const PROTOCOL_VERSION = 1;

/**
 * `ackTick` trong INPUT khi client **chưa nhận snapshot nào** ([005] §6).
 *
 * Không dùng 0 làm "chưa có": **tick 0 là tick hợp lệ**, và server sẽ tưởng client
 * đã có snapshot tick 0 → gửi delta dựa trên baseline mà client (join giữa chừng)
 * chưa bao giờ nhận → client bỏ hết delta cho tới khi baseline quá già. Sentinel
 * phải là giá trị không thể là tick thật.
 */
export const NO_ACK_TICK = 0xffff_ffff;

/**
 * Loại message, ghi ở byte đầu mỗi packet. Dùng object-const thay vì `enum`
 * cho hợp `isolatedModules` và tree-shaking.
 */
export const MessageType = {
  Input: 0,
  Snapshot: 1,
  Ping: 2,
  Pong: 3,
  /** Snapshot delta so với baseline client đã ack ([005] §4, M7). */
  Delta: 4,
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

/**
 * Bit trong `fieldMask` của một entity trong DELTA ([005] §4). `Full` = entity
 * mới (hoặc keyframe từng entity): mang `entityType` + toàn bộ field, không cần
 * baseline. Các bit còn lại: chỉ field đó có mặt trên dây.
 */
export const DeltaField = {
  PosX: 1 << 0,
  PosY: 1 << 1,
  Rot: 1 << 2,
  VelX: 1 << 3,
  VelY: 1 << 4,
  /** Khối custom của game đổi (so byte-với-byte — [005] §5). */
  Custom: 1 << 5,
  Full: 1 << 7,
} as const;
