/**
 * Prediction phía client ([docs/design/004-netcode.md] §5, IMPLEMENTATION 4.3):
 * world local chạy CÙNG simulation code với server (interface `Simulation` trong
 * `@gm-net/shared`), mô phỏng trước (ahead) theo timeline tick của server.
 *
 * Mỗi tick sim: áp input (bản canonical — đúng bản server sẽ decode) → step →
 * `takeSnapshot` vào ring ~1s. Hai ring song song cùng khóa tick:
 * - `stateRing[t]`  = snapshot world + transform local **tại tick t** (sau khi
 *   mô phỏng xong tick t-1) — cùng semantics `serverTick` trong snapshot server.
 * - `inputRing[t]`  = payload đã áp **tại tick t** (kể cả fill repeat-last) —
 *   chính là "map seq→tick" mà replay cần: restore về T rồi áp lại đúng chuỗi
 *   input gốc từ T là tái lập được hiện tại (idempotent khi không có gì mới).
 *
 * Lớp này là **cơ chế** (world + ring + restore/replay); **chính sách** so lệch
 * epsilon + quyết định correction nằm ở {@link Reconciler} (`reconcile.ts`).
 */
import { TickRing, type SnapshotEntity } from '@gm-net/core';
import { SERVER_TICK_MS, type EntityTransform, type Simulation } from '@gm-net/shared';

/** Bản ghi dự đoán tại một tick (state ring). */
export interface PredictedState<Snap = unknown> {
  /** Snapshot toàn world (restore + replay khi correction). */
  snap: Snap;
  /** Transform local entity đã dự đoán — so với snapshot server cùng tick. */
  local: EntityTransform | undefined;
}

export interface PredictionWorldOptions<World, Input, Snap> {
  sim: Simulation<World, Input, Snap>;
  /** World local (game tạo, thường rỗng — entity mirror theo snapshot đầu tiên). */
  world: World;
  /** Entity local player (từ handshake). */
  localEntityId: number;
  /** Độ dài tick (ms). Mặc định `SERVER_TICK_MS`. */
  stepMs?: number;
  /** Số slot ring (~1s @30Hz). Mặc định 30. */
  ringTicks?: number;
}

export class PredictionWorld<World = unknown, Input = unknown, Snap = unknown> {
  readonly localEntityId: number;
  readonly world: World;

  private readonly sim: Simulation<World, Input, Snap>;
  private readonly stepMs: number;
  private readonly stateRing: TickRing<PredictedState<Snap>>;
  private readonly inputRing: TickRing<Input>;

  /** Tick của state hiện tại; -1 = chưa neo (chờ snapshot đầu tiên). */
  private _stateTick = -1;
  /** Payload gần nhất đã lấy mẫu — fill gap tick (mirror repeat-last server). */
  private lastPayload: Input | undefined;

  constructor(opts: PredictionWorldOptions<World, Input, Snap>) {
    this.sim = opts.sim;
    this.world = opts.world;
    this.localEntityId = opts.localEntityId;
    this.stepMs = opts.stepMs ?? SERVER_TICK_MS;
    const ringTicks = opts.ringTicks ?? 30;
    this.stateRing = new TickRing(ringTicks);
    this.inputRing = new TickRing(ringTicks);
  }

  /** Đã neo timeline theo snapshot server chưa. */
  get anchored(): boolean {
    return this._stateTick >= 0;
  }

  /** Tick của state world hiện tại (-1 khi chưa neo). */
  get stateTick(): number {
    return this._stateTick;
  }

  /** Transform local entity hiện tại (simulation transform — chưa smoothing). */
  localState(): EntityTransform | undefined {
    return this.sim.getEntity(this.world, this.localEntityId);
  }

  /** Bản ghi dự đoán tại `tick`; `undefined` nếu ngoài ring. */
  stateAt(tick: number): PredictedState<Snap> | undefined {
    return this.stateRing.get(tick);
  }

  /**
   * Neo (hoặc neo lại) timeline theo snapshot server: ghi đè mọi entity theo
   * authoritative, đặt `stateTick = tick`, reset ring. Dùng cho snapshot đầu
   * tiên và khi server vượt lên trước client (chưa dự đoán tới tick đó — warmup,
   * tab pause…): không có gì để so, chỉ việc nhận sự thật.
   */
  rebase(tick: number, entities: readonly SnapshotEntity[]): void {
    for (const e of entities) {
      if (this.sim.getEntity(this.world, e.entityId) === undefined) {
        this.sim.spawn(this.world, e.entityId, e.entityType, e);
      } else {
        this.sim.setEntity(this.world, e.entityId, e);
      }
    }
    this._stateTick = tick;
    this.stateRing.clear();
    this.inputRing.clear();
    this.record(tick);
  }

  /** Spawn các entity chưa có trong world local (entity mới xuất hiện ở server). */
  syncEntities(entities: readonly SnapshotEntity[]): void {
    for (const e of entities) {
      if (this.sim.getEntity(this.world, e.entityId) === undefined) {
        this.sim.spawn(this.world, e.entityId, e.entityType, e);
      }
    }
  }

  /**
   * Tick nên nhắm cho input kế tiếp. Timeline dự đoán phải **liên tục** (+1 mỗi
   * tick sim) — ước lượng clock có jitter dưới-tick nên `ceil` bounce, nếu nhắm
   * thẳng theo clock thì tick lặp/nhảy mỗi vài input và server áp input lệch
   * tick với local → misprediction hệ thống. Vì vậy: bám `stateTick`; chỉ nhảy
   * theo clock khi lệch thật (≥ 2 tick — neo lại sau pause, lead tăng dồn).
   * Clock đòi tick NHỎ hơn chỉ có nghĩa input đến sớm hơn cần thiết (thêm ~1
   * tick latency, không sai) — không bao giờ lùi timeline.
   */
  nextInputTick(clockTargetTick: number): number {
    if (!this.anchored) return clockTargetTick;
    return clockTargetTick - this._stateTick >= 2 ? clockTargetTick : this._stateTick;
  }

  /**
   * Một tick prediction: mô phỏng tới `targetTick` (tick mà input này nhắm —
   * `GameClient.sendInput` trả về) rồi áp `payload` tại đó.
   *
   * - Gap (lead tăng / tick nhảy): fill bằng `lastPayload` — mirror hành vi
   *   repeat-last của server, nên gap không gây misprediction.
   * - `targetTick` lùi (lead giảm): áp tại tick kế tiếp của local; server áp
   *   tại tick nó nhắm — lệch 1 tick, reconciliation sửa nếu payload đổi.
   * - Chưa neo → no-op (chưa có state để dự đoán từ đó).
   */
  advance(payload: Input, targetTick: number): void {
    if (!this.anchored) {
      // Chưa neo vẫn phải nhớ payload: server đã nhận input này và sẽ
      // repeat-last nó — fill gap sau khi neo phải dùng đúng nó.
      this.lastPayload = payload;
      return;
    }
    const t = Math.max(targetTick, this._stateTick);
    while (this._stateTick < t) this.stepOnce(this.lastPayload);
    this.stepOnce(payload);
    this.lastPayload = payload;
  }

  /**
   * Correction ([004] §5): restore ring về `tick`, ghi đè entity theo snapshot
   * server (qua `shouldOverwrite` — bỏ qua entity đã khớp để giữ nguyên float
   * precision + sleep state), replay input đã áp từ `tick` tới tick hiện tại.
   * Sau khi xong world ở đúng tick cũ, đã sửa theo sự thật server.
   */
  correct(
    tick: number,
    entities: readonly SnapshotEntity[],
    shouldOverwrite: (current: EntityTransform, authoritative: SnapshotEntity) => boolean = () => true,
  ): void {
    const rec = this.stateRing.get(tick);
    if (!rec) return;
    const target = this._stateTick;

    this.sim.restoreSnapshot(this.world, rec.snap);
    for (const e of entities) {
      const cur = this.sim.getEntity(this.world, e.entityId);
      if (cur === undefined) {
        this.sim.spawn(this.world, e.entityId, e.entityType, e);
      } else if (shouldOverwrite(cur, e)) {
        this.sim.setEntity(this.world, e.entityId, e);
      }
    }
    this._stateTick = tick;
    this.record(tick);
    while (this._stateTick < target) this.stepOnce(this.inputRing.get(this._stateTick));
  }

  /** Áp payload (nếu có) tại `stateTick`, step một tick, ghi ring. */
  private stepOnce(payload: Input | undefined): void {
    const tick = this._stateTick;
    if (payload !== undefined) {
      this.sim.applyInput(this.world, this.localEntityId, payload, tick);
      this.inputRing.set(tick, payload);
    }
    this.sim.step(this.world, this.stepMs, tick);
    this._stateTick = tick + 1;
    this.record(this._stateTick);
  }

  private record(tick: number): void {
    this.stateRing.set(tick, {
      snap: this.sim.takeSnapshot(this.world),
      local: this.localState(),
    });
  }
}
