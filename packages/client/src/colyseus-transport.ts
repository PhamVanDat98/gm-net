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

/** SeatReservation theo shape colyseus.js 0.16 (`consumeSeatReservation`). */
interface SeatReservation016 {
  room: { name: string; roomId: string; processId: string; publicAddress?: string };
  sessionId: string;
}

/**
 * Matchmake HTTP tự làm thay `client.joinOrCreate`: server `colyseus` 0.17 trả
 * reservation dạng PHẲNG `{name, roomId, processId, sessionId}` trong khi
 * colyseus.js 0.16 (bản client mới nhất) mong dạng lồng `{room: {...},
 * sessionId}` — lệch protocol đã lường ở [004] §7; reshape ở đây rồi đưa vào
 * `consumeSeatReservation` (đường WS + room protocol hai bản vẫn khớp).
 */
async function reserveSeat(
  endpoint: string,
  roomName: string,
  options: Record<string, unknown> = {},
): Promise<SeatReservation016> {
  const url = `${endpoint.replace(/^ws/, 'http')}/matchmake/joinOrCreate/${roomName}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(options),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok || data.error !== undefined) {
    throw new Error(`matchmake ${roomName} thất bại: ${String(data.error ?? res.status)}`);
  }
  if (typeof data.room === 'object' && data.room !== null) {
    return data as unknown as SeatReservation016; // server 0.16: shape cũ, dùng thẳng
  }
  return {
    room: {
      name: data.name as string,
      roomId: data.roomId as string,
      processId: data.processId as string,
      publicAddress: data.publicAddress as string | undefined,
    },
    sessionId: data.sessionId as string,
  };
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
  const reservation = await reserveSeat(endpoint, opts.roomName ?? 'game', opts.joinOptions);
  const room = await client.consumeSeatReservation(
    // 0.16 khai báo room: RoomAvailable (clients/maxClients) nhưng chỉ đọc
    // name/roomId/processId/publicAddress — reservation 0.17 không có hai field kia.
    reservation as unknown as Parameters<Client['consumeSeatReservation']>[0],
  );
  return { client, room, transport: colyseusTransport(room) };
}
