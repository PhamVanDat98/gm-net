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
import { InterestGrid } from './aoi.js';
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
  /** Đang có socket (false = rớt mạng, đang trong grace period — [006] §5). */
  connected: boolean;
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
  /**
   * Ring snapshot ĐÃ GỬI cho riêng client này, làm baseline delta ([005] §4).
   * Per-client (không dùng chung theo room) vì AOI (M9) khiến mỗi client thấy một
   * tập entity khác nhau — baseline phải đúng cái nó đã nhận.
   */
  sentRing?: TickRing<readonly SnapshotEntity[]>;
  /** Tập entityId client đang thấy (AOI, M9) — đầu vào của hysteresis tick sau. */
  visible: Set<number>;
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
  private readonly deltaEnabled: boolean;
  /** Lưới AOI ([006] §6, M9) — undefined = tắt AOI (client thấy cả world). */
  private readonly grid?: InterestGrid;
  private gridTick = -1;
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
    if (opts.config.aoi) this.grid = new InterestGrid(opts.config.aoi);
  }

  /** Ring baseline mới cho một client (undefined khi delta tắt). */
  private newSentRing(): TickRing<readonly SnapshotEntity[]> | undefined {
    if (!this.deltaEnabled || this.baselineTicks <= 0) return undefined;
    return new TickRing<readonly SnapshotEntity[]>(this.baselineTicks);
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
      connected: true,
      ackTick: -1, // chưa nhận snapshot nào → snapshot đầu tiên là keyframe
      firstSentTick: -1,
      sentRing: this.newSentRing(),
      visible: new Set<number>(),
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

  /**
   * Client rớt mạng, bắt đầu grace period ([006] §5, M8). Record + entity **giữ
   * nguyên** (world vẫn mô phỏng nó — game quyết qua `onPlayerDisconnected`); chỉ
   * đánh dấu mất kết nối để tick loop không cố gửi state.
   */
  disconnectClient(sessionId: string): void {
    const c = this.clients.get(sessionId);
    if (!c || !c.connected) return;
    c.connected = false;
    this.game.onPlayerDisconnected?.(this.world, c.entityId);
  }

  /**
   * Client quay lại trong grace ([006] §5). Dữ liệu coi như join lại:
   * - baseline delta **xóa sạch** (`ackTick`/`firstSentTick` reset) → state kế
   *   tiếp chắc chắn là **keyframe**; snapshot cũ trong ring client đã vô nghĩa.
   * - jitter buffer input làm mới: client reset chuỗi seq, buffer cũ còn seq/tick
   *   của phiên trước sẽ dedupe nhầm input mới.
   *
   * Entity giữ nguyên (cùng `entityId`). `undefined` nếu session không còn.
   */
  reconnectClient(sessionId: string): Handshake | undefined {
    const c = this.clients.get(sessionId);
    if (!c) return undefined;
    c.connected = true;
    c.ackTick = -1;
    c.firstSentTick = -1;
    c.sentRing = this.newSentRing(); // baseline phiên cũ vô nghĩa (client đã vứt ring)
    c.visible.clear(); // AOI dựng lại từ đầu — keyframe sẽ mang đủ entity quanh nó
    c.buffer = new InputBuffer<Input>({
      maxTickSkew: this.maxTickSkew,
      budgetPerTick: this.budgetPerTick,
    });
    this.game.onPlayerReconnected?.(this.world, c.entityId);
    return {
      protocolVersion: this.protocolVersion,
      tickRate: this.config.tickRate,
      worldBounds: this.config.worldBounds,
      entityId: c.entityId,
    };
  }

  /** Client đang kết nối (false = đang trong grace period sau khi rớt). */
  isConnected(sessionId: string): boolean {
    return this.clients.get(sessionId)?.connected ?? false;
  }

  /** Grace period (giây) cấu hình cho room này; 0 = tắt reconnect. */
  get reconnectGraceSeconds(): number {
    return this.config.reconnectGraceSeconds ?? 30;
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

    // AOI (M9): mỗi client thấy một tập entity KHÁC NHAU → baseline delta phải là
    // "cái ta đã gửi cho CHÍNH client này", nên ring baseline nằm trong record của
    // client, không dùng chung theo room được.
    const entities = this.visibleFor(c);
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
    c.sentRing?.set(this._tick, entities);
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
    if (!c.sentRing || c.ackTick < 0) return undefined;
    if (c.firstSentTick < 0 || c.ackTick < c.firstSentTick) return undefined;
    if (this._tick - c.ackTick >= this.baselineTicks) return undefined; // baseline quá già
    const entities = c.sentRing.get(c.ackTick);
    return entities ? { serverTick: c.ackTick, entities } : undefined;
  }

  /**
   * Entity mà client này nhìn thấy ở tick hiện tại ([006] §6, M9).
   *
   * Không bật AOI → thấy tất cả. Bật AOI → 3×3 ô quanh entity của chính nó, lọc
   * theo bán kính + hysteresis; **entity của chính client luôn có mặt** (không thì
   * nó mất chính mình khi đứng một mình giữa map). Không tìm thấy entity của client
   * (đã despawn / spectator) → thấy tất cả, để game tự quyết bằng `readEntities`.
   */
  private visibleFor(c: ClientRecord<Input>): readonly SnapshotEntity[] {
    const all = this.currentEntities();
    if (!this.grid) return all;

    const self = all.find((e) => e.entityId === c.entityId);
    if (!self) return all;

    if (this.gridTick !== this._tick) {
      this.grid.rebuild(all);
      this.gridTick = this._tick;
    }

    const seen = this.grid.visible(self.posX, self.posY, c.visible);
    if (!seen.some((e) => e.entityId === c.entityId)) seen.push(self);

    c.visible.clear();
    for (const e of seen) c.visible.add(e.entityId);
    return seen;
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
