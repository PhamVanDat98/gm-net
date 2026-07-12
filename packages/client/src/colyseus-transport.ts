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
  /** Có khi reservation đến từ `/matchmake/reconnect` — 0.16 dùng để nối lại đúng seat. */
  reconnectionToken?: string;
}

/**
 * Gọi một endpoint matchmake của Colyseus rồi **reshape** về dạng 0.16.
 *
 * Server `colyseus` 0.17 trả reservation PHẲNG `{name, roomId, processId,
 * sessionId, …}`, còn `colyseus.js` 0.16 (bản client mới nhất) mong dạng LỒNG
 * `{room: {...}, sessionId}` — lệch protocol đã lường ở [004] §7. Vì vậy cả join
 * lẫn **reconnect** đều phải tự gọi HTTP + reshape; `client.reconnect()` dựng sẵn
 * của 0.16 sẽ vỡ đúng ở chỗ này.
 */
async function matchmake(
  endpoint: string,
  method: 'joinOrCreate' | 'reconnect',
  nameOrRoomId: string,
  body: Record<string, unknown>,
): Promise<SeatReservation016> {
  const url = `${endpoint.replace(/^ws/, 'http')}/matchmake/${method}/${nameOrRoomId}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok || data.error !== undefined) {
    throw new Error(`matchmake ${method} ${nameOrRoomId} thất bại: ${String(data.error ?? res.status)}`);
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
    reconnectionToken: data.reconnectionToken as string | undefined,
  };
}

/** Đặt chỗ mới (join) — thay `client.joinOrCreate`, xem {@link matchmake}. */
async function reserveSeat(
  endpoint: string,
  roomName: string,
  options: Record<string, unknown> = {},
): Promise<SeatReservation016> {
  return matchmake(endpoint, 'joinOrCreate', roomName, options);
}

/**
 * Nối lại đúng seat cũ trong grace period ([006] §5) — thay `client.reconnect()`.
 * `Room.reconnectionToken` của 0.16 có dạng `"<roomId>:<token>"`.
 *
 * Server 0.17 **không trả `reconnectionToken` trong response matchmake** (chỉ
 * `{name, roomId, processId, sessionId}`), nhưng lại **đòi token đó trên query WS**
 * lúc bắt tay — thiếu là đóng với code 524 "bad reconnection token". Vậy phải tự
 * gắn token gốc vào reservation để `consumeSeatReservation` đính nó vào URL.
 */
async function reserveReconnect(endpoint: string, reconnectionToken: string): Promise<SeatReservation016> {
  const sep = reconnectionToken.indexOf(':');
  if (sep < 0) throw new Error(`reconnectionToken không hợp lệ: ${reconnectionToken}`);
  const roomId = reconnectionToken.slice(0, sep);
  const token = reconnectionToken.slice(sep + 1);
  const reservation = await matchmake(endpoint, 'reconnect', roomId, { reconnectionToken: token });
  return { ...reservation, reconnectionToken: reservation.reconnectionToken ?? token };
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

export interface ReconnectOptions extends ConnectOptions {
  /** Nhịp thử lại (ms). Mặc định 1000. */
  retryDelayMs?: number;
  /**
   * Tổng thời gian thử lại (ms) trước khi bỏ cuộc. Nên ≤ grace của server
   * (`reconnectGraceSeconds`, mặc định 30s) — thử lâu hơn là vô ích vì seat đã
   * bị giải phóng. Mặc định 25_000.
   */
  maxRetryMs?: number;
  /** Mất kết nối, bắt đầu thử lại. */
  onDisconnect?: (code: number) => void;
  /** Đã nối lại (server sẽ gửi handshake + keyframe ngay sau đó). */
  onReconnect?: () => void;
  /** Hết thời gian thử / server từ chối — phiên chơi kết thúc thật. */
  onGiveUp?: (err: unknown) => void;
}

/**
 * Transport tự nối lại sau khi rớt mạng ([006] §5, M8).
 *
 * `colyseus.js` trả về một **`Room` mới** sau `client.reconnect(token)`, nên
 * transport phải **rebind** được: listener của `GameClient` đăng ký một lần và
 * sống xuyên các lần reconnect; bên dưới ta gắn/tháo `Room` bên trong.
 *
 * Server gửi lại `handshake` khi nhận lại client → `GameClient` tự `resync()`
 * (vứt snapshot/ring/pending cũ), rồi keyframe kế tiếp dựng lại toàn bộ state.
 */
export async function connectReconnectingRoom(
  endpoint: string,
  opts: ReconnectOptions = {},
): Promise<{ client: Client; room: () => Room; transport: ClientTransport; dispose: () => void }> {
  const retryDelayMs = opts.retryDelayMs ?? 1000;
  const maxRetryMs = opts.maxRetryMs ?? 25_000;

  const client = new Client(endpoint);
  let room = await (async () => {
    const reservation = await reserveSeat(endpoint, opts.roomName ?? 'game', opts.joinOptions);
    return client.consumeSeatReservation(
      reservation as unknown as Parameters<Client['consumeSeatReservation']>[0],
    );
  })();

  let bytesCb: ((type: number, bytes: Uint8Array) => void) | undefined;
  let leaveCb: ((code: number) => void) | undefined;
  const jsonCbs = new Map<string, (payload: unknown) => void>();
  let leaving = false; // chủ động rời → không thử nối lại

  const bind = (r: Room): void => {
    r.onMessage('*', (type: string | number, message: unknown) => {
      if (typeof type === 'number') bytesCb?.(type, toUint8Array(message));
      else jsonCbs.get(type)?.(message);
    });
    r.onLeave((code: number) => {
      if (leaving) {
        leaveCb?.(code);
        return;
      }
      opts.onDisconnect?.(code);
      void retry(r.reconnectionToken);
    });
  };

  const retry = async (token: string): Promise<void> => {
    const deadline = Date.now() + maxRetryMs;
    let lastErr: unknown;
    while (!leaving && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
      if (leaving) return;
      try {
        const reservation = await reserveReconnect(endpoint, token);
        room = await client.consumeSeatReservation(
          reservation as unknown as Parameters<Client['consumeSeatReservation']>[0],
        );
        bind(room);
        opts.onReconnect?.();
        return;
      } catch (err) {
        lastErr = err; // mạng còn đứt / server chưa nhận lại → thử tiếp tới hết grace
      }
    }
    if (!leaving) {
      opts.onGiveUp?.(lastErr);
      leaveCb?.(0);
    }
  };

  bind(room);

  return {
    client,
    room: () => room,
    transport: {
      onBytes(cb) {
        bytesCb = cb;
      },
      onJson(type, cb) {
        jsonCbs.set(type, cb);
      },
      sendBytes(type, bytes) {
        // Trong lúc mất kết nối, gửi sẽ ném — nuốt: input của quãng đứt đằng nào
        // cũng vô nghĩa (server đã chạy tiếp; resync sẽ dựng lại state).
        try {
          room.sendBytes(type, bytes);
        } catch {
          /* đang rớt mạng */
        }
      },
      onLeave(cb) {
        leaveCb = cb;
      },
      leave() {
        leaving = true;
        void room.leave();
      },
    },
    dispose: () => {
      leaving = true;
    },
  };
}
