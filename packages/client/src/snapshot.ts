/**
 * Nhận snapshot phía client ([docs/design/004-netcode.md] §6). Parse bytes qua
 * codec, **bỏ bản cũ hơn bản mới nhất đã có** (state sync chỉ cần bản mới nhất;
 * gói đến trễ/đảo thứ tự do jitter là bình thường), rồi phát cho lớp trên (M4
 * reconciliation, M5 interpolation) tiêu thụ.
 *
 * M3 chỉ giữ khung nhận + chống lùi tick; nội suy/tiêu thụ để M4/M5.
 */
import type { ProtocolCodec, Snapshot } from '@gm-net/core';

export type SnapshotListener = (snap: Snapshot) => void;

export class SnapshotReceiver<Input = unknown> {
  private _latest: Snapshot | undefined;
  private readonly listeners = new Set<SnapshotListener>();

  constructor(private readonly codec: ProtocolCodec<Input>) {}

  /** Snapshot mới nhất đã chấp nhận (undefined nếu chưa có). */
  get latest(): Snapshot | undefined {
    return this._latest;
  }

  /** Tick của snapshot mới nhất; -1 nếu chưa có (dùng làm `ackTick` gửi lên). */
  get latestTick(): number {
    return this._latest ? this._latest.serverTick : -1;
  }

  /** Đăng ký listener; trả hàm gỡ. */
  onSnapshot(cb: SnapshotListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Nạp một gói SNAPSHOT. Trả snapshot nếu được chấp nhận (mới hơn), `undefined`
   * nếu là bản cũ (bỏ). Ném nếu bytes hỏng (caller nuốt).
   */
  receive(bytes: Uint8Array): Snapshot | undefined {
    const snap = this.codec.decodeSnapshot(bytes);
    if (this._latest && snap.serverTick <= this._latest.serverTick) {
      return undefined; // cũ hơn / trùng bản đã có
    }
    this._latest = snap;
    for (const cb of this.listeners) cb(snap);
    return snap;
  }
}
