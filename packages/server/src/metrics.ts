/**
 * Metrics server ([004] §8, M11): **tick duration (p50/p99)** + **bandwidth per
 * client** — hai con số quyết định "room có gánh nổi N người chơi không".
 *
 * Tick p99 là chỉ số sống còn: tick 30Hz có ngân sách 33.3ms; p99 vượt ngưỡng
 * nghĩa là cứ 100 tick lại có 1 tick trễ nhịp → giật với mọi người trong room.
 * Đo p99 (không phải trung bình): trung bình giấu đúng cái đuôi ta cần thấy.
 */

/** Ring các mẫu thời gian (ms) — đủ cho percentile trên cửa sổ gần đây. */
export class TickMetrics {
  private readonly samples: number[];
  private count = 0;
  private idx = 0;

  constructor(readonly window = 300) {
    this.samples = new Array<number>(window).fill(0);
  }

  record(ms: number): void {
    this.samples[this.idx] = ms;
    this.idx = (this.idx + 1) % this.window;
    this.count = Math.min(this.count + 1, this.window);
  }

  /** Số mẫu đang giữ. */
  get size(): number {
    return this.count;
  }

  /** Percentile theo nearest-rank (p ∈ [0,1]); NaN khi chưa có mẫu. */
  percentile(p: number): number {
    if (this.count === 0) return Number.NaN;
    const sorted = this.samples.slice(0, this.count).sort((a, b) => a - b);
    const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[rank];
  }

  get p50(): number {
    return this.percentile(0.5);
  }

  get p99(): number {
    return this.percentile(0.99);
  }

  get max(): number {
    return this.count === 0 ? Number.NaN : Math.max(...this.samples.slice(0, this.count));
  }

  reset(): void {
    this.count = 0;
    this.idx = 0;
  }
}

/** Một lát cắt metrics của room ([004] §8). */
export interface RoomMetrics {
  tick: number;
  clients: number;
  /** Thời lượng một tick server (mô phỏng + encode + gửi), ms. */
  tickMs: { p50: number; p99: number; max: number };
  /** Byte state đã gửi kể từ khi room mở. */
  bytesSent: number;
  /** Băng thông state trung bình mỗi client (B/s) trong cửa sổ đo. */
  bytesPerClientPerSecond: number;
  keyframes: number;
  deltas: number;
}
