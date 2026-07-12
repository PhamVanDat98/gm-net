/**
 * Logic room không phụ thuộc transport ([docs/design/006-server-rooms.md] §2).
 * Giữ world của game + jitter buffer per-client + tick counter; `GameRoom`
 * (Colyseus) chỉ là lớp vỏ bơm message vào/ra engine này. Tách vậy để test
 * "echo simulation, 2 client thấy nhau" deterministic không cần socket.
 */
import {
  MessageType,
  NO_ACK_TICK,
  PROTOCOL_VERSION,
  ProtocolCodec,
  TickRing,
  type PingMessage,
  type QuantizationConfig,
  type Snapshot,
  type SnapshotBaseline,
  type SnapshotEntity,
} from '@gm-net/core';
import { InputBuffer } from './input-buffer.js';
import type { GameCodecs, GameConfig, GameLogic, Handshake } from './game.js';

/** Gói state đã encode cho một client: DELTA hay SNAPSHOT (keyframe). */
export interface EncodedState {
  bytes: Uint8Array;
  /** `MessageType.Delta` hoặc `MessageType.Snapshot` — room gửi đúng kênh này. */
  type: number;
  keyframe: boolean;
}

interface ClientRecord<Input> {
  sessionId: string;
  entityId: number;
  buffer: InputBuffer<Input>;
  /**
   * Tick snapshot mới nhất client báo đã nhận (đính trong INPUT — [005] §6);
   * baseline để tính delta. -1 = chưa ack gì → phải gửi keyframe.
   */
  ackTick: number;
  /**
   * Tick của snapshot ĐẦU TIÊN server gửi cho client này (-1 = chưa gửi). Client
   * join giữa chừng không có snapshot nào trước mốc này — ack cũ hơn nó là không
   * hợp lệ (client hỏng/độc hại) và tuyệt đối không được dùng làm baseline.
   */
  firstSentTick: number;
}

/** Băng thông snapshot đo được ([008] Phase 2 — nghiệm thu M7). */
export interface SnapshotStats {
  /** Tổng byte snapshot/delta đã encode gửi đi. */
  bytesSent: number;
  /** Số full snapshot (keyframe) đã gửi. */
  keyframes: number;
  /** Số delta đã gửi. */
  deltas: number;
}

export interface RoomEngineOptions<World = unknown, Input = unknown> extends GameCodecs<Input> {
  game: GameLogic<World, Input>;
  config: GameConfig;
}

export class RoomEngine<World = unknown, Input = unknown> {
  readonly config: GameConfig;
  readonly stepMs: number;

  private readonly game: GameLogic<World, Input>;
  private readonly world: World;
  private readonly codec: ProtocolCodec<Input>;
  private readonly clients = new Map<string, ClientRecord<Input>>();

  private readonly protocolVersion: number;
  private readonly repeatLast: boolean;
  private readonly maxTickSkew: number;
  private readonly budgetPerTick: number;
  /** Ring history snapshot ([003] quyết định 5) — chỉ khi game có takeSnapshot. */
  private readonly history?: TickRing<unknown>;
  /**
   * Ring các snapshot ĐÃ GỬI (entity list) làm baseline delta ([005] §4). Delta
   * so trên giá trị quantize nên baseline phải đúng bản client đã nhận.
   */
  private readonly sentRing?: TickRing<readonly SnapshotEntity[]>;
  private readonly deltaEnabled: boolean;
  private readonly baselineTicks: number;
  private readonly stats: SnapshotStats = { bytesSent: 0, keyframes: 0, deltas: 0 };
  private entitiesCache: readonly SnapshotEntity[] | undefined;
  private entitiesTick = -1;
  private _tick = 0;

  constructor(opts: RoomEngineOptions<World, Input>) {
    this.game = opts.game;
    this.config = opts.config;
    this.stepMs = 1000 / opts.config.tickRate;
    this.protocolVersion = opts.config.protocolVersion ?? PROTOCOL_VERSION;
    this.repeatLast = opts.config.repeatLastInput ?? true;
    this.maxTickSkew = opts.config.maxTickSkewTicks ?? Math.round(opts.config.tickRate);
    this.budgetPerTick = opts.config.inputBudgetPerTick ?? 2;

    const quantization: QuantizationConfig = {
      world: opts.config.worldBounds,
      vMax: opts.config.vMax,
    };
    this.codec = new ProtocolCodec<Input>({
      quantization,
      inputCodec: opts.inputCodec,
      entityCodecs: opts.entityCodecs,
    });
    this.world = opts.game.createWorld(opts.config);

    const historyTicks = opts.config.snapshotHistoryTicks ?? 30;
    if (opts.game.takeSnapshot && historyTicks > 0) {
      this.history = new TickRing<unknown>(historyTicks);
      this.history.set(0, opts.game.takeSnapshot(this.world));
    }

    this.deltaEnabled = opts.config.deltaCompression ?? true;
    this.baselineTicks = opts.config.baselineHistoryTicks ?? Math.round(opts.config.tickRate);
    if (this.deltaEnabled && this.baselineTicks > 0) {
      this.sentRing = new TickRing<readonly SnapshotEntity[]>(this.baselineTicks);
    }
  }

  /** Số tick đã mô phỏng (cũng là serverTick của state hiện tại). */
  get tick(): number {
    return this._tick;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Truy cập world (cho test / hook nâng cao). */
  get worldState(): World {
    return this.world;
  }

  addClient(sessionId: string): { entityId: number; handshake: Handshake } {
    const entityId = this.game.onPlayerJoin(this.world, { sessionId, tick: this._tick });
    this.clients.set(sessionId, {
      sessionId,
      entityId,
      buffer: new InputBuffer<Input>({
        maxTickSkew: this.maxTickSkew,
        budgetPerTick: this.budgetPerTick,
      }),
      ackTick: -1, // chưa nhận snapshot nào → snapshot đầu tiên là keyframe
      firstSentTick: -1,
    });
    const handshake: Handshake = {
      protocolVersion: this.protocolVersion,
      tickRate: this.config.tickRate,
      worldBounds: this.config.worldBounds,
      entityId,
    };
    return { entityId, handshake };
  }

  removeClient(sessionId: string): void {
    const c = this.clients.get(sessionId);
    if (!c) return;
    this.game.onPlayerLeave(this.world, c.entityId);
    this.clients.delete(sessionId);
  }

  /** Nạp packet `INPUT` (bytes) từ một client. Byte rác → ném (caller nuốt). */
  ingestInput(sessionId: string, bytes: Uint8Array): void {
    const c = this.clients.get(sessionId);
    if (!c) return;
    const msg = this.codec.decodeInput(bytes);
    // ackTick chỉ tiến, không lùi: packet INPUT đến sai thứ tự (jitter) không
    // được kéo baseline về quá khứ. `NO_ACK_TICK` = client chưa có snapshot nào.
    if (msg.ackTick !== NO_ACK_TICK && msg.ackTick > c.ackTick) c.ackTick = msg.ackTick;
    c.buffer.ingest(msg, this._tick);
  }

  /** Một bước: rút input mỗi client → applyInput → simulate → tăng tick. */
  advance(): void {
    const t = this._tick;
    for (const c of this.clients.values()) {
      const taken = c.buffer.take(t, this.repeatLast);
      if (taken && taken.payload !== undefined) {
        this.game.applyInput(this.world, c.entityId, taken.payload, t);
      }
    }
    this.game.simulate(this.world, this.stepMs, t);
    this._tick = t + 1;
    // Slot tick = state SAU KHI mô phỏng xong tick t (cùng semantics serverTick
    // trong snapshot gửi client).
    this.history?.set(this._tick, this.game.takeSnapshot!(this.world));
  }

  /**
   * Snapshot world tại `tick` từ ring history (M4; lag compensation M10 dùng).
   * `undefined` khi ngoài ring / game không có `takeSnapshot`.
   */
  snapshotAt(tick: number): unknown {
    return this.history?.get(tick);
  }

  /** Client này đã có record trong engine chưa (room dùng để guard tick loop). */
  hasClient(sessionId: string): boolean {
    return this.clients.has(sessionId);
  }

  /**
   * State gửi cho một client tại tick hiện tại: **delta** so với baseline client
   * đã ack nếu baseline còn trong ring, ngược lại **keyframe** (full snapshot).
   *
   * Keyframe khi: chưa ack gì (join/reconnect), baseline già hơn ring (~1s —
   * client ngộp/loss dài), hoặc delta tắt trong config ([005] §4).
   *
   * Header (`lastProcessedSeq`, `lateInputs`) riêng từng client; `lateInputs` là
   * delta kể từ snapshot trước (consume-on-read).
   */
  encodeSnapshotFor(sessionId: string): EncodedState {
    const c = this.clients.get(sessionId);
    if (!c) throw new Error(`RoomEngine: client không tồn tại (${sessionId})`);

    const entities = this.currentEntities();
    const snap: Snapshot = {
      serverTick: this._tick,
      lastProcessedSeq: c.buffer.lastProcessedSeq,
      lateInputs: Math.min(255, c.buffer.consumeLateInputs()),
      entities: entities as SnapshotEntity[],
    };

    const baseline = this.baselineFor(c);
    const bytes = baseline
      ? this.codec.encodeDelta(snap, baseline)
      : this.codec.encodeSnapshot(snap);

    // State tick này giờ là baseline hợp lệ cho các delta sau (client sẽ ack nó).
    this.sentRing?.set(this._tick, entities);
    if (c.firstSentTick < 0) c.firstSentTick = this._tick;

    this.stats.bytesSent += bytes.byteLength;
    if (baseline) this.stats.deltas++;
    else this.stats.keyframes++;

    return { bytes, type: baseline ? MessageType.Delta : MessageType.Snapshot, keyframe: !baseline };
  }

  /** Entity list của tick hiện tại, đọc một lần rồi dùng chung cho mọi client. */
  private currentEntities(): readonly SnapshotEntity[] {
    if (this.entitiesTick !== this._tick || !this.entitiesCache) {
      this.entitiesCache = this.game.readEntities(this.world);
      this.entitiesTick = this._tick;
    }
    return this.entitiesCache;
  }

  /**
   * Baseline dùng được cho client này, hoặc `undefined` → phải gửi keyframe.
   *
   * Chỉ nhận baseline mà server **đã thật sự gửi cho chính client này**: ack cũ
   * hơn snapshot đầu tiên nó nhận (client join giữa chừng) là baseline nó không
   * có — delta dựa vào đó sẽ bị client bỏ hết, mất mẫu interpolation.
   *
   * Ngưỡng tuổi dùng `>=` (không phải `>`): ring baseline phía client cùng cỡ
   * `baselineTicks`, nên tick ở đúng tuổi `baselineTicks` đã bị ghi đè bên đó.
   */
  private baselineFor(c: ClientRecord<Input>): SnapshotBaseline | undefined {
    if (!this.sentRing || c.ackTick < 0) return undefined;
    if (c.firstSentTick < 0 || c.ackTick < c.firstSentTick) return undefined;
    if (this._tick - c.ackTick >= this.baselineTicks) return undefined; // baseline quá già
    const entities = this.sentRing.get(c.ackTick);
    return entities ? { serverTick: c.ackTick, entities } : undefined;
  }

  /** Số liệu băng thông snapshot (nghiệm thu M7). */
  snapshotStats(): SnapshotStats {
    return { ...this.stats };
  }

  decodePing(bytes: Uint8Array): PingMessage {
    return this.codec.decodePing(bytes);
  }

  encodePong(clientTime: number, serverTime: number): Uint8Array {
    return this.codec.encodePong({ clientTime, serverTime, serverTick: this._tick });
  }
}
