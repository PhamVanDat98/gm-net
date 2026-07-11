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
 * Loại message, ghi ở byte đầu mỗi packet. Dùng object-const thay vì `enum`
 * cho hợp `isolatedModules` và tree-shaking.
 */
export const MessageType = {
  Input: 0,
  Snapshot: 1,
  Ping: 2,
  Pong: 3,
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];
