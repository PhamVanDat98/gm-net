/**
 * Interest management / AOI ([006] §6, M9): client chỉ nhận entity **quanh mình**,
 * không phải cả world. Đây là nửa còn lại của bài toán băng thông — delta (M7)
 * nén những gì đã gửi, AOI quyết định *có gửi hay không*.
 *
 * Uniform grid (không quadtree): đơn giản, predictable, hợp top-down shooter
 * ([006] §6 chốt grid; quadtree để dành khi mật độ chênh lệch lớn).
 *
 * **Hysteresis** là điểm mấu chốt: vào tập ở bán kính `radius`, ra khỏi tập ở
 * `radius × hysteresis`. Không có nó, entity đứng đúng mép sẽ spawn/despawn liên
 * tục (flapping) mỗi tick — vừa tốn băng thông (mỗi lần vào lại là block FULL)
 * vừa làm remote nhấp nháy trên màn hình.
 */
import type { SnapshotEntity } from '@gm-net/core';

export interface AoiConfig {
  /** Bán kính quan tâm (đơn vị world). Entity trong bán kính này → vào tập. */
  radius: number;
  /**
   * Cạnh ô lưới. Mặc định = bán kính RA (`radius × hysteresis`) → vùng quan tâm
   * luôn nằm gọn trong **3×3 ô** quanh client ([006] §6).
   */
  cellSize?: number;
  /** Hệ số bán kính ra (mặc định 1.2 — [006] §6). Phải ≥ 1. */
  hysteresis?: number;
}

/** Khóa ô — số nguyên gộp, tránh alloc string mỗi lần tra. */
function cellKey(cx: number, cy: number): number {
  // Dịch về không âm rồi gộp: đủ cho lưới ±32k ô mỗi trục.
  return ((cx + 0x8000) << 16) | (cy + 0x8000);
}

export class InterestGrid {
  readonly radius: number;
  readonly exitRadius: number;
  readonly cellSize: number;

  private readonly cells = new Map<number, SnapshotEntity[]>();

  constructor(cfg: AoiConfig) {
    if (!(cfg.radius > 0)) throw new RangeError(`AOI radius phải > 0 (nhận ${cfg.radius})`);
    const hysteresis = cfg.hysteresis ?? 1.2;
    if (!(hysteresis >= 1)) throw new RangeError(`AOI hysteresis phải ≥ 1 (nhận ${hysteresis})`);
    this.radius = cfg.radius;
    this.exitRadius = cfg.radius * hysteresis;
    this.cellSize = cfg.cellSize ?? this.exitRadius;
  }

  /** Nạp lại lưới cho tick hiện tại (entity di chuyển mỗi tick — dựng lại rẻ hơn cập nhật). */
  rebuild(entities: readonly SnapshotEntity[]): void {
    this.cells.clear();
    for (const e of entities) {
      const key = cellKey(Math.floor(e.posX / this.cellSize), Math.floor(e.posY / this.cellSize));
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(e);
      else this.cells.set(key, [e]);
    }
  }

  /**
   * Tập entity client tại `(cx, cy)` nhìn thấy ở tick này.
   *
   * - Trong `radius` → vào tập (dù trước đó chưa có).
   * - Trong `exitRadius` **và** đã có trong `prev` → **ở lại** tập (hysteresis).
   * - Ngoài `exitRadius` → ra khỏi tập.
   *
   * Broad-phase quét các ô chồng lấn AABB bán kính `exitRadius` (≤ 3×3 ô), rồi
   * lọc chính xác bằng khoảng cách — lưới chỉ để khỏi duyệt toàn world.
   */
  visible(cx: number, cy: number, prev: ReadonlySet<number>): SnapshotEntity[] {
    const out: SnapshotEntity[] = [];
    const r2 = this.radius * this.radius;
    const rExit2 = this.exitRadius * this.exitRadius;

    const minCx = Math.floor((cx - this.exitRadius) / this.cellSize);
    const maxCx = Math.floor((cx + this.exitRadius) / this.cellSize);
    const minCy = Math.floor((cy - this.exitRadius) / this.cellSize);
    const maxCy = Math.floor((cy + this.exitRadius) / this.cellSize);

    for (let gx = minCx; gx <= maxCx; gx++) {
      for (let gy = minCy; gy <= maxCy; gy++) {
        const bucket = this.cells.get(cellKey(gx, gy));
        if (!bucket) continue;
        for (const e of bucket) {
          const dx = e.posX - cx;
          const dy = e.posY - cy;
          const d2 = dx * dx + dy * dy;
          if (d2 <= r2 || (d2 <= rExit2 && prev.has(e.entityId))) out.push(e);
        }
      }
    }
    return out;
  }
}
