/**
 * Logic room không phụ thuộc transport ([docs/design/006-server-rooms.md] §2).
 * Giữ world của game + jitter buffer per-client + tick counter; `GameRoom`
 * (Colyseus) chỉ là lớp vỏ bơm message vào/ra engine này. Tách vậy để test
 * "echo simulation, 2 client thấy nhau" deterministic không cần socket.
 */
import {
  PROTOCOL_VERSION,
  ProtocolCodec,
  type PingMessage,
  type QuantizationConfig,
} from '@gm-net/core';
import { InputBuffer } from './input-buffer.js';
import type { GameCodecs, GameConfig, GameLogic, Handshake } from './game.js';

interface ClientRecord<Input> {
  sessionId: string;
  entityId: number;
  buffer: InputBuffer<Input>;
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
  }

  /** Client này đã có record trong engine chưa (room dùng để guard tick loop). */
  hasClient(sessionId: string): boolean {
    return this.clients.has(sessionId);
  }

  /**
   * Snapshot đầy đủ cho một client (ack `lastProcessedSeq` + `lateInputs` riêng).
   * `lateInputs` = số input muộn *kể từ snapshot trước* (consume-on-read).
   */
  encodeSnapshotFor(sessionId: string): Uint8Array {
    const c = this.clients.get(sessionId);
    if (!c) throw new Error(`RoomEngine: client không tồn tại (${sessionId})`);
    return this.codec.encodeSnapshot({
      serverTick: this._tick,
      lastProcessedSeq: c.buffer.lastProcessedSeq,
      lateInputs: Math.min(255, c.buffer.consumeLateInputs()),
      entities: this.game.readEntities(this.world),
    });
  }

  decodePing(bytes: Uint8Array): PingMessage {
    return this.codec.decodePing(bytes);
  }

  encodePong(clientTime: number, serverTime: number): Uint8Array {
    return this.codec.encodePong({ clientTime, serverTime, serverTick: this._tick });
  }
}
