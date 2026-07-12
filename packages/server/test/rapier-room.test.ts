/**
 * M4 task 4.2: RoomEngine chạy Rapier world qua `createSimulationGame` + ring
 * history snapshot 30 slot. Thay "echo simulation" của M2 bằng physics thật.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics2D } from '@gm-net/physics-2d';
import {
  BOX_ENTITY_TYPE,
  boxInputCodec,
  boxSim,
  canonicalBoxInput,
  createBoxWorld,
  type BoxInput,
  type BoxSnapshot,
  type BoxWorld,
} from '@gm-net/shared/box-sim';
import { ProtocolCodec } from '@gm-net/core';
import { RoomEngine, createSimulationGame, type GameConfig } from '../src/index.js';

const config: GameConfig = {
  tickRate: 30,
  worldBounds: { minX: -50, maxX: 50, minY: -50, maxY: 50 },
  vMax: 20,
};

function makeEngine(): RoomEngine<BoxWorld, BoxInput> {
  let nextEntityId = 1;
  const game = createSimulationGame(boxSim, {
    createWorld: (cfg) => createBoxWorld({ bounds: cfg.worldBounds }),
    spawnPlayer: (world) => {
      const entityId = nextEntityId++;
      // Tách chỗ spawn để các box không đè lên nhau (solver sẽ đẩy nhau ra).
      boxSim.spawn(world, entityId, BOX_ENTITY_TYPE, {
        posX: 0, posY: (entityId - 1) * 5, rot: 0, velX: 0, velY: 0,
      });
      return entityId;
    },
  });
  return new RoomEngine({ game, config, inputCodec: boxInputCodec });
}

function clientCodec(): ProtocolCodec<BoxInput> {
  return new ProtocolCodec<BoxInput>({
    quantization: { world: config.worldBounds, vMax: config.vMax },
    inputCodec: boxInputCodec,
  });
}

beforeAll(async () => {
  await initPhysics2D();
});

describe('RoomEngine + Rapier (M4)', () => {
  it('input di chuyển box qua physics, hai client thấy nhau trong snapshot', () => {
    const engine = makeEngine();
    const codec = clientCodec();
    const a = engine.addClient('a');
    const b = engine.addClient('b');
    expect(a.entityId).not.toBe(b.entityId);

    // Client a gửi input "đi phải" nhắm tick 0..9
    const move = canonicalBoxInput(1, 0);
    for (let t = 0; t < 10; t++) {
      engine.ingestInput(
        'a',
        codec.encodeInput({ ackTick: 0, latestSeq: t + 1, inputs: [{ tick: t, payload: move }] }),
      );
      engine.advance();
    }

    const snap = codec.decodeSnapshot(engine.encodeSnapshotFor('b').bytes);
    expect(snap.serverTick).toBe(10);
    expect(snap.entities).toHaveLength(2);
    const boxA = snap.entities.find((e) => e.entityId === a.entityId)!;
    const boxB = snap.entities.find((e) => e.entityId === b.entityId)!;
    // 10 tick × 10 m/s × (1/30)s ≈ 3.33m (sai số quantize nhỏ)
    expect(boxA.posX).toBeCloseTo(10 * 10 * (1 / 30), 1);
    expect(boxB.posX).toBeCloseTo(0, 1);
    // Ack riêng từng client: b chưa gửi gì
    expect(snap.lastProcessedSeq).toBe(0);
    expect(codec.decodeSnapshot(engine.encodeSnapshotFor('a').bytes).lastProcessedSeq).toBe(10);
  });

  it('ring history: snapshotAt(tick) restore được đúng state quá khứ', () => {
    const engine = makeEngine();
    engine.addClient('a');
    const world = engine.worldState;

    const positions: number[] = [];
    const codec = clientCodec();
    const move = canonicalBoxInput(0, 1);
    for (let t = 0; t < 20; t++) {
      engine.ingestInput(
        'a',
        codec.encodeInput({ ackTick: 0, latestSeq: t + 1, inputs: [{ tick: t, payload: move }] }),
      );
      engine.advance();
      positions.push(boxSim.getEntity(world, 1)!.posY);
    }

    // Restore snapshot tick 12 vào một world riêng → posY khớp bit-perfect
    const snap = engine.snapshotAt(12) as BoxSnapshot;
    expect(snap).toBeDefined();
    const probe = createBoxWorld({ bounds: config.worldBounds });
    boxSim.restoreSnapshot(probe, snap);
    expect(boxSim.getEntity(probe, 1)!.posY).toBe(positions[11]); // state SAU tick 11 = tick 12

    // Ring 30 slot: tick quá cũ rơi khỏi ring
    for (let t = 20; t < 60; t++) engine.advance();
    expect(engine.snapshotAt(12)).toBeUndefined();
    expect(engine.snapshotAt(60)).toBeDefined();
  });
});
