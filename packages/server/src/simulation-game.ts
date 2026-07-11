/**
 * Adapter M4: biến một {@link Simulation} (logic mô phỏng dùng chung trong
 * `@gm-net/shared`) thành {@link GameLogic} cho `RoomEngine`. Game chỉ còn phải
 * quyết hai việc server-only: tạo world từ `GameConfig` và spawn player ở đâu —
 * phần mô phỏng (applyInput/step/đọc entity/snapshot) đi thẳng qua simulation,
 * đảm bảo server chạy ĐÚNG code mà client dùng để prediction.
 */
import type { Simulation } from '@gm-net/shared';
import type { GameConfig, GameLogic, PlayerJoinContext } from './game.js';

export interface SimulationGameOptions<World> {
  /** Tạo world cho một room (game tự quyết tham số từ config). */
  createWorld(config: GameConfig): World;
  /** Spawn entity cho player mới, trả entityId (u16). Gọi `sim.spawn` bên trong. */
  spawnPlayer(world: World, ctx: PlayerJoinContext): number;
}

export function createSimulationGame<World, Input, Snap>(
  sim: Simulation<World, Input, Snap>,
  opts: SimulationGameOptions<World>,
): GameLogic<World, Input> {
  return {
    createWorld: (config) => opts.createWorld(config),
    onPlayerJoin: (world, ctx) => opts.spawnPlayer(world, ctx),
    onPlayerLeave: (world, entityId) => sim.despawn(world, entityId),
    applyInput: (world, entityId, input, tick) => sim.applyInput(world, entityId, input, tick),
    simulate: (world, stepMs, tick) => sim.step(world, stepMs, tick),
    readEntities: (world) => sim.listEntities(world),
    takeSnapshot: (world) => sim.takeSnapshot(world),
  };
}
