/**
 * Harness loopback cho nghiệm thu M4: nối `GameClient` + `PredictionWorld` +
 * `Reconciler` với một server authoritative tối giản chạy CÙNG box-sim Rapier
 * (chỉ dùng `@gm-net/core` + `@gm-net/shared` — KHÔNG import `@gm-net/server`
 * để giữ ranh giới client↮server, giống harness M3). Đồng hồ ảo + trễ một chiều
 * cố định → kịch bản deterministic.
 *
 * Server mini mirror đúng hành vi `InputBuffer` của M2 ở mức cần cho M4:
 * dedupe theo seq watermark, bỏ + đếm input muộn, repeat-last khi thiếu,
 * lastProcessedSeq = input cuối đã áp.
 */
import {
  MessageType,
  ProtocolCodec,
  seqGreater,
  type QuantizationConfig,
  type SnapshotEntity,
} from '@gm-net/core';
import {
  BOX_ENTITY_TYPE,
  boxInputCodec,
  boxSim,
  createBoxWorld,
  type BoxInput,
  type BoxWorld,
} from '@gm-net/shared/box-sim';
import { SERVER_TICK_MS } from '@gm-net/shared';
import {
  GameClient,
  PredictionMetrics,
  PredictionWorld,
  Reconciler,
  type ClientTransport,
  type ReconcileOutcome,
} from '../src/index.js';

export const bounds = { minX: -50, maxX: 50, minY: -50, maxY: 50 };
export const quantization: QuantizationConfig = { world: bounds, vMax: 20 };

export function makeCodec(): ProtocolCodec<BoxInput> {
  return new ProtocolCodec<BoxInput>({ quantization, inputCodec: boxInputCodec });
}

/** Server authoritative tối giản chạy box-sim, một player entity. */
export class SimServer {
  readonly codec = makeCodec();
  readonly world: BoxWorld;
  readonly entityId = 1;
  tick = 0;

  private highestSeq = -1;
  private lastProcessedSeq = 0;
  private lastPayload: BoxInput | undefined;
  private lateWindow = 0;
  private readonly pending = new Map<number, { seq: number; payload: BoxInput }>();
  /** Hook chạy sau applyInput, trước step — bơm "áp lực ngoài" (kịch bản b). */
  beforeStep: ((world: BoxWorld, tick: number) => void) | undefined;

  constructor(spawn = { posX: 0, posY: 0, rot: 0, velX: 0, velY: 0 }) {
    this.world = createBoxWorld({ bounds });
    boxSim.spawn(this.world, this.entityId, BOX_ENTITY_TYPE, spawn);
  }

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
      this.pending.set(entry.tick, { seq, payload: entry.payload! });
    }
  }

  /** Một tick server: rút input (thiếu → repeat-last) → áp → hook → step. */
  advance(): void {
    const found = this.pending.get(this.tick);
    if (found) {
      this.pending.delete(this.tick);
      this.lastProcessedSeq = found.seq;
      this.lastPayload = found.payload;
    }
    const payload = found ? found.payload : this.lastPayload;
    if (payload) boxSim.applyInput(this.world, this.entityId, payload, this.tick);
    this.beforeStep?.(this.world, this.tick);
    boxSim.step(this.world, SERVER_TICK_MS, this.tick);
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
      entities: boxSim.listEntities(this.world),
    });
  }

  pongBytes(pingBytes: Uint8Array): Uint8Array {
    const ping = this.codec.decodePing(pingBytes);
    return this.codec.encodePong({
      clientTime: ping.clientTime,
      serverTime: this.tick * SERVER_TICK_MS,
      serverTick: this.tick,
    });
  }

  localEntity(): SnapshotEntity {
    return boxSim.listEntities(this.world).find((e) => e.entityId === this.entityId)!;
  }
}

interface Delayed {
  at: number;
  type: number;
  bytes: Uint8Array;
}

/** Loopback trễ một chiều cố định, giao message khi đồng hồ ảo đi qua mốc đến. */
export class SimLoopback {
  now = 0;
  readonly server: SimServer;
  readonly transport: ClientTransport;

  private toServer: Delayed[] = [];
  private toClient: Delayed[] = [];
  private bytesCb: ((type: number, bytes: Uint8Array) => void) | undefined;
  private readonly jsonCbs = new Map<string, (payload: unknown) => void>();

  constructor(private readonly oneWayMs: number, server = new SimServer()) {
    this.server = server;
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

  join(): void {
    this.jsonCbs.get('handshake')?.({
      protocolVersion: 1,
      tickRate: 30,
      worldBounds: bounds,
      entityId: this.server.entityId,
    });
  }

  /** Đẩy đồng hồ `ms`, giao mọi message tới hạn (cả hai chiều). */
  advance(ms: number): void {
    this.now += ms;
    const dueServer = this.toServer.filter((m) => m.at <= this.now);
    this.toServer = this.toServer.filter((m) => m.at > this.now);
    for (const m of dueServer) {
      if (m.type === MessageType.Input) this.server.ingest(m.bytes);
      else if (m.type === MessageType.Ping)
        this.sendToClient(MessageType.Pong, this.server.pongBytes(m.bytes));
    }
    const dueClient = this.toClient.filter((m) => m.at <= this.now);
    this.toClient = this.toClient.filter((m) => m.at > this.now);
    for (const m of dueClient) this.bytesCb?.(m.type, m.bytes);
  }

  /** Một tick server: mô phỏng rồi phát snapshot. */
  serverTick(): void {
    this.server.advance();
    this.sendToClient(MessageType.Snapshot, this.server.snapshotBytes());
  }

  private sendToClient(type: number, bytes: Uint8Array): void {
    this.toClient.push({ at: this.now + this.oneWayMs, type, bytes });
  }
}

/** Cụm client đầy đủ M4 (GameClient + PredictionWorld + Reconciler + metrics). */
export interface PredictingClient {
  client: GameClient<BoxInput>;
  prediction: PredictionWorld<BoxWorld, BoxInput>;
  reconciler: Reconciler<BoxWorld, BoxInput>;
  metrics: PredictionMetrics;
  outcomes: ReconcileOutcome[];
}

export function makePredictingClient(
  lb: SimLoopback,
  reconcilerOverrides: { epsilonPosSteps?: number } = {},
): PredictingClient {
  const metrics = new PredictionMetrics();
  const client = new GameClient<BoxInput>(lb.transport, {
    codec: makeCodec(),
    now: () => lb.now,
  });
  const prediction = new PredictionWorld<BoxWorld, BoxInput>({
    sim: boxSim,
    world: createBoxWorld({ bounds }),
    localEntityId: lb.server.entityId,
  });
  const reconciler = new Reconciler(prediction, {
    quantization,
    metrics,
    now: () => lb.now,
    ...reconcilerOverrides,
  });
  const outcomes: ReconcileOutcome[] = [];
  client.onSnapshot((snap) => {
    outcomes.push(reconciler.reconcile(snap));
  });
  lb.join();
  client.start();
  return { client, prediction, reconciler, metrics, outcomes };
}

/**
 * Chạy `n` vòng tick 30Hz: client update (ping) + sample input + predict →
 * giao message → server tick → giao snapshot về client (reconcile trong
 * onSnapshot). `payloadFn` trả input cho từng vòng.
 */
export function runTicks(
  lb: SimLoopback,
  pc: PredictingClient,
  n: number,
  payloadFn: (i: number) => BoxInput,
): void {
  for (let i = 0; i < n; i++) {
    pc.client.update(lb.now);
    const payload = payloadFn(i);
    // Timeline dự đoán liên tục: prediction chọn tick, clock chỉ để neo/nhảy.
    const target = pc.prediction.nextInputTick(pc.client.targetTick(lb.now));
    const { tick } = pc.client.sendInput(payload, lb.now, target);
    pc.prediction.advance(payload, tick);
    lb.advance(0); // giao message tới hạn tại thời điểm hiện tại
    lb.serverTick();
    lb.advance(SERVER_TICK_MS); // hết tick: giao nốt message trên đường
  }
}
