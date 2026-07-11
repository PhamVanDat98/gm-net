/**
 * Game "echo" cho nghiệm thu M2 ([006] §2): state = vị trí cộng dồn từ input,
 * chưa physics. Dùng chung cho các test engine/room.
 */
import type { BitReader, BitWriter, CustomCodec, SnapshotEntity } from '@gm-net/core';
import type { GameConfig, GameLogic, PlayerJoinContext } from '../src/index.js';

export interface EchoInput {
  dx: number;
  dy: number;
}

interface EchoEntity {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
}

export interface EchoWorld {
  entities: Map<number, EchoEntity>;
  nextEntityId: number;
}

/** Codec input: dx, dy dạng i16 (×1000). */
export const echoInputCodec: CustomCodec<EchoInput> = {
  encode(w: BitWriter, s: EchoInput): void {
    w.writeI16(Math.round(s.dx * 1000));
    w.writeI16(Math.round(s.dy * 1000));
  },
  decode(r: BitReader): EchoInput {
    return { dx: r.readI16() / 1000, dy: r.readI16() / 1000 };
  },
};

export const echoGame: GameLogic<EchoWorld, EchoInput> = {
  createWorld(): EchoWorld {
    return { entities: new Map(), nextEntityId: 1 };
  },
  onPlayerJoin(world: EchoWorld, _ctx: PlayerJoinContext): number {
    const entityId = world.nextEntityId++;
    world.entities.set(entityId, { x: 0, y: 0, vx: 0, vy: 0, rot: 0 });
    return entityId;
  },
  onPlayerLeave(world: EchoWorld, entityId: number): void {
    world.entities.delete(entityId);
  },
  applyInput(world: EchoWorld, entityId: number, input: EchoInput): void {
    const e = world.entities.get(entityId);
    if (!e) return;
    // Echo: cộng dồn vị trí, lưu velocity đã áp cho snapshot.
    e.x += input.dx;
    e.y += input.dy;
    e.vx = input.dx;
    e.vy = input.dy;
  },
  simulate(): void {
    // Echo không physics: no-op.
  },
  readEntities(world: EchoWorld): SnapshotEntity[] {
    const out: SnapshotEntity[] = [];
    for (const [entityId, e] of world.entities) {
      out.push({ entityId, entityType: 0, posX: e.x, posY: e.y, rot: e.rot, velX: e.vx, velY: e.vy });
    }
    return out;
  },
};

export const echoConfig: GameConfig = {
  tickRate: 30,
  worldBounds: { minX: -100, maxX: 100, minY: -100, maxY: 100 },
  vMax: 50,
};
