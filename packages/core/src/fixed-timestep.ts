export interface FixedTimestepOptions {
  /** Độ dài một bước mô phỏng, tính bằng ms (vd: 1000 / 30 cho 30Hz). */
  stepMs: number;
  /**
   * Số bước tối đa mỗi lần advance — chặn "spiral of death" khi tab bị
   * throttle hoặc tick server bị nghẽn. Backlog vượt quá sẽ bị bỏ.
   */
  maxStepsPerAdvance?: number;
}

/**
 * Accumulator cho fixed timestep loop (Gaffer-style). Không tự quản lý
 * timer — caller gọi `advance(elapsedMs)` từ rAF (client) hoặc
 * setInterval/setTimeout (server), simulation chạy đúng nhịp `stepMs`.
 */
export class FixedTimestep {
  readonly stepMs: number;
  private readonly maxSteps: number;
  private accumulatorMs = 0;
  private currentTick = 0;

  constructor(options: FixedTimestepOptions) {
    if (!(options.stepMs > 0)) {
      throw new RangeError(`stepMs must be > 0, got ${options.stepMs}`);
    }
    this.stepMs = options.stepMs;
    this.maxSteps = options.maxStepsPerAdvance ?? 5;
  }

  /** Tick tiếp theo sẽ được mô phỏng. */
  get tick(): number {
    return this.currentTick;
  }

  /** Phần bước đã tích lũy [0, 1) — dùng làm alpha nội suy khi render. */
  get alpha(): number {
    return this.accumulatorMs / this.stepMs;
  }

  /**
   * Cộng dồn thời gian thực đã trôi qua và chạy `step(tick)` cho từng bước
   * mô phỏng đến hạn. Trả về số bước đã chạy.
   */
  advance(elapsedMs: number, step: (tick: number) => void): number {
    this.accumulatorMs += elapsedMs;
    let steps = 0;
    while (this.accumulatorMs >= this.stepMs && steps < this.maxSteps) {
      step(this.currentTick);
      this.currentTick += 1;
      this.accumulatorMs -= this.stepMs;
      steps += 1;
    }
    if (this.accumulatorMs >= this.stepMs) {
      // Bị clamp bởi maxSteps: bỏ backlog, giữ phần dư để alpha vẫn hợp lệ.
      this.accumulatorMs %= this.stepMs;
    }
    return steps;
  }
}
