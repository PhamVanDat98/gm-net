/**
 * Spike tuần đầu (BRAINSTORM.md §6.2): verify takeSnapshot/restoreSnapshot
 * của Rapier cho kết quả replay identical — nền tảng của server
 * reconciliation (restore + replay input).
 */
import { describe, expect, it } from 'vitest';
import { initPhysics2D } from '../src/index.js';

describe('Rapier2D snapshot/restore (spike)', () => {
  it('restore + replay cùng số bước cho state identical bit-perfect', async () => {
    const RAPIER = await initPhysics2D();
    const world = new RAPIER.World({ x: 0, y: -9.81 });

    // Sàn + một chồng bóng động để có va chạm thực sự
    world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.5));
    const bodies = [];
    for (let i = 0; i < 10; i++) {
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(i * 0.1, 2 + i),
      );
      world.createCollider(RAPIER.ColliderDesc.ball(0.5), body);
      bodies.push(body);
    }

    // Chạy tới trạng thái giữa chừng (có contact, warm-start solver)
    for (let i = 0; i < 30; i++) world.step();

    const snapshot = world.takeSnapshot();

    // Nhánh A: world gốc chạy tiếp 60 bước
    for (let i = 0; i < 60; i++) world.step();

    // Nhánh B: restore từ snapshot rồi chạy đúng 60 bước
    const restored = RAPIER.World.restoreSnapshot(snapshot);
    for (let i = 0; i < 60; i++) restored.step();

    for (const body of bodies) {
      const other = restored.getRigidBody(body.handle);
      expect(other).toBeDefined();
      expect(other.translation().x).toBe(body.translation().x);
      expect(other.translation().y).toBe(body.translation().y);
      expect(other.rotation()).toBe(body.rotation());
      expect(other.linvel().x).toBe(body.linvel().x);
      expect(other.linvel().y).toBe(body.linvel().y);
    }
  });
});
