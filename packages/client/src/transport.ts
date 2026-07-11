/**
 * Ranh giới transport phía client ([docs/design/004-netcode.md] §7). `GameClient`
 * chỉ nói chuyện qua interface này, không nhắc tên Colyseus — cùng triết lý tách
 * logic/transport như `RoomEngine` phía server, để test được bằng transport giả
 * (không cần socket) và thay implement (colyseus.js, in-memory loopback…) tự do.
 *
 * Quy ước kênh (khớp `GameRoom` phía server):
 * - Message nhị phân theo `MessageType` (SNAPSHOT, PONG) đi qua {@link onBytes}.
 * - Handshake JSON đi qua {@link onJson} với type `"handshake"`.
 * - Client gửi INPUT/PING nhị phân qua {@link sendBytes}.
 */
export interface ClientTransport {
  /** Đăng ký nhận mọi message nhị phân; `type` là `MessageType` ở byte đầu. */
  onBytes(cb: (type: number, bytes: Uint8Array) => void): void;
  /** Đăng ký nhận một message JSON theo tên kênh (vd `"handshake"`). */
  onJson(type: string, cb: (payload: unknown) => void): void;
  /** Gửi message nhị phân (INPUT/PING) lên server. */
  sendBytes(type: number, bytes: Uint8Array): void;
  /** Server/kết nối đóng (code Colyseus hoặc 0). */
  onLeave(cb: (code: number) => void): void;
  /** Chủ động rời room. */
  leave(): void;
}
