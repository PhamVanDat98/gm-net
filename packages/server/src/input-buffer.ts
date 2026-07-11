/**
 * Jitter buffer input per-client ([docs/design/006-server-rooms.md] §2–3,
 * [004] §4). Nhận packet `INPUT` (redundancy 3–5), dedupe theo seq, xếp theo
 * tick, rút tại tick T (thiếu → lặp input cuối), đồng thời police:
 * - cửa sổ tick hợp lệ ±`maxTickSkew` (bỏ input tick ngoài giờ);
 * - ngân sách `budgetPerTick` input mới/tick/client (chống flood);
 * - đếm `lateInputs` (input tới sau khi tick của nó đã qua) cho adaptive lead.
 */
import type { InputMessage } from '@gm-net/core';

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
  droppedFlood: number;
  droppedWindow: number;
  duplicates: number;
}

/** So sánh seq 16-bit có xét wrap-around: `a` mới hơn `b`. */
export function seqGreater(a: number, b: number): boolean {
  return a !== b && ((a - b) & 0xffff) < 0x8000;
}

export class InputBuffer<P = unknown> {
  private readonly pending = new Map<number, { seq: number; payload: P | undefined }>();
  /** seq cao nhất đã thấy (-1 = chưa có). */
  private highestSeq = -1;
  private lastAppliedSeq = -1;
  private lastPayload: P | undefined;
  private hasApplied = false;

  private _lateInputs = 0;
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

  get lateInputs(): number {
    return this._lateInputs;
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
      this.highestSeq = seq; // đánh dấu đã thấy (kể cả khi drop dưới đây)

      // Cửa sổ tick hợp lệ (input tick ngoài giờ → gian lận/lỗi).
      if (Math.abs(entry.tick - serverTick) > this.opts.maxTickSkew) {
        this._droppedWindow++;
        continue;
      }
      // Ngân sách chống flood.
      if (this.budgetUsed >= this.opts.budgetPerTick) {
        this._droppedFlood++;
        continue;
      }
      this.budgetUsed++;

      if (entry.tick < serverTick) this._lateInputs++; // tới muộn hơn tick của nó
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
