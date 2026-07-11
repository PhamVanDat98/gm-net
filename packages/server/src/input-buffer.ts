/**
 * Jitter buffer input per-client ([docs/design/006-server-rooms.md] §2–3,
 * [004] §4). Nhận packet `INPUT` (redundancy 3–5), dedupe theo seq, xếp theo
 * tick, rút tại tick T (thiếu → lặp input cuối), đồng thời police:
 * - cửa sổ tick hợp lệ ±`maxTickSkew` (bỏ vĩnh viễn input tick ngoài giờ);
 * - ngân sách `budgetPerTick` input mới/tick/client (chống flood) — hết budget
 *   thì *hoãn* phần còn lại của packet, không đánh dấu đã thấy, để redundancy
 *   của packet sau mang lại (không mất input sau burst mất gói);
 * - đếm input muộn (tick của nó đã qua, không bao giờ áp được) cho adaptive
 *   lead — đọc theo cửa sổ qua {@link InputBuffer.consumeLateInputs}.
 */
import { seqGreater, type InputMessage } from '@gm-net/core';

export interface InputBufferOptions {
  /** Cửa sổ tick hợp lệ tính bằng số tick (≈1s). */
  maxTickSkew: number;
  /** Số input mới tối đa chấp nhận mỗi tick server. */
  budgetPerTick: number;
}

export interface TakeResult<P> {
  seq: number;
  payload: P | undefined;
  /** true nếu là input cũ lặp lại (không có input mới cho tick này). */
  repeated: boolean;
}

export interface InputBufferStats {
  lateInputs: number;
  /** Input bị hoãn vì hết budget (có thể được nhận lại từ redundancy sau). */
  droppedFlood: number;
  droppedWindow: number;
  duplicates: number;
}

export class InputBuffer<P = unknown> {
  private readonly pending = new Map<number, { seq: number; payload: P | undefined }>();
  /** seq cao nhất đã thấy (-1 = chưa có). */
  private highestSeq = -1;
  private lastAppliedSeq = -1;
  private lastPayload: P | undefined;
  private hasApplied = false;

  private _lateInputs = 0;
  private _lateSinceRead = 0;
  private _droppedFlood = 0;
  private _droppedWindow = 0;
  private _duplicates = 0;

  private budgetTick = Number.NaN;
  private budgetUsed = 0;

  constructor(private readonly opts: InputBufferOptions) {}

  /** Seq cao nhất đã áp — ack gửi về client. */
  get lastProcessedSeq(): number {
    return this.lastAppliedSeq < 0 ? 0 : this.lastAppliedSeq;
  }

  /** Tổng input muộn trọn đời (quan sát/metrics — không dùng cho adaptive lead). */
  get lateInputs(): number {
    return this._lateInputs;
  }

  /**
   * Số input muộn *kể từ lần đọc trước* rồi reset — mỗi snapshot mang delta của
   * riêng nó. Không dùng counter trọn đời: nó chỉ tăng nên sau ~255 lần muộn sẽ
   * bão hòa u8 vĩnh viễn, client tưởng "đang muộn liên tục" dù mạng đã ổn.
   */
  consumeLateInputs(): number {
    const n = this._lateSinceRead;
    this._lateSinceRead = 0;
    return n;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get stats(): InputBufferStats {
    return {
      lateInputs: this._lateInputs,
      droppedFlood: this._droppedFlood,
      droppedWindow: this._droppedWindow,
      duplicates: this._duplicates,
    };
  }

  /**
   * Nạp một packet `INPUT` khi server đang ở tick `serverTick`. Seq mỗi input
   * suy ra từ `latestSeq` + vị trí trong packet ([005] §6).
   */
  ingest(msg: InputMessage<P>, serverTick: number): void {
    if (this.budgetTick !== serverTick) {
      this.budgetTick = serverTick;
      this.budgetUsed = 0;
    }
    const count = msg.inputs.length;
    for (let i = 0; i < count; i++) {
      const entry = msg.inputs[i];
      const seq = (msg.latestSeq - (count - 1) + i) & 0xffff;

      // Dedupe redundancy: đã thấy seq này hoặc cũ hơn → bỏ.
      if (this.highestSeq >= 0 && !seqGreater(seq, this.highestSeq)) {
        this._duplicates++;
        continue;
      }

      // Cửa sổ tick hợp lệ (input tick ngoài giờ → gian lận/lỗi): bỏ vĩnh viễn.
      if (Math.abs(entry.tick - serverTick) > this.opts.maxTickSkew) {
        this.highestSeq = seq;
        this._droppedWindow++;
        continue;
      }

      // Muộn (tick đã qua): không bao giờ rút được → chỉ đếm cho adaptive
      // lead, không tốn budget, không vào pending.
      if (entry.tick < serverTick) {
        this.highestSeq = seq;
        this._lateInputs++;
        this._lateSinceRead++;
        continue;
      }

      // Hết ngân sách tick này: DỪNG cả packet, KHÔNG đánh dấu đã thấy —
      // redundancy của packet sau mang lại các seq này (budget đã reset).
      // Nếu đánh dấu, input hợp lệ sau burst mất gói sẽ mất vĩnh viễn
      // (resend bị coi là duplicate). Duyệt cũ → mới nên watermark vẫn đúng.
      if (this.budgetUsed >= this.opts.budgetPerTick) {
        this._droppedFlood += count - i;
        break;
      }
      this.budgetUsed++;
      this.highestSeq = seq;
      this.pending.set(entry.tick, { seq, payload: entry.payload });
    }
  }

  /**
   * Rút input cho tick `tick`. Có → áp; thiếu và `repeatLast` → lặp input cuối;
   * còn lại → undefined (chưa có input nào).
   */
  take(tick: number, repeatLast: boolean): TakeResult<P> | undefined {
    const found = this.pending.get(tick);
    if (found) {
      this.pending.delete(tick);
      // Dọn các tick cũ hơn đã bị bỏ qua (sẽ không bao giờ rút nữa).
      for (const t of this.pending.keys()) {
        if (t < tick) this.pending.delete(t);
      }
      this.lastAppliedSeq = found.seq;
      this.lastPayload = found.payload;
      this.hasApplied = true;
      return { seq: found.seq, payload: found.payload, repeated: false };
    }
    if (repeatLast && this.hasApplied) {
      return { seq: this.lastAppliedSeq, payload: this.lastPayload, repeated: true };
    }
    return undefined;
  }
}
