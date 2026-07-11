/**
 * Server demo-2d (IMPLEMENTATION 5.4): một room box-sim Rapier trên
 * `createGameServer` — chạy ĐÚNG code mô phỏng mà client dùng để prediction.
 *
 *   pnpm --filter demo-2d server          # ws://localhost:2567
 *   pnpm --filter demo-2d proxy           # ws://localhost:2568 → 2567, RTT +200ms, drop 5%
 */
import { initPhysics2D } from '@gm-net/physics-2d';
import { createGameServer, createSimulationGame } from '@gm-net/server';
import { BOX_ENTITY_TYPE, boxInputCodec, boxSim, createBoxWorld, type BoxWorld } from '@gm-net/shared/box-sim';
import { DEMO_BOUNDS, DEMO_PORT, DEMO_VMAX, MOVE_SPEED, SPAWN_POINTS } from './game.js';

await initPhysics2D();

/** entityId kế tiếp per world (mỗi room một world). */
const nextIds = new WeakMap<BoxWorld, number>();

const game = createSimulationGame(boxSim, {
  createWorld: (cfg) => createBoxWorld({ bounds: cfg.worldBounds, moveSpeed: MOVE_SPEED }),
  spawnPlayer: (world) => {
    const entityId = nextIds.get(world) ?? 1;
    nextIds.set(world, entityId + 1);
    const p = SPAWN_POINTS[(entityId - 1) % SPAWN_POINTS.length];
    boxSim.spawn(world, entityId, BOX_ENTITY_TYPE, { posX: p.x, posY: p.y, rot: 0, velX: 0, velY: 0 });
    return entityId;
  },
});

const port = Number(process.env.PORT ?? DEMO_PORT);
const server = createGameServer({
  game,
  config: { tickRate: 30, worldBounds: DEMO_BOUNDS, vMax: DEMO_VMAX },
  inputCodec: boxInputCodec,
});
await server.listen(port);
console.log(`[demo-2d] server sẵn sàng: ws://localhost:${port} (room "game")`);
