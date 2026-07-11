/**
 * Interface `Simulation` ([docs/design/004-netcode.md] §5, IMPLEMENTATION 4.1):
 * hợp đồng giữa game và framework để **cùng một logic mô phỏng chạy hai nơi** —
 * server (authoritative, qua `GameLogic` adapter của `@gm-net/server`) và client
 * (prediction + reconciliation của `@gm-net/client`). Framework không hiểu nội
 * dung `World`/`Input`/`Snap`; chỉ điều phối qua các phép này.
 *
 * Factory tạo world là hàm riêng của từng game (vd `createBoxWorld` trong
 * `@gm-net/shared/box-sim`) vì tham số khởi tạo là chuyện của game, không thuộc
 * hợp đồng framework.
 *
 * Yêu cầu then chốt cho prediction ([003] quyết định 1–2):
 * - `step` phải thuần f(state, inputs) với timestep cố định — cùng dt, cùng máy,
 *   cùng chuỗi input → cùng kết quả (Rapier restore+replay đã verify bit-perfect).
 * - `takeSnapshot`/`restoreSnapshot` phải bắt trọn state ẩn (contact cache,
 *   sleeping…) — nếu không, replay sau restore lệch → correction loop không dứt.
 * - Input client áp local phải là bản **round-trip qua codec** (canonical) — server
 *   chỉ thấy bản decode từ wire; áp bản chưa quantize là tự tạo misprediction.
 */
import type { SnapshotEntity } from '@gm-net/core';

/** Transform + velocity một entity — tập field framework serialize được ([005] §3). */
export interface EntityTransform {
  posX: number;
  posY: number;
  /** Góc radian. */
  rot: number;
  velX: number;
  velY: number;
}

/**
 * Logic mô phỏng dùng chung client/server. `World` là state mô phỏng (vd Rapier
 * world + map entity), `Input` là payload input của game, `Snap` là dạng snapshot
 * opaque cho ring buffer (restore + replay).
 */
export interface Simulation<World = unknown, Input = unknown, Snap = unknown> {
  /** Áp một input đã validate cho entity tại tick `tick`. */
  applyInput(world: World, entityId: number, input: Input, tick: number): void;

  /** Bước mô phỏng đúng một tick cố định `stepMs`. */
  step(world: World, stepMs: number, tick: number): void;

  /** Sinh entity tại transform cho trước (client mirror entity lạ từ snapshot). */
  spawn(world: World, entityId: number, entityType: number, at: EntityTransform): void;

  /** Gỡ entity khỏi world. Không tồn tại → no-op. */
  despawn(world: World, entityId: number): void;

  /** Transform hiện tại của entity; `undefined` nếu không tồn tại. */
  getEntity(world: World, entityId: number): EntityTransform | undefined;

  /** Ghi đè transform một entity (reconciliation ghi state authoritative). */
  setEntity(world: World, entityId: number, t: EntityTransform): void;

  /** Toàn bộ entity hiện có, dạng snapshot wire ([005] §3). */
  listEntities(world: World): SnapshotEntity[];

  /** Chụp toàn bộ state (kể cả state ẩn) — đẩy vào ring buffer. */
  takeSnapshot(world: World): Snap;

  /** Khôi phục world về đúng state đã chụp (mutate `world` tại chỗ). */
  restoreSnapshot(world: World, snap: Snap): void;
}
