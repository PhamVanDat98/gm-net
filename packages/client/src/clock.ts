/**
 * Clock sync + RTT estimation ([docs/design/004-netcode.md] §2). Client gửi
 * PING{clientTime}, server đáp PONG{clientTime echo, serverTime, serverTick};
 * từ đó ước lượng:
 * - **RTT** = min trong cửa sổ trượt (min ít nhiễu hơn mean vì loại jitter đuôi),
 * - **jitter** = EWMA độ lệch RTT giữa hai mẫu liên tiếp (nuôi adaptive buffer),
 * - **serverTickNow** = tick server ước lượng tại thời điểm bất kỳ.
 *
 * Thuần logic, không đọc đồng hồ hệ thống: mọi mốc thời gian truyền vào để test
 * bằng đồng hồ ảo (đơn vị ms — cùng thang với `PingMessage.clientTime`).
 */
import { u32TimeDelta, type PongMessage } from '@gm-net/core';
import { SERVER_TICK_MS } from '@gm-net/shared';

export interface ClockSyncOptions {
  /** Độ dài một tick (ms). Mặc định `SERVER_TICK_MS`. */
  tickMs?: number;
  /** Số mẫu RTT giữ trong cửa sổ trượt lấy min. Mặc định 10. */
  rttWindow?: number;
  /** Hệ số EWMA cho jitter. Mặc định 0.1. */
  jitterAlpha?: number;
  /** Nhịp ping thường (ms). Mặc định 500. */
  pingIntervalMs?: number;
  /** Cửa sổ warmup sau connect ping dày hơn (ms). Mặc định 2000. */
  warmupMs?: number;
  /** Nhịp ping trong warmup (ms). Mặc định 250. */
  warmupPingIntervalMs?: number;
}

export class ClockSync {
  private readonly tickMs: number;
  private readonly rttWindow: number;
  private readonly jitterAlpha: number;
  private readonly pingIntervalMs: number;
  private readonly warmupMs: number;
  private readonly warmupPingIntervalMs: number;

  private readonly rttSamples: number[] = [];
  private _minRtt = Number.NaN;
  private _jitter = 0;
  private prevRtt = Number.NaN;

  private lastServerTick = Number.NaN;
  private lastPongAt = Number.NaN;

  private connectedAt = Number.NaN;
  private lastPingAt = Number.NaN;

  constructor(opts: ClockSyncOptions = {}) {
    this.tickMs = opts.tickMs ?? SERVER_TICK_MS;
    this.rttWindow = opts.rttWindow ?? 10;
    this.jitterAlpha = opts.jitterAlpha ?? 0.1;
    this.pingIntervalMs = opts.pingIntervalMs ?? 500;
    this.warmupMs = opts.warmupMs ?? 2000;
    this.warmupPingIntervalMs = opts.warmupPingIntervalMs ?? 250;
  }

  /** Đánh dấu thời điểm connect (mốc tính warmup). */
  connect(now: number): void {
    this.connectedAt = now;
  }

  /** Đã có ít nhất một pong để ước lượng. */
  get hasSync(): boolean {
    return this.rttSamples.length > 0;
  }

  /** RTT ước lượng (ms) = min cửa sổ trượt; `NaN` khi chưa có mẫu. */
  get rtt(): number {
    return this._minRtt;
  }

  /** Jitter ước lượng (ms, EWMA độ lệch RTT). */
  get jitter(): number {
    return this._jitter;
  }

  get sampleCount(): number {
    return this.rttSamples.length;
  }

  /**
   * Nạp một PONG nhận lúc `receivedAt`. RTT = receivedAt − clientTime đã echo,
   * tính theo **số học wrap u32**: clientTime đi qua wire bị cắt còn u32
   * ([005] §6b) trong khi `receivedAt` là đồng hồ đầy đủ (`Date.now()` ~1.78e12,
   * không lọt u32) — trừ thẳng cho ra RTT ~1.78e12 ms.
   * Bỏ mẫu âm (đồng hồ lùi / gói hỏng).
   */
  onPong(pong: PongMessage, receivedAt: number): void {
    const rtt = u32TimeDelta(pong.clientTime, receivedAt);
    if (!(rtt >= 0)) return;

    this.rttSamples.push(rtt);
    if (this.rttSamples.length > this.rttWindow) this.rttSamples.shift();
    this._minRtt = Math.min(...this.rttSamples);

    if (Number.isFinite(this.prevRtt)) {
      const dev = Math.abs(rtt - this.prevRtt);
      this._jitter = this._jitter + this.jitterAlpha * (dev - this._jitter);
    }
    this.prevRtt = rtt;

    // Neo tick: server ở `serverTick` tại thời điểm gửi pong ≈ receivedAt − RTT/2.
    this.lastServerTick = pong.serverTick;
    this.lastPongAt = receivedAt;
  }

  /**
   * Ước lượng tick server tại `now`. `NaN` khi chưa sync.
   * `serverTickNow ≈ pongServerTick + (now − pongReceivedAt + RTT/2) / TICK_MS`.
   */
  serverTickNow(now: number): number {
    if (!Number.isFinite(this.lastServerTick) || !Number.isFinite(this._minRtt)) {
      return Number.NaN;
    }
    const elapsed = now - this.lastPongAt + this._minRtt / 2;
    return this.lastServerTick + elapsed / this.tickMs;
  }

  /**
   * Input lead khởi điểm theo RTT ([004] §4): `ceil(RTT/2 / TICK_MS) + 1`.
   * `NaN` khi chưa sync (caller giữ lead mặc định tới khi có mẫu).
   */
  baseInputLead(): number {
    if (!Number.isFinite(this._minRtt)) return Number.NaN;
    return Math.ceil(this._minRtt / 2 / this.tickMs) + 1;
  }

  /** Tới hạn gửi ping chưa (dày trong warmup, thưa sau đó). */
  shouldPing(now: number): boolean {
    if (!Number.isFinite(this.lastPingAt)) return true;
    const inWarmup = Number.isFinite(this.connectedAt) && now - this.connectedAt < this.warmupMs;
    const interval = inWarmup ? this.warmupPingIntervalMs : this.pingIntervalMs;
    return now - this.lastPingAt >= interval;
  }

  /** Đánh dấu đã gửi ping lúc `now`. */
  markPinged(now: number): void {
    this.lastPingAt = now;
  }
}
