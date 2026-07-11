/**
 * Adapter `colyseus.js Room` → {@link ClientTransport}. Lớp mỏng duy nhất trong
 * @gm-net/client biết tới Colyseus — mọi module khác nói qua interface, nên phần
 * lõi netcode test được không cần socket (giống `RoomEngine` tách khỏi `GameRoom`
 * phía server).
 *
 * Lưu ý version: server dùng `colyseus` 0.17, client `colyseus.js` mới nhất là
 * 0.16 (chưa có bản 0.17). Base join + `onMessage`/`sendBytes` ổn định giữa hai
 * bản, nhưng e2e socket thật để nghiệm thu ở M5 — nếu lệch protocol, ghim
 * `colyseus.js` theo bản khớp lúc đó.
 */
import type { Room } from 'colyseus.js';
import { Client } from 'colyseus.js';
import type { ClientTransport } from './transport.js';

/** Chuẩn hóa payload nhị phân colyseus (ArrayBuffer/Buffer) về `Uint8Array`. */
function toUint8Array(message: unknown): Uint8Array {
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  // Buffer (Node) là Uint8Array subclass — nhánh đầu đã bắt; còn lại coi rỗng.
  return new Uint8Array(0);
}

/** Bọc một `Room` đã join thành `ClientTransport`. */
export function colyseusTransport(room: Room): ClientTransport {
  let bytesCb: ((type: number, bytes: Uint8Array) => void) | undefined;
  let leaveCb: ((code: number) => void) | undefined;
  const jsonCbs = new Map<string, (payload: unknown) => void>();

  // '*' bắt mọi message: type số = nhị phân (SNAPSHOT/PONG), type chuỗi = JSON.
  room.onMessage('*', (type: string | number, message: unknown) => {
    if (typeof type === 'number') {
      bytesCb?.(type, toUint8Array(message));
    } else {
      jsonCbs.get(type)?.(message);
    }
  });
  room.onLeave((code: number) => leaveCb?.(code));

  return {
    onBytes(cb) {
      bytesCb = cb;
    },
    onJson(type, cb) {
      jsonCbs.set(type, cb);
    },
    sendBytes(type, bytes) {
      room.sendBytes(type, bytes);
    },
    onLeave(cb) {
      leaveCb = cb;
    },
    leave() {
      void room.leave();
    },
  };
}

export interface ConnectOptions {
  /** Tên room khớp `roomName` khi `createGameServer` (mặc định "game"). */
  roomName?: string;
  /** Options join gửi lên server (matchmaking). */
  joinOptions?: Record<string, unknown>;
}

/**
 * Tiện ích join một `GameRoom` và trả sẵn transport. Dùng cho client Node/browser
 * thật (demo M5, headless bot Phase 2). `endpoint` vd `ws://localhost:2567`.
 */
export async function connectGameRoom(
  endpoint: string,
  opts: ConnectOptions = {},
): Promise<{ client: Client; room: Room; transport: ClientTransport }> {
  const client = new Client(endpoint);
  const room = await client.joinOrCreate(opts.roomName ?? 'game', opts.joinOptions);
  return { client, room, transport: colyseusTransport(room) };
}
