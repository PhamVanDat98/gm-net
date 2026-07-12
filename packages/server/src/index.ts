/**
 * @gm-net/server — room framework trên Colyseus (room lifecycle + seat
 * reservation, bypass schema sync — snapshot binary qua sendBytes), fixed-tick
 * loop drift-corrected, jitter buffer input.
 *
 * Phase 1 (M2): tick loop + input buffer + snapshot broadcast (echo simulation).
 */
import { Server, type ServerOptions, WebSocketTransport } from 'colyseus';
import { GameRoom } from './room.js';
import type { RoomEngineOptions } from './engine.js';

export interface CreateGameServerOptions<World = unknown, Input = unknown>
  extends RoomEngineOptions<World, Input> {
  /** Tên room cho matchmaking (mặc định "game"). */
  roomName?: string;
  /**
   * Transport Colyseus. Mặc định `WebSocketTransport` (chạy mọi nơi, kể cả
   * Windows/CI). Production nên truyền `uWebSocketsTransport`
   * (`@colyseus/uwebsockets-transport`) — nhanh hơn; đây là điểm thoát đã lường
   * trong [docs/design/006-server-rooms.md] (bảng rủi ro uWS).
   */
  transport?: ServerOptions['transport'];
  /** Tùy chọn Server khác (presence, driver…). */
  serverOptions?: Omit<ServerOptions, 'transport'>;
}

/**
 * Dựng một `colyseus.Server` với một loại `GameRoom` đã cấu hình sẵn game logic.
 * Gọi `.listen(port)` để chạy.
 */
export function createGameServer<World = unknown, Input = unknown>(
  opts: CreateGameServerOptions<World, Input>,
): Server {
  const { roomName = 'game', transport, serverOptions, ...roomOptions } = opts;
  const server = new Server({
    transport: transport ?? new WebSocketTransport(),
    ...serverOptions,
  });
  server.define(roomName, GameRoom, roomOptions);
  return server;
}

export { GameRoom, type GameRoomOptions } from './room.js';
export {
  RoomEngine,
  type RoomEngineOptions,
  type EncodedState,
  type SnapshotStats,
} from './engine.js';
export { seqGreater } from '@gm-net/core'; // re-export cho tương thích (chuyển về core ở M3)
export {
  InputBuffer,
  type InputBufferOptions,
  type InputBufferStats,
  type TakeResult,
} from './input-buffer.js';
export { TickScheduler, nextTickDelay, type TickSchedulerOptions } from './tick.js';
export { createSimulationGame, type SimulationGameOptions } from './simulation-game.js';
export type {
  GameLogic,
  GameConfig,
  GameCodecs,
  Handshake,
  PlayerJoinContext,
} from './game.js';
