/**
 * Reconciliation ([docs/design/004-netcode.md] §5, IMPLEMENTATION 4.4): nhận
 * snapshot authoritative, so state local player ĐÃ dự đoán tại tick đó với state
 * server gửi về; lệch quá epsilon → correction (restore + ghi đè + replay, cơ
 * chế nằm ở {@link PredictionWorld}).
 *
 * Quy tắc then chốt ([005] §2): so **giá trị đã quantize** với **giá trị đã
 * quantize** — cả hai phía đều đi qua đúng bộ hàm quantize của core. Nếu so
 * float thô, sai số quantize (nửa bước) bị đọc nhầm thành misprediction và
 * correction loop không bao giờ dứt. Epsilon tính bằng **bước lượng tử** cho
 * từng miền (position/velocity/rotation), mặc định 1 bước — hấp thụ trọn sai số
 * làm tròn hai phía.
 */
import {
  quantizeAngle,
  quantizeScalar,
  quantizeVelocity,
  type QuantizationConfig,
  type Snapshot,
  type SnapshotEntity,
} from '@gm-net/core';
import type { EntityTransform } from '@gm-net/shared';
import type { PredictionWorld } from './prediction.js';
import type { PredictionMetrics } from './metrics.js';

/** Kết quả xử lý một snapshot. */
export type ReconcileOutcome =
  /** Server ở/tương lai so với timeline dự đoán → neo lại (snapshot đầu, warmup, pause). */
  | { type: 'rebase'; tick: number }
  /** Dự đoán khớp trong epsilon — không làm gì. */
  | { type: 'clean'; tick: number }
  /** Misprediction: đã restore + ghi đè + replay. `magnitude` = lệch vị trí (m). */
  | { type: 'correction'; tick: number; magnitude: number }
  /** Tick server đã rơi khỏi ring local (~1s) — không kiểm chứng được, bỏ qua. */
  | { type: 'too-old'; tick: number }
  /** Snapshot không chứa local entity (chưa spawn/đã despawn) — chỉ sync entity. */
  | { type: 'no-local'; tick: number };

export interface ReconcilerOptions {
  /** Cấu hình quantize — PHẢI trùng cấu hình codec/server. */
  quantization: QuantizationConfig;
  /** Ngưỡng lệch position (bước u16). Mặc định 1. */
  epsilonPosSteps?: number;
  /** Ngưỡng lệch velocity (bước i16). Mặc định 1. */
  epsilonVelSteps?: number;
  /** Ngưỡng lệch rotation (bước u16 trên vòng 2π, xét wrap). Mặc định 2 (~0.011°… đủ hấp thụ làm tròn). */
  epsilonRotSteps?: number;
  /** Đếm misprediction/biên độ ([004] §8). */
  metrics?: PredictionMetrics;
  /** Đồng hồ (ms) cho metrics. Mặc định `Date.now`. */
  now?: () => number;
}

/** Lệch lớn nhất theo từng miền, tính bằng bước lượng tử. */
export interface QuantizedDiff {
  posSteps: number;
  velSteps: number;
  rotSteps: number;
}

/** So hai transform sau khi quantize cả hai bằng cùng một config. */
export function quantizedDiff(
  a: EntityTransform,
  b: EntityTransform,
  q: QuantizationConfig,
): QuantizedDiff {
  const { world, vMax } = q;
  const dx = Math.abs(
    quantizeScalar(a.posX, world.minX, world.maxX) - quantizeScalar(b.posX, world.minX, world.maxX),
  );
  const dy = Math.abs(
    quantizeScalar(a.posY, world.minY, world.maxY) - quantizeScalar(b.posY, world.minY, world.maxY),
  );
  const dvx = Math.abs(quantizeVelocity(a.velX, vMax) - quantizeVelocity(b.velX, vMax));
  const dvy = Math.abs(quantizeVelocity(a.velY, vMax) - quantizeVelocity(b.velY, vMax));
  let drot = Math.abs(quantizeAngle(a.rot) - quantizeAngle(b.rot));
  drot = Math.min(drot, 65536 - drot); // wrap-around vòng tròn
  return { posSteps: Math.max(dx, dy), velSteps: Math.max(dvx, dvy), rotSteps: drot };
}

export class Reconciler<World = unknown, Input = unknown, Snap = unknown> {
  private readonly q: QuantizationConfig;
  private readonly epsPos: number;
  private readonly epsVel: number;
  private readonly epsRot: number;
  private readonly metrics?: PredictionMetrics;
  private readonly now: () => number;

  constructor(
    private readonly prediction: PredictionWorld<World, Input, Snap>,
    opts: ReconcilerOptions,
  ) {
    this.q = opts.quantization;
    this.epsPos = opts.epsilonPosSteps ?? 1;
    this.epsVel = opts.epsilonVelSteps ?? 1;
    this.epsRot = opts.epsilonRotSteps ?? 2;
    this.metrics = opts.metrics;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Xử lý một snapshot authoritative (gắn vào `GameClient.onSnapshot`).
   * Idempotent theo nghĩa [004] §5: không có sự kiện server mới → correction
   * (kể cả bị ép) tái lập đúng state cũ, vì replay dùng lại đúng chuỗi input gốc.
   */
  reconcile(snap: Snapshot): ReconcileOutcome {
    const tick = snap.serverTick;

    // Server ngang/vượt timeline dự đoán → không có prediction để so: neo lại.
    if (!this.prediction.anchored || tick >= this.prediction.stateTick) {
      this.prediction.rebase(tick, snap.entities);
      return { type: 'rebase', tick };
    }

    // Entity mới xuất hiện: mirror vào world local (kể cả khi không correction).
    this.prediction.syncEntities(snap.entities);

    const rec = this.prediction.stateAt(tick);
    if (!rec) return { type: 'too-old', tick };

    const auth = snap.entities.find((e) => e.entityId === this.prediction.localEntityId);
    if (!auth) return { type: 'no-local', tick };

    if (rec.local && !this.exceeds(quantizedDiff(rec.local, auth, this.q))) {
      return { type: 'clean', tick };
    }

    // MISPREDICTION → restore + ghi đè (chỉ entity thật sự lệch) + replay.
    const magnitude = rec.local
      ? Math.hypot(rec.local.posX - auth.posX, rec.local.posY - auth.posY)
      : Number.POSITIVE_INFINITY;
    this.prediction.correct(tick, snap.entities, (cur, e) => this.differs(cur, e));
    this.metrics?.onCorrection(magnitude, this.now());
    return { type: 'correction', tick, magnitude };
  }

  /** Lệch vượt ngưỡng chấp nhận (quyết định correction). */
  private exceeds(d: QuantizedDiff): boolean {
    return d.posSteps > this.epsPos || d.velSteps > this.epsVel || d.rotSteps > this.epsRot;
  }

  /**
   * Khác dù chỉ 1 bước lượng tử (quyết định ghi đè từng entity khi correction):
   * entity đã khớp giữ nguyên float gốc + sleep state — restore+replay thuần
   * mới bit-perfect (nền của tính idempotent).
   */
  private differs(cur: EntityTransform, auth: SnapshotEntity): boolean {
    const d = quantizedDiff(cur, auth, this.q);
    return d.posSteps > 0 || d.velSteps > 0 || d.rotSteps > 0;
  }
}
