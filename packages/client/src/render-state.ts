/**
 * Visual smoothing ([docs/design/004-netcode.md] §5, IMPLEMENTATION 4.5): tách
 * "simulation transform" (nhảy tự do khi correction) khỏi "render transform"
 * (thứ vẽ lên màn hình). Render transform đuổi theo simulation transform bằng
 * exponential smoothing (thời hằng ~50–100ms) — correction vài mm được trải ra
 * vài frame thay vì giật hình; lệch quá lớn (teleport/respawn) thì snap thẳng
 * vì kéo lê qua nửa màn hình còn tệ hơn.
 */

export interface RenderTransform {
  posX: number;
  posY: number;
  /** Góc radian. */
  rot: number;
}

export interface TransformSmootherOptions {
  /** Thời hằng smoothing (ms) — sau tau, còn ~37% khoảng lệch. Mặc định 80. */
  tauMs?: number;
  /** Lệch vị trí (m) vượt ngưỡng → snap thẳng (teleport). Mặc định 3. */
  teleportDistance?: number;
}

const TWO_PI = Math.PI * 2;

/** Hiệu góc ngắn nhất `b - a` trong (-π, π]. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d <= -Math.PI) d += TWO_PI;
  return d;
}

export class TransformSmoother {
  private readonly tauMs: number;
  private readonly teleportDistance: number;
  private cur: RenderTransform | undefined;

  constructor(opts: TransformSmootherOptions = {}) {
    this.tauMs = opts.tauMs ?? 80;
    this.teleportDistance = opts.teleportDistance ?? 3;
  }

  /** Render transform hiện tại (undefined trước update đầu tiên). */
  get current(): RenderTransform | undefined {
    return this.cur;
  }

  /** Quên trạng thái (respawn/đổi entity) — update sau sẽ snap. */
  reset(): void {
    this.cur = undefined;
  }

  /**
   * Đuổi render transform theo `target` (simulation transform) sau `dtMs`.
   * Lần đầu hoặc lệch vượt `teleportDistance` → snap.
   */
  update(target: RenderTransform, dtMs: number): RenderTransform {
    const cur = this.cur;
    if (!cur || Math.hypot(target.posX - cur.posX, target.posY - cur.posY) > this.teleportDistance) {
      this.cur = { posX: target.posX, posY: target.posY, rot: target.rot };
      return this.cur;
    }
    // k ∈ [0,1): tỉ lệ khoảng lệch thu hẹp trong dt — độc lập framerate.
    const k = 1 - Math.exp(-Math.max(0, dtMs) / this.tauMs);
    cur.posX += (target.posX - cur.posX) * k;
    cur.posY += (target.posY - cur.posY) * k;
    cur.rot += angleDelta(cur.rot, target.rot) * k;
    return cur;
  }
}
