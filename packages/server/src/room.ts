/**
 * `GameRoom` — lớp vỏ Colyseus quanh {@link RoomEngine}
 * ([docs/design/006-server-rooms.md] §1). Colyseus lo lifecycle + seat
 * reservation; toàn bộ game state nằm trong world của engine, schema sync
 * **không dùng** (bypass, `patchRate = null`), dữ liệu đi qua `sendBytes`.
 */
import { CloseCode, Room, type Client } from 'colyseus';
import { MessageType } from '@gm-net/core';
import { RoomEngine, type RoomEngineOptions } from './engine.js';
import { TickMetrics, type RoomMetrics } from './metrics.js';
import { TickScheduler } from './tick.js';

export type GameRoomOptions = RoomEngineOptions;

export class GameRoom extends Room {
  private engine!: RoomEngine;
  private scheduler!: TickScheduler;
  /** Thời lượng tick gần đây ([004] §8, M11) — nguồn của p50/p99. */
  private readonly tickMetrics = new TickMetrics();
  private metricsAt = 0;
  private bytesAtWindowStart = 0;
  private metricsEveryTicks = 30;

  /** Metrics room hiện tại ([004] §8) — load test / export production đọc. */
  metrics(): RoomMetrics {
    const s = this.engine.snapshotStats();
    return {
      tick: this.engine.tick,
      clients: this.engine.clientCount,
      tickMs: { p50: this.tickMetrics.p50, p99: this.tickMetrics.p99, max: this.tickMetrics.max },
      bytesSent: s.bytesSent,
      bytesPerClientPerSecond: this.bandwidthPerClient(s.bytesSent),
      keyframes: s.keyframes,
      deltas: s.deltas,
    };
  }

  /** Băng thông state/client (B/s) trong cửa sổ metrics gần nhất. */
  private bandwidthPerClient(bytesSent: number): number {
    const clients = this.engine.clientCount;
    if (clients === 0 || this.metricsEveryTicks <= 0) return 0;
    const windowSec = (this.metricsEveryTicks * this.engine.stepMs) / 1000;
    return (bytesSent - this.bytesAtWindowStart) / clients / windowSec;
  }

  private engineOptions?: GameRoomOptions;

  onCreate(options: GameRoomOptions): void {
    this.patchRate = null; // tắt schema sync — không broadcast state Colyseus
    this.autoDispose = true;
    this.engineOptions = options;
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

    this.metricsEveryTicks = options.config.metricsEveryTicks ?? Math.round(options.config.tickRate);
    this.scheduler = new TickScheduler({
      stepMs: this.engine.stepMs,
      onTick: () => this.step(),
      // Lỗi từ game logic/encode không được giết tick loop hay sập process.
      onError: (err, tick) => {
        console.error(`GameRoom ${this.roomId}: lỗi trong tick ${tick}`, err);
      },
    });
    this.scheduler.start();
  }

  /**
   * Một tick: mô phỏng rồi gửi state cho từng client — DELTA so với baseline
   * client đã ack, hoặc SNAPSHOT (keyframe) khi chưa có baseline dùng được
   * ([005] §4). Engine quyết định; room chỉ gửi đúng kênh.
   */
  private step(): void {
    const started = performance.now();
    this.engine.advance();
    for (const client of this.clients) {
      // Colyseus đưa client vào this.clients trước khi onJoin chạy — nếu tick
      // chen giữa (tùy version có await xen kẽ), client chưa có record trong
      // engine: bỏ qua, snapshot đầu tiên sẽ gửi trong onJoin.
      if (!this.engine.hasClient(client.sessionId)) continue;
      // Đang trong grace period (rớt mạng): socket chết, đừng encode/gửi phí —
      // state sẽ đi bằng keyframe ngay khi nó quay lại ([006] §5).
      if (!this.engine.isConnected(client.sessionId)) continue;
      const state = this.engine.encodeSnapshotFor(client.sessionId);
      client.sendBytes(state.type, state.bytes);
    }
    // Đo TRỌN một tick: mô phỏng + encode + gửi. Đo mỗi phần riêng thì bỏ sót
    // chính cái đắt nhất khi đông người — encode/gửi nhân theo số client.
    this.tickMetrics.record(performance.now() - started);

    const opts = this.engineOptions;
    if (this.metricsEveryTicks > 0 && this.engine.tick - this.metricsAt >= this.metricsEveryTicks) {
      opts?.config.onMetrics?.(this.metrics());
      this.metricsAt = this.engine.tick;
      this.bytesAtWindowStart = this.engine.snapshotStats().bytesSent;
    }
  }

  onJoin(client: Client): void {
    const { handshake } = this.engine.addClient(client.sessionId);
    client.send('handshake', handshake); // handshake JSON
    // Chưa ack gì → engine trả keyframe (full snapshot đầu tiên).
    const state = this.engine.encodeSnapshotFor(client.sessionId);
    client.sendBytes(state.type, state.bytes);
  }

  /**
   * Chủ động rời room ([006] §5): despawn ngay, giải phóng seat.
   *
   * Colyseus 0.17 truyền **close code**, KHÔNG phải boolean `consented` như docs
   * đời cũ gợi ý (1006 = đứt mạng, 4000 = `CloseCode.CONSENTED`, 4001 = server
   * shutdown). Rớt mạng đi vào {@link onDrop}; `onLeave` vẫn tự phòng thân bằng
   * chính phép kiểm tra đó phòng khi runtime không có `onDrop`.
   */
  async onLeave(client: Client, code?: number): Promise<void> {
    await this.handleLeave(client, code);
  }

  /**
   * Client rớt mạng (không chủ động thoát) — hook riêng của Colyseus 0.17.
   * Giữ session + entity suốt grace period; quay lại kịp thì resync (handshake +
   * keyframe), quá hạn thì despawn thật ([006] §5, M8).
   */
  async onDrop(client: Client, code?: number): Promise<void> {
    await this.handleLeave(client, code);
  }

  /** Ý định thoát thật sự (không phải rớt mạng) → không giữ seat. */
  private isConsented(code?: number): boolean {
    return code === CloseCode.CONSENTED || code === CloseCode.SERVER_SHUTDOWN;
  }

  private async handleLeave(client: Client, code?: number): Promise<void> {
    const grace = this.engine.reconnectGraceSeconds;
    if (this.isConsented(code) || grace <= 0) {
      this.engine.removeClient(client.sessionId);
      return;
    }

    this.engine.disconnectClient(client.sessionId);
    try {
      await this.allowReconnection(client, grace);
    } catch {
      // Hết grace (hoặc room dispose): despawn thật, giải phóng seat.
      this.engine.removeClient(client.sessionId);
      return;
    }

    // Quay lại kịp: coi như join lại về mặt dữ liệu ([006] §5).
    const handshake = this.engine.reconnectClient(client.sessionId);
    if (!handshake) return; // session đã bị dọn (room dispose) — không còn gì để resync
    client.send('handshake', handshake);
    const state = this.engine.encodeSnapshotFor(client.sessionId); // baseline đã reset → keyframe
    client.sendBytes(state.type, state.bytes);
  }

  onDispose(): void {
    this.scheduler?.stop();
  }
}
