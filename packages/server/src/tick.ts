/**
 * Tick loop drift-corrected phía server ([docs/design/006-server-rooms.md] §2,
 * task 2.2). `setTimeout` tự căn theo timeline lý tưởng thay vì `setInterval`
 * (setInterval trôi dồn khi event loop nghẽn). Timer được inject để unit-test
 * bằng đồng hồ ảo.
 *
 * Đã cân nhắc `Room.setSimulationInterval` của Colyseus: nó chạy trên
 * `ClockTimer` kiểu setInterval (bù delta chứ không căn thời điểm fire), nên tự
 * quản timer ở đây cho cadence ổn định + kiểm thử được.
 */
export interface TickSchedulerOptions {
  /** Độ dài một tick (ms). */
  stepMs: number;
  onTick: (tick: number) => void;
  now?: () => number;
  setTimer?: (cb: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Trễ quá ngần này bước thì bỏ nợ, căn lại mốc (chống dồn cục). */
  maxCatchupSteps?: number;
}

/**
 * Tính delay tới lần tick kế theo timeline lý tưởng. Nếu tụt quá
 * `maxCatchupSteps` bước thì bỏ backlog và trả `resyncTo` để đặt lại mốc.
 */
export function nextTickDelay(
  expectedNext: number,
  now: number,
  stepMs: number,
  maxCatchupSteps: number,
): { delayMs: number; resyncTo?: number } {
  const behind = now - expectedNext;
  if (behind > maxCatchupSteps * stepMs) {
    return { delayMs: stepMs, resyncTo: now + stepMs };
  }
  return { delayMs: Math.max(0, expectedNext - now) };
}

export class TickScheduler {
  private tick = 0;
  private expectedNext = 0;
  private handle: unknown = undefined;
  private running = false;

  private readonly now: () => number;
  private readonly setTimer: (cb: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly maxCatchupSteps: number;

  constructor(private readonly opts: TickSchedulerOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((cb, d) => setTimeout(cb, d));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.maxCatchupSteps = opts.maxCatchupSteps ?? 5;
  }

  get currentTick(): number {
    return this.tick;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.expectedNext = this.now() + this.opts.stepMs;
    this.schedule(this.opts.stepMs);
  }

  stop(): void {
    this.running = false;
    if (this.handle !== undefined) this.clearTimer(this.handle);
    this.handle = undefined;
  }

  private schedule(delayMs: number): void {
    this.handle = this.setTimer(() => this.fire(), delayMs);
  }

  private fire(): void {
    if (!this.running) return;
    this.opts.onTick(this.tick);
    this.tick += 1;
    this.expectedNext += this.opts.stepMs;
    const { delayMs, resyncTo } = nextTickDelay(
      this.expectedNext,
      this.now(),
      this.opts.stepMs,
      this.maxCatchupSteps,
    );
    if (resyncTo !== undefined) this.expectedNext = resyncTo;
    this.schedule(delayMs);
  }
}
