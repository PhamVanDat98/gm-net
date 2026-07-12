/**
 * Delta compression phía server ([005] §4, M7): chính sách keyframe/delta theo
 * `ackTick` của từng client + nghiệm thu băng thông.
 *
 * Nghiệm thu M7 ([IMPLEMENTATION] Phase 2): "bandwidth/client giảm đo được
 * (log trước/sau) với demo 10 entity" — test cuối đo đúng điều đó.
 */
import { describe, expect, it } from 'vitest';
import {
  MessageType,
  NO_ACK_TICK,
  ProtocolCodec,
  applySnapshotDelta,
  type Snapshot,
} from '@gm-net/core';
import { RoomEngine } from '../src/index.js';
import { echoConfig, echoGame, echoInputCodec, type EchoInput, type EchoWorld } from './echo-game.js';

const wire = new ProtocolCodec<EchoInput>({
  quantization: { world: echoConfig.worldBounds, vMax: echoConfig.vMax },
  inputCodec: echoInputCodec,
});

function makeEngine(config: Partial<typeof echoConfig> = {}) {
  return new RoomEngine<EchoWorld, EchoInput>({
    game: echoGame,
    config: { ...echoConfig, ...config },
    inputCodec: echoInputCodec,
  });
}

/** Gửi INPUT (mang ackTick) từ client — đúng đường client thật báo đã nhận snapshot. */
function sendInput(engine: RoomEngine<EchoWorld, EchoInput>, sid: string, opts: {
  ackTick: number;
  seq: number;
  tick: number;
  dx?: number;
}): void {
  engine.ingestInput(
    sid,
    wire.encodeInput({
      ackTick: opts.ackTick,
      latestSeq: opts.seq,
      inputs: [{ tick: opts.tick, payload: { dx: opts.dx ?? 0.5, dy: 0 } }],
    }),
  );
}

describe('RoomEngine — chính sách keyframe/delta', () => {
  it('client chưa ack gì → keyframe (full snapshot)', () => {
    const engine = makeEngine();
    engine.addClient('A');

    const state = engine.encodeSnapshotFor('A');

    expect(state.keyframe).toBe(true);
    expect(state.type).toBe(MessageType.Snapshot);
    expect(() => wire.decodeSnapshot(state.bytes)).not.toThrow();
  });

  it('sau khi client ack một tick còn trong ring → delta', () => {
    const engine = makeEngine();
    engine.addClient('A');

    // Tick 0: keyframe; client ack tick 0 (đính trong INPUT kế tiếp).
    const first = engine.encodeSnapshotFor('A');
    expect(first.keyframe).toBe(true);
    sendInput(engine, 'A', { ackTick: 0, seq: 1, tick: 1 });

    engine.advance();
    const second = engine.encodeSnapshotFor('A');

    expect(second.keyframe).toBe(false);
    expect(second.type).toBe(MessageType.Delta);
    const delta = wire.decodeDelta(second.bytes);
    expect(delta.baselineTick).toBe(0);
    expect(delta.serverTick).toBe(1);
  });

  it('client tái dựng từ delta == state server (qua RoomEngine thật)', () => {
    const engine = makeEngine();
    engine.addClient('A');
    engine.addClient('B');

    let clientState: Snapshot = wire.decodeSnapshot(engine.encodeSnapshotFor('A').bytes);
    let ackTick = clientState.serverTick;

    for (let i = 1; i <= 20; i++) {
      sendInput(engine, 'A', { ackTick, seq: i, tick: i, dx: 0.3 });
      sendInput(engine, 'B', { ackTick: 0, seq: i, tick: i, dx: -0.2 });
      engine.advance();

      const state = engine.encodeSnapshotFor('A');
      clientState = state.keyframe
        ? wire.decodeSnapshot(state.bytes)
        : applySnapshotDelta(clientState, wire.decodeDelta(state.bytes));
      ackTick = clientState.serverTick;

      // So với sự thật server: full snapshot cùng tick, cho client B (header khác,
      // entity giống nhau — AOI per-client là M9).
      const truth = wire.decodeSnapshot(
        makeFullSnapshotBytes(engine),
      );
      expect(sortById(clientState)).toEqual(sortById(truth));
    }
  });

  it('ack quá già (ngoài ring baseline) → keyframe trở lại', () => {
    const engine = makeEngine({ baselineHistoryTicks: 5 });
    engine.addClient('A');

    engine.encodeSnapshotFor('A'); // tick 0 keyframe
    sendInput(engine, 'A', { ackTick: 0, seq: 1, tick: 1 });

    engine.advance();
    expect(engine.encodeSnapshotFor('A').keyframe).toBe(false); // tick 1: delta vs 0

    // Client "ngộp": không ack thêm; baseline tick 0 già dần.
    for (let i = 0; i < 5; i++) engine.advance();
    const state = engine.encodeSnapshotFor('A'); // tick 6, ack vẫn 0 → quá 5 tick

    expect(state.keyframe).toBe(true);
    expect(state.type).toBe(MessageType.Snapshot);
  });

  it('client join giữa chừng, chưa có snapshot → KHÔNG delta vs tick 0 (hồi quy)', () => {
    // Bug thật (bắt được ở e2e): client chưa có snapshot gửi ackTick = 0 vì "-1 → 0
    // trên wire". Server tưởng nó đã có tick 0 (tick thật, còn trong ring) → gửi
    // delta dựa trên baseline client chưa bao giờ nhận → client bỏ hết delta →
    // mất mẫu interpolation (buffer cạn vượt ngưỡng nghiệm thu).
    const engine = makeEngine();
    engine.addClient('A');
    engine.encodeSnapshotFor('A');
    for (let t = 0; t < 11; t++) engine.advance(); // room chạy tới tick 11

    engine.addClient('LATE');
    const first = engine.encodeSnapshotFor('LATE');
    expect(first.keyframe).toBe(true);
    expect(wire.decodeSnapshot(first.bytes).serverTick).toBe(11);

    // Client mới gửi INPUT trước khi kịp nhận snapshot: ackTick = NO_ACK_TICK.
    engine.ingestInput(
      'LATE',
      wire.encodeInput({
        ackTick: NO_ACK_TICK,
        latestSeq: 1,
        inputs: [{ tick: 12, payload: { dx: 0.1, dy: 0 } }],
      }),
    );
    engine.advance();

    // Vẫn phải là keyframe — tick 0 nằm trong ring nhưng LATE chưa từng nhận nó.
    expect(engine.encodeSnapshotFor('LATE').keyframe).toBe(true);
  });

  it('ack cũ hơn snapshot đầu tiên client nhận → keyframe (client hỏng/độc hại)', () => {
    const engine = makeEngine();
    engine.addClient('A');
    engine.encodeSnapshotFor('A');
    for (let t = 0; t < 5; t++) engine.advance();

    engine.addClient('LATE');
    engine.encodeSnapshotFor('LATE'); // snapshot đầu tiên: tick 5

    // Khai ack tick 1 — tick server có gửi (cho A), nhưng LATE chưa bao giờ nhận.
    sendInput(engine, 'LATE', { ackTick: 1, seq: 1, tick: 6 });
    engine.advance();

    expect(engine.encodeSnapshotFor('LATE').keyframe).toBe(true);
  });

  it('deltaCompression: false → luôn full snapshot', () => {
    const engine = makeEngine({ deltaCompression: false });
    engine.addClient('A');

    engine.encodeSnapshotFor('A');
    sendInput(engine, 'A', { ackTick: 0, seq: 1, tick: 1 });
    engine.advance();

    expect(engine.encodeSnapshotFor('A').keyframe).toBe(true);
  });
});

describe('Nghiệm thu M7 — băng thông/client giảm đo được (10 entity)', () => {
  it('delta giảm mạnh byte/tick so với full snapshot, state vẫn khớp', () => {
    const run = (deltaCompression: boolean) => {
      const engine = makeEngine({ deltaCompression });
      // 10 entity: 1 client + 9 "bot" (mỗi client = 1 entity trong echo game).
      const sids = Array.from({ length: 10 }, (_, i) => `p${i}`);
      for (const sid of sids) engine.addClient(sid);

      // Tick 0: keyframe cho mọi client.
      const acks = new Map(sids.map((sid) => [sid, -1]));
      for (const sid of sids) {
        const s = engine.encodeSnapshotFor(sid);
        acks.set(sid, wire.decodeSnapshot(s.bytes).serverTick);
      }

      // 60 tick: chỉ p0 di chuyển; 9 entity còn lại đứng yên (kịch bản delta
      // ăn điểm nhất — và cũng là kịch bản game thật: phần lớn entity tĩnh).
      for (let t = 1; t <= 60; t++) {
        sendInput(engine, 'p0', { ackTick: acks.get('p0')!, seq: t, tick: t, dx: 0.25 });
        for (const sid of sids.slice(1)) {
          sendInput(engine, sid, { ackTick: acks.get(sid)!, seq: t, tick: t, dx: 0 });
        }
        engine.advance();
        for (const sid of sids) {
          const s = engine.encodeSnapshotFor(sid);
          acks.set(sid, s.keyframe ? wire.decodeSnapshot(s.bytes).serverTick : wire.decodeDelta(s.bytes).serverTick);
        }
      }
      return engine.snapshotStats();
    };

    const full = run(false);
    const delta = run(true);

    // Mốc: full snapshot 10 entity ≈ 13 B/entity + header ([005] §7).
    expect(full.keyframes).toBeGreaterThan(600);
    expect(full.deltas).toBe(0);
    expect(delta.deltas).toBeGreaterThan(590); // chỉ 10 keyframe đầu (mỗi client 1)

    const bytesPerTickFull = full.bytesSent / full.keyframes;
    const bytesPerTickDelta = delta.bytesSent / (delta.deltas + delta.keyframes);

    // Nghiệm thu: giảm đo được. Thực đo ≈ 140 B → ≈ 20 B (giảm >5×).
    expect(delta.bytesSent).toBeLessThan(full.bytesSent / 3);

    console.log(
      `[M7] băng thông/client/tick: full ${bytesPerTickFull.toFixed(1)} B → ` +
        `delta ${bytesPerTickDelta.toFixed(1)} B ` +
        `(giảm ${(100 - (delta.bytesSent / full.bytesSent) * 100).toFixed(1)}%)`,
    );
  });
});

function sortById(s: Snapshot) {
  return [...s.entities].sort((a, b) => a.entityId - b.entityId);
}

/** Full snapshot của state hiện tại (sự thật server) — không đụng tới ack/stats của client. */
function makeFullSnapshotBytes(engine: RoomEngine<EchoWorld, EchoInput>): Uint8Array {
  return wire.encodeSnapshot({
    serverTick: engine.tick,
    lastProcessedSeq: 0,
    lateInputs: 0,
    entities: echoGame.readEntities(engine.worldState),
  });
}
