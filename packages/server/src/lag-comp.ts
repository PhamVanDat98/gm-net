/**
 * Lag compensation ([006] §4, M10) — **phương án (b)**: giữ history
 * position/rotation per entity (ring ~1s) và raycast thủ công trên hình học tại
 * tick cũ, thay vì `restoreSnapshot` cả world (phương án (a) — đắt hơn nhiều, để
 * dành khi cần rewind cả tương tác vật lý).
 *
 * Vì sao cần: người bắn nhìn remote entity **trễ** một khoảng interpolation delay
 * (~100ms) cộng nửa RTT. Nếu server kiểm trúng/trượt trên vị trí *hiện tại* của
 * mục tiêu, người chơi ping cao bắn trúng trên màn hình vẫn trượt trên server.
 * Server phải tua ngược world về đúng thời điểm người bắn **nhìn thấy**.
 */
import { TickRing, type SnapshotEntity } from '@gm-net/core';

/** Transform tối thiểu để rewind — không giữ velocity/custom (hitscan không cần). */
export interface HistoryEntity {
  entityId: number;
  posX: number;
  posY: number;
  rot: number;
}

export interface HitscanQuery {
  originX: number;
  originY: number;
  /** Hướng bắn (không cần chuẩn hóa; vector 0 → không trúng gì). */
  dirX: number;
  dirY: number;
  maxDistance: number;
  /** Bán kính hitbox (tròn) của mục tiêu. */
  targetRadius: number;
  /** Entity bỏ qua (thường là chính người bắn). */
  ignoreEntityId?: number;
}

export interface HitResult {
  entityId: number;
  /** Khoảng cách từ origin tới điểm chạm. */
  distance: number;
  /** Tick mà hit được kiểm (đã rewind). */
  tick: number;
}

/** Ring history transform theo tick ([006] §4: ~1s, mặc định 30 tick @30Hz). */
export class EntityHistory {
  private readonly ring: TickRing<HistoryEntity[]>;

  constructor(readonly capacityTicks = 30) {
    this.ring = new TickRing<HistoryEntity[]>(capacityTicks);
  }

  /** Ghi transform của mọi entity tại `tick` (gọi mỗi tick sau khi simulate). */
  record(tick: number, entities: readonly SnapshotEntity[]): void {
    this.ring.set(
      tick,
      entities.map((e) => ({ entityId: e.entityId, posX: e.posX, posY: e.posY, rot: e.rot })),
    );
  }

  /** Transform tại `tick`, hoặc `undefined` nếu ngoài ring. */
  at(tick: number): HistoryEntity[] | undefined {
    return this.ring.get(tick);
  }
}

/**
 * Ray vs circle: khoảng cách tới điểm chạm đầu tiên, hoặc `undefined` nếu trượt.
 * Trả 0 khi origin nằm trong hitbox (bắn áp sát vẫn trúng).
 */
export function rayCircle(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  cx: number,
  cy: number,
  radius: number,
  maxDistance: number,
): number | undefined {
  const len = Math.hypot(dx, dy);
  if (len === 0) return undefined;
  const nx = dx / len;
  const ny = dy / len;

  const mx = cx - ox;
  const my = cy - oy;
  const proj = mx * nx + my * ny; // chiếu tâm lên tia
  const dist2ToCenter = mx * mx + my * my;

  if (dist2ToCenter <= radius * radius) return 0; // origin đã nằm trong hitbox
  if (proj < 0) return undefined; // mục tiêu ở phía sau

  const perp2 = dist2ToCenter - proj * proj;
  const r2 = radius * radius;
  if (perp2 > r2) return undefined; // tia đi lệch khỏi hình tròn

  const hit = proj - Math.sqrt(r2 - perp2);
  return hit >= 0 && hit <= maxDistance ? hit : undefined;
}

/** Entity gần nhất bị tia bắn trúng trong tập transform tại một tick. */
export function hitscan(entities: readonly HistoryEntity[], q: HitscanQuery, tick: number): HitResult | undefined {
  let best: HitResult | undefined;
  for (const e of entities) {
    if (e.entityId === q.ignoreEntityId) continue;
    const d = rayCircle(q.originX, q.originY, q.dirX, q.dirY, e.posX, e.posY, q.targetRadius, q.maxDistance);
    if (d === undefined) continue;
    if (!best || d < best.distance) best = { entityId: e.entityId, distance: d, tick };
  }
  return best;
}
