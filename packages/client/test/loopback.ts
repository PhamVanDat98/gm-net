/**
 * Harness loopback in-memory cho nghiệm thu M3: nối `GameClient` với một "echo
 * server" tối giản (chỉ dùng `@gm-net/core`, KHÔNG import `@gm-net/server` để giữ
 * ranh giới client↮server) qua transport có độ trễ cấu hình được. Đồng hồ ảo:
 * `now` do harness quản, client đọc qua `now: () => lb.now`.
 *
 * Mô phỏng RTT bằng trễ một chiều `oneWayMs`; message giao đúng thời điểm khi
 * `advance()` đẩy đồng hồ qua mốc đến. Đủ để đo clock sync + chứng minh box di
 * chuyển; e2e socket thật để M5.
 */
import {
  MessageType,
  ProtocolCodec,
  seqGreater,
  type BitReader,
  type BitWriter,
  type CustomCodec,
} from '@gm-net/core';
import type { ClientTransport } from '../src/index.js';

export interface EchoInput {
  dx: number;
  dy: number;
}

export const echoInputCodec: CustomCodec<EchoInput> = {
  encode(w: BitWriter, s: EchoInput): void {
    w.writeI16(Math.round(s.dx * 1000));
    w.writeI16(Math.round(s.dy * 1000));
  },
  decode(r: BitReader): EchoInput {
    return { dx: r.readI16() / 1000, dy: r.readI16() / 1000 };
  },
};

export const quantization = {
  world: { minX: -100, maxX: 100, minY: -100, maxY: 100 },
  vMax: 50,
};

export function makeCodec(): ProtocolCodec<EchoInput> {
  return new ProtocolCodec<EchoInput>({ quantization, inputCodec: echoInputCodec });
}

/** Echo server tối giản: state = vị trí cộng dồn từ input tại tick nhắm tới. */
class EchoServer {
  private readonly codec = makeCodec();
  tick = 0;
  readonly entityId = 1;
  private x = 0;
  private y = 0;
  private vx = 0;
  private vy = 0;
  private highestSeq = -1;
  private lastProcessedSeq = 0;
  private lateWindow = 0;
  private readonly pending = new Map<number, { seq: number; dx: number; dy: number }>();

  ingest(bytes: Uint8Array): void {
    const msg = this.codec.decodeInput(bytes);
    const count = msg.inputs.length;
    for (let i = 0; i < count; i++) {
      const seq = (msg.latestSeq - (count - 1) + i) & 0xffff;
      if (this.highestSeq >= 0 && !seqGreater(seq, this.highestSeq)) continue;
      this.highestSeq = seq;
      const entry = msg.inputs[i];
      if (entry.tick < this.tick) {
        this.lateWindow++;
        continue;
      }
      this.pending.set(entry.tick, { seq, dx: entry.payload!.dx, dy: entry.payload!.dy });
    }
  }

  advance(): void {
    const inp = this.pending.get(this.tick);
    if (inp) {
      this.x += inp.dx;
      this.y += inp.dy;
      this.vx = inp.dx;
      this.vy = inp.dy;
      this.lastProcessedSeq = inp.seq;
      this.pending.delete(this.tick);
    }
    for (const t of this.pending.keys()) if (t < this.tick) this.pending.delete(t);
    this.tick++;
  }

  snapshotBytes(): Uint8Array {
    const late = this.lateWindow;
    this.lateWindow = 0;
    return this.codec.encodeSnapshot({
      serverTick: this.tick,
      lastProcessedSeq: this.lastProcessedSeq,
      lateInputs: Math.min(255, late),
      entities: [
        { entityId: this.entityId, entityType: 0, posX: this.x, posY: this.y, rot: 0, velX: this.vx, velY: this.vy },
      ],
    });
  }

  pongBytes(pingBytes: Uint8Array): Uint8Array {
    const ping = this.codec.decodePing(pingBytes);
    return this.codec.encodePong({ clientTime: ping.clientTime, serverTime: 0, serverTick: this.tick });
  }
}

interface Delayed {
  at: number;
  type: number;
  bytes: Uint8Array;
}

export class Loopback {
  now = 0;
  readonly server = new EchoServer();
  readonly transport: ClientTransport;

  private toServer: Delayed[] = [];
  private toClient: Delayed[] = [];
  private bytesCb: ((type: number, bytes: Uint8Array) => void) | undefined;
  private readonly jsonCbs = new Map<string, (payload: unknown) => void>();

  constructor(private readonly oneWayMs: number) {
    this.transport = {
      onBytes: (cb) => {
        this.bytesCb = cb;
      },
      onJson: (type, cb) => {
        this.jsonCbs.set(type, cb);
      },
      sendBytes: (type, bytes) => {
        this.toServer.push({ at: this.now + this.oneWayMs, type, bytes });
      },
      onLeave: () => {},
      leave: () => {},
    };
  }

  /** Phát handshake JSON cho client (như server gửi lúc join). */
  join(): void {
    this.jsonCbs.get('handshake')?.({
      protocolVersion: 1,
      tickRate: 30,
      worldBounds: quantization.world,
      entityId: this.server.entityId,
    });
  }

  /** Đẩy đồng hồ `ms` và giao mọi message tới hạn (cả hai chiều). */
  advance(ms: number): void {
    this.now += ms;
    const dueServer = this.toServer.filter((m) => m.at <= this.now);
    this.toServer = this.toServer.filter((m) => m.at > this.now);
    for (const m of dueServer) {
      if (m.type === MessageType.Input) this.server.ingest(m.bytes);
      else if (m.type === MessageType.Ping) this.sendToClient(MessageType.Pong, this.server.pongBytes(m.bytes));
    }
    const dueClient = this.toClient.filter((m) => m.at <= this.now);
    this.toClient = this.toClient.filter((m) => m.at > this.now);
    for (const m of dueClient) this.bytesCb?.(m.type, m.bytes);
  }

  /** Một tick server: mô phỏng rồi phát snapshot (trễ một chiều). */
  serverTick(): void {
    this.server.advance();
    this.sendToClient(MessageType.Snapshot, this.server.snapshotBytes());
  }

  private sendToClient(type: number, bytes: Uint8Array): void {
    this.toClient.push({ at: this.now + this.oneWayMs, type, bytes });
  }
}
