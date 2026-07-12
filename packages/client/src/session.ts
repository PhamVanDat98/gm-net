/**
 * `GameSession` — lớp ghép cao nhất phía client (IMPLEMENTATION 5.2): nối
 * {@link GameClient} (transport/clock/input) + {@link PredictionWorld} +
 * {@link Reconciler} (local player, M4) + {@link InterpolationBuffer} (remote,
 * M5) + {@link TransformSmoother} thành một API mà game/demo gọi thẳng:
 *
 * - `tick(payload)` mỗi tick sim 30Hz (host tự chạy `FixedTimestep`),
 * - `getRenderState(now)` mỗi frame render 60Hz — local (predicted + smoothed)
 *   và remote (interpolated ~100ms).
 *
 * Không import DOM — chạy cả browser (demo) lẫn Node (headless bot, e2e test).
 * Từng mảnh vẫn dùng riêng được như M3/M4; lớp này chỉ là wiring mặc định.
 */
import type { ProtocolCodec, QuantizationConfig, Snapshot } from '@gm-net/core';
import { SERVER_TICK_MS, type Handshake, type Simulation } from '@gm-net/shared';
import { GameClient, type GameClientOptions } from './client.js';
import { InterpolationBuffer, type InterpolatedEntity, type InterpolationOptions } from './interpolation.js';
import { PredictionMetrics } from './metrics.js';
import { PredictionWorld } from './prediction.js';
import { Reconciler, type ReconcileOutcome, type ReconcilerOptions } from './reconcile.js';
import { TransformSmoother, type RenderTransform, type TransformSmootherOptions } from './render-state.js';
import type { ClientTransport } from './transport.js';

export interface GameSessionOptions<World, Input, Snap> {
  codec: ProtocolCodec<Input>;
  /** PHẢI trùng cấu hình codec/server (Reconciler so quantized-vs-quantized). */
  quantization: QuantizationConfig;
  /** Logic mô phỏng dùng chung với server. */
  sim: Simulation<World, Input, Snap>;
  /** World local đã tạo sẵn (game gọi factory riêng, vd sau `initPhysics2D()`). */
  world: World;
  /** Đồng hồ (ms). Mặc định `Date.now`. */
  now?: () => number;
  tickMs?: number;
  /** Số slot ring prediction (~1s). Mặc định 30. */
  ringTicks?: number;
  reconciler?: Omit<ReconcilerOptions, 'quantization' | 'metrics' | 'now'>;
  smoothing?: TransformSmootherOptions;
  interpolation?: InterpolationOptions;
  /** Pass-through cho GameClient (clock/input/lead/onHandshake/onSnapshot). */
  client?: Omit<GameClientOptions<Input>, 'codec' | 'now' | 'tickMs'>;
  /** Nghe kết quả reconcile từng snapshot (debug/HUD/test). */
  onReconcile?: (outcome: ReconcileOutcome, snap: Snapshot) => void;
}

/** State một frame render: local đã smooth + remote đã interpolate. */
export interface RenderState {
  /** Local player (prediction + smoothing); `undefined` khi chưa spawn/neo. */
  local: RenderTransform | undefined;
  /** Remote entities (trễ ~delay ms, lerp giữa snapshot). */
  remote: Map<number, InterpolatedEntity>;
}

/** Số liệu gộp cho HUD ([004] §8). */
export interface SessionHud {
  rtt: number;
  jitter: number;
  inputLead: number;
  pendingInputs: number;
  lastSnapshotTick: number;
  /** Tick timeline dự đoán local (-1 khi chưa neo). */
  predictedTick: number;
  corrections: number;
  correctionsPerSecond: number;
  lastCorrectionMagnitude: number;
  interpDelayMs: number;
  interpStarvedRatio: number;
}

export class GameSession<World = unknown, Input = unknown, Snap = unknown> {
  readonly client: GameClient<Input>;
  readonly interpolation: InterpolationBuffer;
  readonly metrics: PredictionMetrics;

  private readonly sim: Simulation<World, Input, Snap>;
  private readonly world: World;
  private readonly now: () => number;
  private readonly ringTicks?: number;
  private readonly reconcilerOpts: GameSessionOptions<World, Input, Snap>['reconciler'];
  private readonly quantization: QuantizationConfig;
  private readonly smoother: TransformSmoother;
  private readonly onReconcile?: (outcome: ReconcileOutcome, snap: Snapshot) => void;

  private _prediction: PredictionWorld<World, Input, Snap> | undefined;
  private reconciler: Reconciler<World, Input, Snap> | undefined;
  private lastRenderAt = Number.NaN;

  constructor(transport: ClientTransport, opts: GameSessionOptions<World, Input, Snap>) {
    this.sim = opts.sim;
    this.world = opts.world;
    this.now = opts.now ?? (() => Date.now());
    this.ringTicks = opts.ringTicks;
    this.reconcilerOpts = opts.reconciler;
    this.quantization = opts.quantization;
    this.smoother = new TransformSmoother(opts.smoothing);
    this.interpolation = new InterpolationBuffer({
      tickMs: opts.tickMs ?? SERVER_TICK_MS,
      ...opts.interpolation,
    });
    this.metrics = new PredictionMetrics();
    this.onReconcile = opts.onReconcile;

    const clientOpts = opts.client ?? {};
    this.client = new GameClient<Input>(transport, {
      ...clientOpts,
      codec: opts.codec,
      now: this.now,
      tickMs: opts.tickMs,
      onHandshake: (h) => {
        this.setupPrediction(h);
        clientOpts.onHandshake?.(h);
      },
      onSnapshot: (snap) => {
        this.handleSnapshot(snap);
        clientOpts.onSnapshot?.(snap);
      },
    });
  }

  /** Prediction world (undefined tới khi nhận handshake). */
  get prediction(): PredictionWorld<World, Input, Snap> | undefined {
    return this._prediction;
  }

  get entityId(): number {
    return this.client.entityId;
  }

  start(): void {
    this.client.start();
  }

  leave(): void {
    this.client.leave();
  }

  /**
   * Một tick sim 30Hz: ping tới hạn → gửi input (timeline dự đoán liên tục
   * chọn tick, clock chỉ để neo/nhảy — [004] §5 ghi chú M4) → predict local.
   */
  tick(payload: Input, now = this.now()): void {
    this.client.update(now);
    const clockTarget = this.client.targetTick(now);
    const target = this._prediction ? this._prediction.nextInputTick(clockTarget) : clockTarget;
    const { tick } = this.client.sendInput(payload, now, target);
    this._prediction?.advance(payload, tick);
  }

  /**
   * State để vẽ một frame ([004] §5–6): local = simulation transform của
   * prediction đi qua smoothing (correction trải ra vài frame); remote = nội
   * suy giữa snapshot, trễ ~delay. Gọi mỗi frame render (dt suy từ `now`).
   */
  getRenderState(now = this.now()): RenderState {
    const dtMs = Number.isNaN(this.lastRenderAt) ? 0 : Math.max(0, now - this.lastRenderAt);
    this.lastRenderAt = now;

    const simLocal = this._prediction?.localState();
    const local = simLocal ? this.smoother.update(simLocal, dtMs) : undefined;
    return { local, remote: this.interpolation.sample(now) };
  }

  hud(now = this.now()): SessionHud {
    const m = this.client.metrics(now);
    const p = this.metrics.read(now);
    const i = this.interpolation.stats();
    return {
      rtt: m.rtt,
      jitter: m.jitter,
      inputLead: m.inputLead,
      pendingInputs: m.pendingInputs,
      lastSnapshotTick: m.lastSnapshotTick,
      predictedTick: this._prediction?.stateTick ?? -1,
      corrections: p.corrections,
      correctionsPerSecond: p.correctionsPerSecond,
      lastCorrectionMagnitude: p.lastMagnitude,
      interpDelayMs: i.delayMs,
      interpStarvedRatio: i.starvedRatio,
    };
  }

  private setupPrediction(h: Handshake): void {
    if (this._prediction) {
      // Re-handshake = reconnect ([006] §5, M8). Giữ world + prediction (entity vẫn
      // sống ở server), nhưng vứt mọi thứ neo theo timeline cũ: interpolation còn
      // sample của tick trước lúc rớt (server đã chạy tiếp → lerp qua khoảng trống
      // hàng trăm tick), smoother còn transform cũ (sẽ trượt dài khi keyframe về).
      // Prediction tự rebase khi keyframe tới (serverTick ≫ stateTick → rebase).
      this.interpolation.reset();
      this.smoother.reset();
      return;
    }
    this._prediction = new PredictionWorld<World, Input, Snap>({
      sim: this.sim,
      world: this.world,
      localEntityId: h.entityId,
      ringTicks: this.ringTicks,
    });
    this.reconciler = new Reconciler(this._prediction, {
      quantization: this.quantization,
      metrics: this.metrics,
      now: this.now,
      ...this.reconcilerOpts,
    });
  }

  private handleSnapshot(snap: Snapshot): void {
    // Local đi đường prediction; remote đi đường interpolation.
    this.interpolation.push(snap, this.now(), this.client.entityId);
    if (this.reconciler) {
      const outcome = this.reconciler.reconcile(snap);
      this.onReconcile?.(outcome, snap);
    }
  }
}
