/**
 * Input pipeline phía client ([docs/design/004-netcode.md] §3–4).
 *
 * - Lấy mẫu một lần mỗi tick → gán `seq` đơn điệu tăng, đẩy vào `pendingInputs`.
 * - Mỗi packet gửi kèm **redundancy** N input gần nhất chưa ack: mất 1 packet
 *   không mất input, packet sau mang lại (server bỏ seq đã xử lý).
 * - Nhận ack (`lastProcessedSeq` trong snapshot) → cắt phần đầu pending đã xử lý.
 *
 * `InputLeadController` tách riêng: điều chỉnh `inputLead` (số tick nhắm trước
 * server) theo tỉ lệ input đến muộn, có hysteresis.
 */
import { seqGreaterEqual, type InputEntry, type InputMessage } from '@gm-net/core';

interface PendingInput<P> {
  seq: number;
  tick: number;
  payload: P;
}

export interface InputPipelineOptions {
  /** Số input redundant mỗi packet (3–5). Mặc định 4. */
  redundancy?: number;
}

export interface SampledInput<P> {
  /** Seq đã gán cho input vừa lấy mẫu (u16). */
  seq: number;
  /** Tick input này nhắm tới. */
  tick: number;
  /** Packet sẵn sàng encode + gửi (đã kèm redundancy). */
  packet: InputMessage<P>;
}

export class InputPipeline<P = unknown> {
  private readonly redundancy: number;
  private readonly pending: PendingInput<P>[] = [];
  /**
   * Seq bắt đầu từ 1 (không phải 0): server ack `lastProcessedSeq = 0` vừa nghĩa
   * "chưa xử lý gì" vừa nghĩa "đã xử lý seq 0" (nhập nhằng M2). Bắt đầu từ 1 để
   * ack 0 chắc chắn không cắt nhầm input đầu tiên.
   */
  private nextSeq = 1;

  constructor(opts: InputPipelineOptions = {}) {
    this.redundancy = opts.redundancy ?? 4;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Seq mới nhất đã lấy mẫu (0 nếu chưa có). */
  get latestSeq(): number {
    return this.pending.length ? this.pending[this.pending.length - 1].seq : 0;
  }

  /**
   * Lấy mẫu một input nhắm `tick`, trả packet (kèm redundancy + `ackTick`).
   * Không tự gửi — caller encode qua codec rồi đẩy xuống transport.
   */
  sample(payload: P, tick: number, ackTick: number): SampledInput<P> {
    const seq = this.nextSeq;
    this.nextSeq = (this.nextSeq + 1) & 0xffff;
    this.pending.push({ seq, tick, payload });

    // Redundancy = N input đuôi (seq liên tiếp vì pending luôn là hậu tố liền mạch).
    const from = Math.max(0, this.pending.length - this.redundancy);
    const inputs: InputEntry<P>[] = [];
    for (let i = from; i < this.pending.length; i++) {
      inputs.push({ tick: this.pending[i].tick, payload: this.pending[i].payload });
    }
    return { seq, tick, packet: { ackTick, latestSeq: seq, inputs } };
  }

  /**
   * Cắt các input đã được server xử lý (`seq ≤ lastProcessedSeq`, xét wrap).
   * pending là hậu tố seq liền mạch tăng dần nên chỉ cần bỏ phần đầu.
   */
  ack(lastProcessedSeq: number): void {
    while (this.pending.length && seqGreaterEqual(lastProcessedSeq, this.pending[0].seq)) {
      this.pending.shift();
    }
  }

  /** Input chưa ack theo thứ tự cũ → mới (M4 replay reconciliation dùng). */
  unacked(): ReadonlyArray<{ seq: number; tick: number; payload: P }> {
    return this.pending;
  }
}

export interface InputLeadOptions {
  /** Lead khởi điểm trước khi có RTT. Mặc định 2. */
  initial?: number;
  /** Chặn dưới. Mặc định 1. */
  min?: number;
  /** Chặn trên. Mặc định 10. */
  max?: number;
  /** Số snapshot "sạch" liên tiếp trước khi giảm lead (hysteresis). Mặc định 30 (~1s @30Hz). */
  hysteresis?: number;
}

/**
 * Điều chỉnh `inputLead` thích ứng ([004] §4): tăng ngay 1 tick khi thấy input
 * đến muộn, giảm 1 tick sau `hysteresis` snapshot liên tiếp sạch — cân bằng độ
 * trễ input với ổn định. Bất đối xứng (tăng nhanh, giảm chậm) để không dao động.
 */
export class InputLeadController {
  private _lead: number;
  private readonly min: number;
  private readonly max: number;
  private readonly hysteresis: number;
  private cleanStreak = 0;
  private baseApplied = false;

  constructor(opts: InputLeadOptions = {}) {
    this._lead = opts.initial ?? 2;
    this.min = opts.min ?? 1;
    this.max = opts.max ?? 10;
    this.hysteresis = opts.hysteresis ?? 30;
  }

  get lead(): number {
    return this._lead;
  }

  /** Đặt lead theo RTT lần đầu có sync (`ceil(RTT/2/TICK_MS)+1`), sau đó tự thích ứng. */
  applyBase(base: number): void {
    if (this.baseApplied || !Number.isFinite(base)) return;
    this._lead = this.clamp(base);
    this.baseApplied = true;
  }

  /**
   * Cập nhật theo một snapshot: `lateDelta` = số input muộn mới kể từ snapshot
   * trước (server đếm dồn, client lấy hiệu). >0 → tăng lead; =0 → tiến tới giảm.
   */
  onSnapshot(lateDelta: number): void {
    if (lateDelta > 0) {
      this.cleanStreak = 0;
      this._lead = this.clamp(this._lead + 1);
      return;
    }
    this.cleanStreak++;
    if (this.cleanStreak >= this.hysteresis) {
      this.cleanStreak = 0;
      this._lead = this.clamp(this._lead - 1);
    }
  }

  private clamp(v: number): number {
    return Math.max(this.min, Math.min(this.max, v));
  }
}
