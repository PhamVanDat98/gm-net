/**
 * Demo simulation "box" cho M4/M5 ([docs/design/004-netcode.md] §3, §5): mỗi
 * player một box Rapier dynamic trong world top-down (không trọng lực), tường
 * tĩnh quanh biên. Input = vector di chuyển; áp bằng `setLinvel` (deterministic,
 * replay-safe). Implement interface {@link Simulation} — cùng code chạy ở server
 * (authoritative) lẫn client (prediction).
 *
 * Nằm sau **subpath export** `@gm-net/shared/box-sim` (không re-export từ index)
 * để game thật không kéo WASM Rapier vào bundle khi chỉ dùng interface/constants.
 *
 * Lưu ý dùng:
 * - `await initPhysics2D()` (từ `@gm-net/physics-2d`) trước khi `createBoxWorld`.
 * - Rotation bị khóa (`lockRotations`): wire snapshot không mang angular velocity
 *   ([005] §3) nên box xoay tự do sẽ không dự đoán được — demo không cần xoay.
 * - Input lấy mẫu phải qua {@link canonicalBoxInput} trước khi vừa gửi vừa áp
 *   local: client phải áp đúng bản server sẽ decode từ wire.
 */
import type { BitReader, BitWriter, CustomCodec, SnapshotEntity, WorldBounds } from '@gm-net/core';
import { RAPIER } from '@gm-net/physics-2d';
import type { EntityTransform, Simulation } from './simulation.js';

type RapierWorld = InstanceType<typeof RAPIER.World>;

/** Input demo: vector di chuyển, mỗi trục ∈ [-1, 1]. */
export interface BoxInput {
  moveX: number;
  moveY: number;
}

/** Độ phân giải input trên wire (i16 = move × 1000). */
export const BOX_INPUT_SCALE = 1000;

/**
 * Chuẩn hóa input về đúng giá trị sau round-trip wire (clamp [-1,1] + lượng tử
 * 1/1000). Client PHẢI áp bản canonical này local — nếu áp bản thô, velocity
 * local lệch với server từng tick và prediction trôi dần thành misprediction.
 */
export function canonicalBoxInput(moveX: number, moveY: number): BoxInput {
  const c = (v: number) =>
    Math.round(Math.max(-1, Math.min(1, v)) * BOX_INPUT_SCALE) / BOX_INPUT_SCALE;
  return { moveX: c(moveX), moveY: c(moveY) };
}

/** Codec wire cho {@link BoxInput} ([005] §5): 2 × i16. */
export const boxInputCodec: CustomCodec<BoxInput> = {
  encode(w: BitWriter, s: BoxInput): void {
    w.writeI16(Math.round(Math.max(-1, Math.min(1, s.moveX)) * BOX_INPUT_SCALE));
    w.writeI16(Math.round(Math.max(-1, Math.min(1, s.moveY)) * BOX_INPUT_SCALE));
  },
  decode(r: BitReader): BoxInput {
    return { moveX: r.readI16() / BOX_INPUT_SCALE, moveY: r.readI16() / BOX_INPUT_SCALE };
  },
};

export interface BoxWorldOptions {
  bounds: WorldBounds;
  /** Tốc độ (m/s) khi |move| = 1. Mặc định 10. */
  moveSpeed?: number;
  /** Nửa cạnh box (m). Mặc định 0.5. */
  halfExtent?: number;
  /** Dựng 4 tường tĩnh quanh biên. Mặc định true. */
  walls?: boolean;
}

export interface BoxWorld {
  /** Rapier world — thay thế tại chỗ khi restoreSnapshot. */
  rapier: RapierWorld;
  /** entityId → rigid body handle (handle giữ nguyên qua snapshot/restore). */
  bodies: Map<number, number>;
  readonly moveSpeed: number;
  readonly halfExtent: number;
}

/** Snapshot opaque: bytes Rapier + bản sao map entity (spawn/despawn giữa chừng). */
export interface BoxSnapshot {
  bytes: Uint8Array;
  bodies: Map<number, number>;
}

/** entityType duy nhất của demo. */
export const BOX_ENTITY_TYPE = 0;

const WALL_THICKNESS = 1;

/** Tạo world demo. Yêu cầu `await initPhysics2D()` trước. */
export function createBoxWorld(opts: BoxWorldOptions): BoxWorld {
  const rapier = new RAPIER.World({ x: 0, y: 0 });
  if (opts.walls ?? true) {
    const { minX, maxX, minY, maxY } = opts.bounds;
    const halfW = (maxX - minX) / 2 + WALL_THICKNESS;
    const halfH = (maxY - minY) / 2 + WALL_THICKNESS;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const wall = (hx: number, hy: number, x: number, y: number) =>
      rapier.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy).setTranslation(x, y));
    wall(halfW, WALL_THICKNESS / 2, cx, maxY + WALL_THICKNESS / 2); // trên
    wall(halfW, WALL_THICKNESS / 2, cx, minY - WALL_THICKNESS / 2); // dưới
    wall(WALL_THICKNESS / 2, halfH, minX - WALL_THICKNESS / 2, cy); // trái
    wall(WALL_THICKNESS / 2, halfH, maxX + WALL_THICKNESS / 2, cy); // phải
  }
  return {
    rapier,
    bodies: new Map(),
    moveSpeed: opts.moveSpeed ?? 10,
    halfExtent: opts.halfExtent ?? 0.5,
  };
}

function getBody(world: BoxWorld, entityId: number) {
  const handle = world.bodies.get(entityId);
  return handle === undefined ? undefined : world.rapier.getRigidBody(handle);
}

export const boxSim: Simulation<BoxWorld, BoxInput, BoxSnapshot> = {
  applyInput(world, entityId, input, _tick) {
    const body = getBody(world, entityId);
    if (!body) return;
    const cl = (v: number) => Math.max(-1, Math.min(1, v));
    body.setLinvel({ x: cl(input.moveX) * world.moveSpeed, y: cl(input.moveY) * world.moveSpeed }, true);
  },

  step(world, stepMs, _tick) {
    world.rapier.timestep = stepMs / 1000;
    world.rapier.step();
  },

  spawn(world, entityId, _entityType, at) {
    if (world.bodies.has(entityId)) return;
    const body = world.rapier.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(at.posX, at.posY)
        .setRotation(at.rot)
        .setLinvel(at.velX, at.velY)
        .lockRotations(),
    );
    world.rapier.createCollider(
      RAPIER.ColliderDesc.cuboid(world.halfExtent, world.halfExtent),
      body,
    );
    world.bodies.set(entityId, body.handle);
  },

  despawn(world, entityId) {
    const body = getBody(world, entityId);
    if (body) world.rapier.removeRigidBody(body);
    world.bodies.delete(entityId);
  },

  getEntity(world, entityId): EntityTransform | undefined {
    const body = getBody(world, entityId);
    if (!body) return undefined;
    const t = body.translation();
    const v = body.linvel();
    return { posX: t.x, posY: t.y, rot: body.rotation(), velX: v.x, velY: v.y };
  },

  setEntity(world, entityId, t) {
    const body = getBody(world, entityId);
    if (!body) return;
    body.setTranslation({ x: t.posX, y: t.posY }, true);
    body.setRotation(t.rot, true);
    body.setLinvel({ x: t.velX, y: t.velY }, true);
    body.setAngvel(0, true);
  },

  listEntities(world): SnapshotEntity[] {
    const out: SnapshotEntity[] = [];
    for (const [entityId, handle] of world.bodies) {
      const body = world.rapier.getRigidBody(handle);
      if (!body) continue;
      const t = body.translation();
      const v = body.linvel();
      out.push({
        entityId,
        entityType: BOX_ENTITY_TYPE,
        posX: t.x,
        posY: t.y,
        rot: body.rotation(),
        velX: v.x,
        velY: v.y,
      });
    }
    return out;
  },

  takeSnapshot(world): BoxSnapshot {
    return { bytes: world.rapier.takeSnapshot(), bodies: new Map(world.bodies) };
  },

  restoreSnapshot(world, snap) {
    // free() world cũ: mỗi correction tạo world WASM mới, không free là leak.
    world.rapier.free();
    world.rapier = RAPIER.World.restoreSnapshot(snap.bytes);
    world.bodies = new Map(snap.bodies);
  },
};
