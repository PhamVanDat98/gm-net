/**
 * Box-sim (M4): demo game implement interface `Simulation`. Kiểm chứng các
 * tính chất mà prediction/reconciliation phía client dựa vào.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics2D } from '@gm-net/physics-2d';
import {
  BOX_ENTITY_TYPE,
  boxInputCodec,
  boxSim,
  canonicalBoxInput,
  createBoxWorld,
  type BoxWorld,
} from '../src/box-sim.js';
import { BitReader, BitWriter } from '@gm-net/core';

const STEP_MS = 1000 / 30;
const bounds = { minX: -50, maxX: 50, minY: -50, maxY: 50 };
const AT_REST = { posX: 0, posY: 0, rot: 0, velX: 0, velY: 0 };

function makeWorld(): BoxWorld {
  return createBoxWorld({ bounds });
}

beforeAll(async () => {
  await initPhysics2D();
});

describe('box-sim (Simulation demo)', () => {
  it('spawn/getEntity/setEntity/despawn/listEntities', () => {
    const w = makeWorld();
    boxSim.spawn(w, 1, BOX_ENTITY_TYPE, { ...AT_REST, posX: 3, posY: -2 });
    boxSim.spawn(w, 2, BOX_ENTITY_TYPE, { ...AT_REST, posX: -5, posY: 5 });

    const e1 = boxSim.getEntity(w, 1)!;
    expect(e1.posX).toBe(3);
    expect(e1.posY).toBe(-2);

    boxSim.setEntity(w, 1, { posX: 1, posY: 2, rot: 0, velX: 4, velY: -4 });
    const moved = boxSim.getEntity(w, 1)!;
    expect(moved.posX).toBe(1);
    expect(moved.velX).toBe(4);

    expect(boxSim.listEntities(w).map((e) => e.entityId).sort()).toEqual([1, 2]);

    boxSim.despawn(w, 2);
    expect(boxSim.getEntity(w, 2)).toBeUndefined();
    expect(boxSim.listEntities(w)).toHaveLength(1);
    boxSim.despawn(w, 2); // no-op, không ném
  });

  it('applyInput đặt velocity theo moveSpeed, step tích phân theo dt cố định', () => {
    const w = makeWorld();
    boxSim.spawn(w, 1, BOX_ENTITY_TYPE, AT_REST);
    boxSim.applyInput(w, 1, { moveX: 1, moveY: 0 }, 0);
    boxSim.step(w, STEP_MS, 0);
    const e = boxSim.getEntity(w, 1)!;
    expect(e.velX).toBeCloseTo(10, 6); // moveSpeed mặc định 10
    expect(e.posX).toBeCloseTo(10 * (STEP_MS / 1000), 6);
    expect(e.rot).toBe(0); // lockRotations
  });

  it('restore + replay cùng chuỗi input → state identical bit-perfect', () => {
    const w = makeWorld();
    boxSim.spawn(w, 1, BOX_ENTITY_TYPE, AT_REST);
    boxSim.spawn(w, 2, BOX_ENTITY_TYPE, { ...AT_REST, posX: 2 }); // sát nhau → sẽ va chạm

    const inputs = Array.from({ length: 40 }, (_, i) =>
      canonicalBoxInput(Math.sin(i * 0.3), Math.cos(i * 0.7)),
    );
    // Chạy 10 tick, chụp snapshot, chạy tiếp 30 tick
    for (let t = 0; t < 10; t++) {
      boxSim.applyInput(w, 1, inputs[t], t);
      boxSim.step(w, STEP_MS, t);
    }
    const snap = boxSim.takeSnapshot(w);
    for (let t = 10; t < 40; t++) {
      boxSim.applyInput(w, 1, inputs[t], t);
      boxSim.step(w, STEP_MS, t);
    }
    const final1 = boxSim.getEntity(w, 1)!;
    const final2 = boxSim.getEntity(w, 2)!;

    // Restore về tick 10 rồi replay đúng chuỗi input còn lại
    boxSim.restoreSnapshot(w, snap);
    for (let t = 10; t < 40; t++) {
      boxSim.applyInput(w, 1, inputs[t], t);
      boxSim.step(w, STEP_MS, t);
    }
    expect(boxSim.getEntity(w, 1)).toEqual(final1);
    expect(boxSim.getEntity(w, 2)).toEqual(final2);
  });

  it('tường biên chặn box không xuyên ra ngoài', () => {
    const w = makeWorld();
    boxSim.spawn(w, 1, BOX_ENTITY_TYPE, { ...AT_REST, posX: 49 });
    for (let t = 0; t < 60; t++) {
      boxSim.applyInput(w, 1, { moveX: 1, moveY: 0 }, t);
      boxSim.step(w, STEP_MS, t);
    }
    const e = boxSim.getEntity(w, 1)!;
    expect(e.posX).toBeLessThanOrEqual(bounds.maxX);
  });

  it('canonicalBoxInput round-trip qua codec giữ nguyên giá trị', () => {
    const raw = { moveX: 0.70710678, moveY: -0.33333333 };
    const canonical = canonicalBoxInput(raw.moveX, raw.moveY);
    const w = new BitWriter(8);
    boxInputCodec.encode(w, canonical);
    const decoded = boxInputCodec.decode(new BitReader(w.toUint8Array()));
    expect(decoded).toEqual(canonical);
    // clamp ngoài dải
    expect(canonicalBoxInput(2, -3)).toEqual({ moveX: 1, moveY: -1 });
  });
});
