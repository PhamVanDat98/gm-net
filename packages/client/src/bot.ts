/**
 * Headless bot ([006] §7, M11): client **không render** — input do script bơm.
 *
 * Không có "chế độ headless" nào riêng trong netcode: `@gm-net/client` vốn không
 * import DOM (ràng buộc từ M3), nên bot chỉ là "chạy `GameSession.tick()` theo
 * nhịp cố định, không gọi `getRenderState`". Lớp này chỉ đóng gói vòng lặp đó để
 * bot fill room và load test (N bot/room) không phải chép lại timestep loop.
 *
 * Dùng cho: fill room khi thiếu người, load test (đo tick p99 + bandwidth server),
 * và test e2e (2 bot chơi qua proxy).
 */
import { FixedTimestep } from '@gm-net/core';
import { SERVER_TICK_MS } from '@gm-net/shared';
import type { GameSession } from './session.js';

export interface BotContext {
  /** Số tick sim bot đã chạy. */
  tick: number;
  /** Thời gian từ lúc `start()` (ms). */
  elapsedMs: number;
}

export interface BotOptions<Input> {
  /** Script sinh input mỗi tick — trái tim của bot. */
  input: (ctx: BotContext) => Input;
  /** Nhịp sim (ms). Mặc định `SERVER_TICK_MS` (khớp server). */
  tickMs?: number;
  /**
   * Nhịp gọi vòng lặp (ms). Mặc định 8 — nhỏ hơn tick để accumulator luôn có mẫu
   * (timer Windows ~15ms không đều; FixedTimestep tự bù).
   */
  loopMs?: number;
  /** Đồng hồ (ms). Mặc định `Date.now`. */
  now?: () => number;
}

/**
 * Bot điều khiển một {@link GameSession} bằng vòng lặp fixed-timestep riêng.
 * `start()` → chạy tới khi `stop()`. Không giữ tham chiếu DOM/render nào.
 */
export class HeadlessBot<World = unknown, Input = unknown, Snap = unknown> {
  private readonly timestep: FixedTimestep;
  private readonly loopMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private startedAt = 0;
  private lastAt = 0;
  private _ticks = 0;

  constructor(
    readonly session: GameSession<World, Input, Snap>,
    private readonly opts: BotOptions<Input>,
  ) {
    this.timestep = new FixedTimestep({ stepMs: opts.tickMs ?? SERVER_TICK_MS });
    this.loopMs = opts.loopMs ?? 8;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Số tick sim đã chạy. */
  get ticks(): number {
    return this._ticks;
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  start(): void {
    if (this.timer) return;
    this.session.start();
    this.startedAt = this.now();
    this.lastAt = this.startedAt;
    this.timer = setInterval(() => this.pump(), this.loopMs);
  }

  /** Chạy tay một nhịp (test dùng đồng hồ ảo — không cần timer thật). */
  pump(): void {
    const now = this.now();
    const dt = now - this.lastAt;
    this.lastAt = now;
    const elapsedMs = now - this.startedAt;
    this.timestep.advance(dt, () => {
      this.session.tick(this.opts.input({ tick: this._ticks, elapsedMs }));
      this._ticks++;
    });
  }

  /** Dừng vòng lặp; `leave = true` thì rời room luôn. */
  stop(leave = true): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (leave) this.session.leave();
  }
}
