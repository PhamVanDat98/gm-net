/**
 * Nhận state phía client ([docs/design/004-netcode.md] §6, [005] §4). Parse bytes
 * qua codec, **bỏ bản cũ hơn bản mới nhất đã có** (state sync chỉ cần bản mới
 * nhất; gói đến trễ/đảo thứ tự do jitter là bình thường), rồi phát cho lớp trên
 * (M4 reconciliation, M5 interpolation) tiêu thụ.
 *
 * M7: server có thể gửi **DELTA** thay cho full snapshot. Client phải giữ **ring
 * snapshot gần đây**, không chỉ bản mới nhất: ack đi kèm INPUT nên tới server
 * trễ, baseline server chọn thường là một snapshot CŨ của client. Delta không
 * khớp baseline nào trong ring → bỏ; client tiếp tục ack tick cũ, server thấy ack
 * đứng yên/quá già sẽ gửi keyframe (tự lành, [005] §4).
 */
import { TickRing, applySnapshotDelta, type ProtocolCodec, type Snapshot } from '@gm-net/core';

export type SnapshotListener = (snap: Snapshot) => void;

export interface SnapshotReceiverOptions {
  /** Số snapshot gần đây giữ làm baseline delta (~1s; mặc định 30). */
  baselineTicks?: number;
}

export interface SnapshotReceiverStats {
  /** Số delta áp thành công. */
  deltasApplied: number;
  /** Số full snapshot (keyframe) đã nhận. */
  keyframes: number;
  /** Số delta phải bỏ vì không có baseline khớp trong ring. */
  deltasDropped: number;
}

export class SnapshotReceiver<Input = unknown> {
  private _latest: Snapshot | undefined;
  private readonly listeners = new Set<SnapshotListener>();
  private readonly baselines: TickRing<Snapshot>;
  private readonly stats: SnapshotReceiverStats = {
    deltasApplied: 0,
    keyframes: 0,
    deltasDropped: 0,
  };

  constructor(
    private readonly codec: ProtocolCodec<Input>,
    opts: SnapshotReceiverOptions = {},
  ) {
    this.baselines = new TickRing<Snapshot>(opts.baselineTicks ?? 30);
  }

  /** Snapshot mới nhất đã chấp nhận (undefined nếu chưa có). */
  get latest(): Snapshot | undefined {
    return this._latest;
  }

  /** Tick của snapshot mới nhất; -1 nếu chưa có (dùng làm `ackTick` gửi lên). */
  get latestTick(): number {
    return this._latest ? this._latest.serverTick : -1;
  }

  snapshotStats(): SnapshotReceiverStats {
    return { ...this.stats };
  }

  /** Đăng ký listener; trả hàm gỡ. */
  onSnapshot(cb: SnapshotListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Nạp một gói SNAPSHOT (keyframe). Trả snapshot nếu được chấp nhận (mới hơn),
   * `undefined` nếu là bản cũ (bỏ). Ném nếu bytes hỏng (caller nuốt).
   */
  receive(bytes: Uint8Array): Snapshot | undefined {
    const snap = this.codec.decodeSnapshot(bytes);
    this.stats.keyframes++;
    return this.accept(snap);
  }

  /**
   * Nạp một gói DELTA: dựng lại snapshot đầy đủ từ baseline trong ring.
   * `undefined` khi không có baseline khớp (server sẽ keyframe) hoặc bản cũ.
   */
  receiveDelta(bytes: Uint8Array): Snapshot | undefined {
    const delta = this.codec.decodeDelta(bytes);
    const baseline = this.baselines.get(delta.baselineTick);
    if (!baseline) {
      this.stats.deltasDropped++;
      return undefined;
    }
    const snap = applySnapshotDelta(baseline, delta);
    this.stats.deltasApplied++;
    return this.accept(snap);
  }

  /**
   * Reconnect ([006] §5, M8): bỏ state + ring baseline. Snapshot của phiên trước
   * không còn dùng làm baseline được (server đã reset baseline phía nó), và tick
   * mới nhất cũ sẽ chặn nhầm keyframe resync nếu server tick... vẫn tăng — nhưng
   * quan trọng hơn: ack tick cũ sẽ khiến server tưởng client còn baseline đó.
   */
  reset(): void {
    this._latest = undefined;
    this.baselines.clear();
  }

  /** Chống lùi tick + ghi ring baseline + phát cho listener. */
  private accept(snap: Snapshot): Snapshot | undefined {
    if (this._latest && snap.serverTick <= this._latest.serverTick) {
      return undefined; // cũ hơn / trùng bản đã có
    }
    this._latest = snap;
    this.baselines.set(snap.serverTick, snap);
    for (const cb of this.listeners) cb(snap);
    return snap;
  }
}
