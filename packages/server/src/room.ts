/**
 * `GameRoom` — lớp vỏ Colyseus quanh {@link RoomEngine}
 * ([docs/design/006-server-rooms.md] §1). Colyseus lo lifecycle + seat
 * reservation; toàn bộ game state nằm trong world của engine, schema sync
 * **không dùng** (bypass, `patchRate = null`), dữ liệu đi qua `sendBytes`.
 */
import { Room, type Client } from 'colyseus';
import { MessageType } from '@gm-net/core';
import { RoomEngine, type RoomEngineOptions } from './engine.js';
import { TickScheduler } from './tick.js';

export type GameRoomOptions = RoomEngineOptions;

export class GameRoom extends Room {
  private engine!: RoomEngine;
  private scheduler!: TickScheduler;

  onCreate(options: GameRoomOptions): void {
    this.patchRate = null; // tắt schema sync — không broadcast state Colyseus
    this.autoDispose = true;
    this.engine = new RoomEngine(options);

    // INPUT binary → jitter buffer.
    this.onMessageBytes(MessageType.Input, (client: Client, bytes: Uint8Array) => {
      try {
        this.engine.ingestInput(client.sessionId, bytes);
      } catch {
        // Byte rác từ client không tin cậy: bỏ, không sập room.
      }
    });

    // PING → PONG (clock sync).
    this.onMessageBytes(MessageType.Ping, (client: Client, bytes: Uint8Array) => {
      try {
        const ping = this.engine.decodePing(bytes);
        client.sendBytes(MessageType.Pong, this.engine.encodePong(ping.clientTime, Date.now()));
      } catch {
        // ping hỏng: bỏ qua.
      }
    });

    this.scheduler = new TickScheduler({
      stepMs: this.engine.stepMs,
      onTick: () => this.step(),
    });
    this.scheduler.start();
  }

  /** Một tick: mô phỏng rồi broadcast snapshot (ack riêng từng client). */
  private step(): void {
    this.engine.advance();
    for (const client of this.clients) {
      client.sendBytes(MessageType.Snapshot, this.engine.encodeSnapshotFor(client.sessionId));
    }
  }

  onJoin(client: Client): void {
    const { handshake } = this.engine.addClient(client.sessionId);
    client.send('handshake', handshake); // handshake JSON
    client.sendBytes(MessageType.Snapshot, this.engine.encodeSnapshotFor(client.sessionId)); // full snapshot đầu tiên
  }

  onLeave(client: Client): void {
    // M2: despawn ngay. Grace period + resync (allowReconnection) là M8.
    this.engine.removeClient(client.sessionId);
  }

  onDispose(): void {
    this.scheduler?.stop();
  }
}
