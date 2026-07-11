/**
 * Proxy giả lập điều kiện mạng thuần Node ([docs/design/008-roadmap.md] §5,
 * IMPLEMENTATION 5.3): đứng giữa client và game server, chèn **delay mỗi
 * chiều** + **drop ngẫu nhiên theo tỉ lệ** ở mức message WebSocket. Chạy được
 * Windows/CI không cần quyền admin (`tc netem`/clumsy không có), tái lập chính
 * xác nhờ PRNG seed được.
 *
 * Vì WS chạy trên TCP (reliable), "packet loss" giả lập ở đây = **drop nguyên
 * một message WS** — đúng semantics mà netcode UDP-style của framework cần
 * (INPUT có redundancy, SNAPSHOT bản sau thay bản trước, PING/PONG lặp lại).
 *
 * Hai kênh:
 * - HTTP thường (matchmaking Colyseus — control plane, tần suất thấp): forward
 *   nguyên vẹn, không delay/drop.
 * - WS upgrade (game traffic): mỗi kết nối client ↔ proxy ghép một kết nối
 *   proxy ↔ server; message hai chiều đi qua hàng delay + xúc xắc drop.
 *   `graceMs` đầu kết nối không drop — để join/handshake (đi kênh reliable
 *   trong transport thật) không bị nghẽn bởi giả lập loss.
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

export type Direction = 'toServer' | 'toClient';

export interface NetemOptions {
  /** Port proxy lắng nghe. 0 = hệ điều hành cấp (đọc lại qua `port`). */
  listenPort: number;
  /** Host server thật. Mặc định 127.0.0.1. */
  targetHost?: string;
  /** Port server thật. */
  targetPort: number;
  /** Delay mỗi chiều (ms) — số chung hoặc riêng từng chiều. Mặc định 0. */
  delayMs?: number | { toServer?: number; toClient?: number };
  /** Xác suất drop mỗi message [0,1]. Mặc định 0. */
  dropRate?: number;
  /** Cửa sổ đầu kết nối không drop (ms). Mặc định 1000. */
  graceMs?: number;
  /** Seed PRNG cho drop — tái lập được trong test. Mặc định 1. */
  seed?: number;
  /** Lọc message được phép drop (mặc định: mọi message sau grace). */
  shouldDrop?: (direction: Direction, data: Uint8Array) => boolean;
}

export interface NetemStats {
  forwarded: { toServer: number; toClient: number };
  dropped: { toServer: number; toClient: number };
  connections: number;
}

export interface NetemProxy {
  /** Bắt đầu lắng nghe; trả port thực (hữu ích khi listenPort = 0). */
  listen(): Promise<number>;
  /** Port đang lắng nghe (-1 khi chưa listen). */
  readonly port: number;
  stats(): NetemStats;
  close(): Promise<void>;
}

/** PRNG mulberry32 — đủ tốt cho xúc xắc drop, seed được. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toUint8Array(data: RawData): Uint8Array {
  if (data instanceof Buffer) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return Buffer.concat(data as Buffer[]);
}

export function createNetemProxy(opts: NetemOptions): NetemProxy {
  const targetHost = opts.targetHost ?? '127.0.0.1';
  const delayToServer = typeof opts.delayMs === 'number' ? opts.delayMs : (opts.delayMs?.toServer ?? 0);
  const delayToClient = typeof opts.delayMs === 'number' ? opts.delayMs : (opts.delayMs?.toClient ?? 0);
  const dropRate = opts.dropRate ?? 0;
  const graceMs = opts.graceMs ?? 1000;
  const rand = mulberry32(opts.seed ?? 1);

  const stats: NetemStats = {
    forwarded: { toServer: 0, toClient: 0 },
    dropped: { toServer: 0, toClient: 0 },
    connections: 0,
  };

  const sockets = new Set<WebSocket>();
  const timers = new Set<NodeJS.Timeout>();

  const server = http.createServer((req, res) => forwardHttp(req, res));
  const wss = new WebSocketServer({ noServer: true });

  function forwardHttp(req: IncomingMessage, res: ServerResponse): void {
    const upstream = http.request(
      {
        host: targetHost,
        port: opts.targetPort,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: `${targetHost}:${opts.targetPort}` },
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502);
      res.end('netem-proxy: upstream error');
    });
    req.pipe(upstream);
  }

  function relay(from: WebSocket, to: WebSocket, direction: Direction, connectedAt: number): void {
    // Giữ thứ tự message: delay cố định per chiều + hàng đợi FIFO khi socket
    // đích chưa mở (upstream connect chậm hơn downstream) — flush một lượt
    // trong MỘT listener 'open' duy nhất.
    const pending: Array<{ data: Uint8Array; isBinary: boolean }> = [];
    to.once('open', () => {
      for (const m of pending) {
        to.send(m.data, { binary: m.isBinary });
        stats.forwarded[direction]++;
      }
      pending.length = 0;
    });
    from.on('message', (raw, isBinary) => {
      const data = toUint8Array(raw);
      const inGrace = Date.now() - connectedAt < graceMs;
      const droppable = opts.shouldDrop ? opts.shouldDrop(direction, data) : true;
      if (!inGrace && droppable && dropRate > 0 && rand() < dropRate) {
        stats.dropped[direction]++;
        return;
      }
      const deliver = () => {
        if (to.readyState === WebSocket.OPEN) {
          to.send(data, { binary: isBinary });
          stats.forwarded[direction]++;
        } else if (to.readyState === WebSocket.CONNECTING) {
          pending.push({ data, isBinary });
        } // CLOSED: bỏ — phía kia đang đóng.
      };
      const delay = direction === 'toServer' ? delayToServer : delayToClient;
      if (delay <= 0) {
        deliver();
      } else {
        const t = setTimeout(() => {
          timers.delete(t);
          deliver();
        }, delay);
        timers.add(t);
      }
    });
    from.on('close', (code, reason) => {
      // Đóng nốt chiều kia sau khi message đang trên đường đã kịp giao.
      const delay = direction === 'toServer' ? delayToServer : delayToClient;
      const t = setTimeout(() => {
        timers.delete(t);
        if (to.readyState === WebSocket.OPEN || to.readyState === WebSocket.CONNECTING) {
          to.close(code >= 1000 && code < 5000 ? code : 1000, reason);
        }
      }, delay);
      timers.add(t);
    });
    from.on('error', () => from.close());
  }

  function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    wss.handleUpgrade(req, socket, head, (downstream) => {
      stats.connections++;
      const upstream = new WebSocket(`ws://${targetHost}:${opts.targetPort}${req.url ?? '/'}`);
      sockets.add(downstream);
      sockets.add(upstream);
      downstream.on('close', () => sockets.delete(downstream));
      upstream.on('close', () => sockets.delete(upstream));
      upstream.on('error', () => downstream.close());

      const connectedAt = Date.now();
      relay(downstream, upstream, 'toServer', connectedAt);
      relay(upstream, downstream, 'toClient', connectedAt);
    });
  }

  server.on('upgrade', onUpgrade);

  let port = -1;
  return {
    get port() {
      return port;
    },
    listen(): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.listenPort, () => {
          const addr = server.address();
          port = typeof addr === 'object' && addr ? addr.port : opts.listenPort;
          resolve(port);
        });
      });
    },
    stats: () => ({
      forwarded: { ...stats.forwarded },
      dropped: { ...stats.dropped },
      connections: stats.connections,
    }),
    close(): Promise<void> {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const s of sockets) s.terminate();
      sockets.clear();
      wss.close();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
