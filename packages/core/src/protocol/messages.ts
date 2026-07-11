/**
 * Encode/decode 4 message wire ([docs/design/005-serialization.md] §3, §6 và
 * mục PING/PONG). Framework lo transform + envelope; field gameplay do game
 * đăng ký qua {@link CustomCodec} per `entityType` (snapshot) và một codec cho
 * payload input (§5).
 *
 * Mọi format ở đây là **[ĐỀ XUẤT]**: đổi layout thì golden-byte test đỏ, ép cập
 * nhật doc 005 trong cùng commit.
 */
import { BitWriter } from '../serialization/bit-writer.js';
import { BitReader } from '../serialization/bit-reader.js';
import {
  quantizeScalar,
  dequantizeScalar,
  quantizeAngle,
  dequantizeAngle,
  quantizeVelocity,
  dequantizeVelocity,
  type QuantizationConfig,
} from '../serialization/quantize.js';
import { MessageType } from './constants.js';

/** Codec do game cung cấp cho khối field gameplay (HP, ammo, anim…). */
export interface CustomCodec<T = unknown> {
  encode(writer: BitWriter, state: T): void;
  decode(reader: BitReader): T;
}

export interface SnapshotEntity<C = unknown> {
  entityId: number;
  entityType: number;
  posX: number;
  posY: number;
  /** Góc radian. */
  rot: number;
  velX: number;
  velY: number;
  /** State gameplay tùy game; có khi và chỉ khi `entityType` có codec đăng ký. */
  custom?: C;
}

export interface Snapshot {
  serverTick: number;
  /** Ack seq cao nhất đã xử lý cho riêng client nhận (ghi lúc gửi từng client). */
  lastProcessedSeq: number;
  /** Số input muộn kể từ snapshot trước (u8) — nuôi adaptive input lead phía client. */
  lateInputs: number;
  entities: SnapshotEntity[];
}

export interface InputEntry<P = unknown> {
  /** Tick mô phỏng input này nhắm tới. */
  tick: number;
  payload?: P;
}

export interface InputMessage<P = unknown> {
  /** Snapshot tick mới nhất client đã nhận (phục vụ delta compression §4). */
  ackTick: number;
  /** Seq của input mới nhất trong packet. Seq các input trước suy ra tuần tự. */
  latestSeq: number;
  /** Redundancy 3–5 input, thứ tự cũ → mới. */
  inputs: InputEntry<P>[];
}

export interface PingMessage {
  /** Đồng hồ client (ms, cắt còn u32) lúc gửi — dùng đo RTT. */
  clientTime: number;
}

export interface PongMessage {
  /** Echo `clientTime` của ping. */
  clientTime: number;
  /** Đồng hồ server (ms, u32) lúc trả — ước lượng offset đồng hồ. */
  serverTime: number;
  /** Tick server lúc trả pong — ước lượng `serverTickNow`. */
  serverTick: number;
}

export interface ProtocolCodecOptions {
  quantization: QuantizationConfig;
  /** Custom state codec cho từng `entityType`. */
  entityCodecs?: Map<number, CustomCodec>;
  /** Codec payload input của game. */
  inputCodec?: CustomCodec;
  /** Dung lượng buffer khởi tạo cho writer (byte). */
  initialCapacity?: number;
}

/** Lỗi giải mã do byte không hợp lệ (sai messageType…). */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

const MAX_INPUT_COUNT = 0xff;

/** Loại message ở byte đầu, không dịch chuyển con trỏ đọc. */
export function peekMessageType(bytes: Uint8Array): number {
  if (bytes.byteLength < 1) {
    throw new ProtocolError('packet rỗng, không có messageType');
  }
  return bytes[0];
}

/**
 * Gói quantization config + registry custom codec, phát ra/đọc vào 4 message.
 * Client và server dùng chung một instance-config để đảm bảo wire khớp.
 */
export class ProtocolCodec<InputPayload = unknown> {
  private readonly q: QuantizationConfig;
  private readonly entityCodecs: Map<number, CustomCodec>;
  private readonly inputCodec?: CustomCodec<InputPayload>;
  private readonly initialCapacity: number;

  constructor(options: ProtocolCodecOptions) {
    this.q = options.quantization;
    this.entityCodecs = options.entityCodecs ?? new Map();
    this.inputCodec = options.inputCodec as CustomCodec<InputPayload> | undefined;
    this.initialCapacity = options.initialCapacity ?? 256;
  }

  private newWriter(): BitWriter {
    return new BitWriter(this.initialCapacity);
  }

  private expectType(reader: BitReader, expected: number, label: string): void {
    const type = reader.readU8();
    if (type !== expected) {
      throw new ProtocolError(`mong ${label} (type ${expected}) nhưng nhận type ${type}`);
    }
  }

  // --- SNAPSHOT (§3) ---

  encodeSnapshot(snap: Snapshot): Uint8Array {
    const { world, vMax } = this.q;
    const w = this.newWriter();
    w.writeU8(MessageType.Snapshot);
    w.writeU32(snap.serverTick);
    w.writeU16(snap.lastProcessedSeq);
    w.writeU8(snap.lateInputs);
    w.writeU16(snap.entities.length);
    for (const e of snap.entities) {
      w.writeU16(e.entityId);
      w.writeU8(e.entityType);
      w.writeU16(quantizeScalar(e.posX, world.minX, world.maxX));
      w.writeU16(quantizeScalar(e.posY, world.minY, world.maxY));
      w.writeU16(quantizeAngle(e.rot));
      w.writeI16(quantizeVelocity(e.velX, vMax));
      w.writeI16(quantizeVelocity(e.velY, vMax));
      const codec = this.entityCodecs.get(e.entityType);
      if (codec) codec.encode(w, e.custom);
    }
    return w.toUint8Array();
  }

  decodeSnapshot(bytes: Uint8Array): Snapshot {
    const { world, vMax } = this.q;
    const r = new BitReader(bytes);
    this.expectType(r, MessageType.Snapshot, 'SNAPSHOT');
    const serverTick = r.readU32();
    const lastProcessedSeq = r.readU16();
    const lateInputs = r.readU8();
    const count = r.readU16();
    const entities: SnapshotEntity[] = [];
    for (let i = 0; i < count; i++) {
      const entityId = r.readU16();
      const entityType = r.readU8();
      const posX = dequantizeScalar(r.readU16(), world.minX, world.maxX);
      const posY = dequantizeScalar(r.readU16(), world.minY, world.maxY);
      const rot = dequantizeAngle(r.readU16());
      const velX = dequantizeVelocity(r.readI16(), vMax);
      const velY = dequantizeVelocity(r.readI16(), vMax);
      const codec = this.entityCodecs.get(entityType);
      const custom = codec ? codec.decode(r) : undefined;
      entities.push({ entityId, entityType, posX, posY, rot, velX, velY, custom });
    }
    return { serverTick, lastProcessedSeq, lateInputs, entities };
  }

  // --- INPUT (§6) ---

  encodeInput(msg: InputMessage<InputPayload>): Uint8Array {
    if (msg.inputs.length > MAX_INPUT_COUNT) {
      throw new ProtocolError(`INPUT count ${msg.inputs.length} vượt ${MAX_INPUT_COUNT}`);
    }
    const w = this.newWriter();
    w.writeU8(MessageType.Input);
    w.writeU32(msg.ackTick);
    w.writeU16(msg.latestSeq);
    w.writeU8(msg.inputs.length);
    for (const entry of msg.inputs) {
      w.writeU32(entry.tick);
      if (this.inputCodec) this.inputCodec.encode(w, entry.payload as InputPayload);
    }
    return w.toUint8Array();
  }

  decodeInput(bytes: Uint8Array): InputMessage<InputPayload> {
    const r = new BitReader(bytes);
    this.expectType(r, MessageType.Input, 'INPUT');
    const ackTick = r.readU32();
    const latestSeq = r.readU16();
    const count = r.readU8();
    const inputs: InputEntry<InputPayload>[] = [];
    for (let i = 0; i < count; i++) {
      const tick = r.readU32();
      const payload = this.inputCodec ? this.inputCodec.decode(r) : undefined;
      inputs.push({ tick, payload });
    }
    return { ackTick, latestSeq, inputs };
  }

  // --- PING / PONG ---

  encodePing(msg: PingMessage): Uint8Array {
    const w = this.newWriter();
    w.writeU8(MessageType.Ping);
    w.writeU32(msg.clientTime);
    return w.toUint8Array();
  }

  decodePing(bytes: Uint8Array): PingMessage {
    const r = new BitReader(bytes);
    this.expectType(r, MessageType.Ping, 'PING');
    return { clientTime: r.readU32() };
  }

  encodePong(msg: PongMessage): Uint8Array {
    const w = this.newWriter();
    w.writeU8(MessageType.Pong);
    w.writeU32(msg.clientTime);
    w.writeU32(msg.serverTime);
    w.writeU32(msg.serverTick);
    return w.toUint8Array();
  }

  decodePong(bytes: Uint8Array): PongMessage {
    const r = new BitReader(bytes);
    this.expectType(r, MessageType.Pong, 'PONG');
    return {
      clientTime: r.readU32(),
      serverTime: r.readU32(),
      serverTick: r.readU32(),
    };
  }
}
