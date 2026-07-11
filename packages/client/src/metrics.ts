/**
 * Metrics prediction phía client ([docs/design/004-netcode.md] §8, IMPLEMENTATION
 * 4.6): misprediction/s + biên độ correction — "chỉ số sức khỏe chính của
 * netcode", cắm counter từ Phase 1 để demo đo được ngay. `Reconciler` gọi
 * `onCorrection` mỗi lần sửa; HUD/dashboard đọc qua `read(now)`.
 */

export interface PredictionMetricsSnapshot {
  /** Tổng correction từ đầu phiên. */
  corrections: number;
  /** Correction/giây trong cửa sổ trượt. */
  correctionsPerSecond: number;
  /** Biên độ (m) của correction gần nhất; NaN nếu chưa có. */
  lastMagnitude: number;
  /** Biên độ lớn nhất từ đầu phiên; NaN nếu chưa có. */
  maxMagnitude: number;
}

export interface PredictionMetricsOptions {
  /** Cửa sổ trượt tính rate (ms). Mặc định 1000. */
  windowMs?: number;
}

export class PredictionMetrics {
  private readonly windowMs: number;
  /** Timestamp các correction trong cửa sổ (prune khi đọc/ghi). */
  private readonly recent: number[] = [];
  private _corrections = 0;
  private _last = Number.NaN;
  private _max = Number.NaN;

  constructor(opts: PredictionMetricsOptions = {}) {
    this.windowMs = opts.windowMs ?? 1000;
  }

  get corrections(): number {
    return this._corrections;
  }

  /** Ghi nhận một correction biên độ `magnitude` (m) tại thời điểm `now` (ms). */
  onCorrection(magnitude: number, now: number): void {
    this._corrections++;
    this._last = magnitude;
    this._max = Number.isNaN(this._max) ? magnitude : Math.max(this._max, magnitude);
    this.recent.push(now);
    this.prune(now);
  }

  /** Đọc số liệu tại thời điểm `now` (ms). */
  read(now: number): PredictionMetricsSnapshot {
    this.prune(now);
    return {
      corrections: this._corrections,
      correctionsPerSecond: this.recent.length * (1000 / this.windowMs),
      lastMagnitude: this._last,
      maxMagnitude: this._max,
    };
  }

  private prune(now: number): void {
    while (this.recent.length && this.recent[0] <= now - this.windowMs) this.recent.shift();
  }
}
