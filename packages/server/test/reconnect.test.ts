/**
 * Reconnection + resync phía engine ([006] §5, M8).
 *
 * `GameRoom.onLeave` (Colyseus `allowReconnection`) chỉ là lớp vỏ; toàn bộ ngữ
 * nghĩa nằm ở `RoomEngine`: rớt → giữ entity trong grace; quay lại → keyframe +
 * jitter buffer mới; quá grace → despawn thật.
 */
import { describe, expect, it, vi } from 'vitest';
import { ProtocolCodec } from '@gm-net/core';
import { RoomEngine } from '../src/index.js';
import { echoConfig, echoGame, echoInputCodec, type EchoInput, type EchoWorld } from './echo-game.js';

const wire = new ProtocolCodec<EchoInput>({
  quantization: { world: echoConfig.worldBounds, vMax: echoConfig.vMax },
  inputCodec: echoInputCodec,
});

function makeEngine(game = echoGame) {
  return new RoomEngine<EchoWorld, EchoInput>({
    game,
    config: echoConfig,
    inputCodec: echoInputCodec,
  });
}

function move(engine: RoomEngine<EchoWorld, EchoInput>, sid: string, seq: number, tick: number, dx: number) {
  engine.ingestInput(
    sid,
    wire.encodeInput({ ackTick: 0, latestSeq: seq, inputs: [{ tick, payload: { dx, dy: 0 } }] }),
  );
}

describe('RoomEngine — reconnect ([006] §5)', () => {
  it('rớt mạng: entity ở lại world, hook onPlayerDisconnected chạy', () => {
    const onPlayerDisconnected = vi.fn();
    const engine = makeEngine({ ...echoGame, onPlayerDisconnected });
    engine.addClient('A');
    engine.addClient('B');
    move(engine, 'A', 1, 0, 0.5);
    engine.advance();

    engine.disconnectClient('A');

    expect(onPlayerDisconnected).toHaveBeenCalledWith(engine.worldState, 1);
    expect(engine.isConnected('A')).toBe(false);
    expect(engine.hasClient('A')).toBe(true);
    // Entity A vẫn trong snapshot mà B nhận được (world giữ nguyên).
    const snap = wire.decodeSnapshot(engine.encodeSnapshotFor('B').bytes);
    expect(snap.entities.map((e) => e.entityId)).toContain(1);
    expect(snap.entities.find((e) => e.entityId === 1)?.posX).toBeCloseTo(0.5, 2);
  });

  it('quay lại trong grace: cùng entityId, state kế tiếp là KEYFRAME', () => {
    const onPlayerReconnected = vi.fn();
    const engine = makeEngine({ ...echoGame, onPlayerReconnected });
    engine.addClient('A');

    engine.encodeSnapshotFor('A'); // keyframe đầu
    move(engine, 'A', 1, 0, 0.5); // ack tick 0 → baseline có
    engine.advance();
    expect(engine.encodeSnapshotFor('A').keyframe).toBe(false); // đang chạy delta

    engine.disconnectClient('A');
    for (let i = 0; i < 5; i++) engine.advance(); // world chạy tiếp lúc A mất mạng

    const handshake = engine.reconnectClient('A');

    expect(handshake?.entityId).toBe(1); // entity giữ nguyên
    expect(onPlayerReconnected).toHaveBeenCalledWith(engine.worldState, 1);
    expect(engine.isConnected('A')).toBe(true);

    // Baseline cũ vô nghĩa (client đã vứt ring) → phải là full snapshot.
    const state = engine.encodeSnapshotFor('A');
    expect(state.keyframe).toBe(true);
    expect(wire.decodeSnapshot(state.bytes).serverTick).toBe(engine.tick);
  });

  it('quay lại: jitter buffer mới — input seq bắt lại từ đầu vẫn được áp', () => {
    const engine = makeEngine();
    engine.addClient('A');
    for (let t = 0; t < 5; t++) {
      move(engine, 'A', 100 + t, t, 0.5); // seq cao ở phiên trước
      engine.advance();
    }
    const before = wire.decodeSnapshot(engine.encodeSnapshotFor('A').bytes);
    expect(before.entities[0].posX).toBeCloseTo(2.5, 1);

    engine.disconnectClient('A');
    engine.reconnectClient('A');

    // Phiên mới: seq nhỏ hơn phiên trước. Buffer cũ (highestSeq=104) sẽ dedupe bỏ
    // hết — buffer mới thì không.
    move(engine, 'A', 1, engine.tick, 1);
    engine.advance();

    const after = wire.decodeSnapshot(engine.encodeSnapshotFor('A').bytes);
    expect(after.entities[0].posX).toBeCloseTo(3.5, 1); // input mới ĐÃ được áp
  });

  it('quá grace: despawn thật (onPlayerLeave), giải phóng seat', () => {
    const onPlayerLeave = vi.fn(echoGame.onPlayerLeave);
    const engine = makeEngine({ ...echoGame, onPlayerLeave });
    engine.addClient('A');
    engine.addClient('B');

    engine.disconnectClient('A');
    engine.removeClient('A'); // GameRoom gọi khi allowReconnection ném (hết grace)

    expect(onPlayerLeave).toHaveBeenCalledWith(engine.worldState, 1);
    expect(engine.hasClient('A')).toBe(false);
    expect(engine.clientCount).toBe(1);

    const snap = wire.decodeSnapshot(engine.encodeSnapshotFor('B').bytes);
    expect(snap.entities.map((e) => e.entityId)).not.toContain(1); // entity đã biến mất
  });

  it('reconnectClient cho session không tồn tại → undefined (room đã dispose)', () => {
    const engine = makeEngine();
    expect(engine.reconnectClient('ma')).toBeUndefined();
  });

  it('grace mặc định 30s, cấu hình được', () => {
    expect(makeEngine().reconnectGraceSeconds).toBe(30);
    const custom = new RoomEngine<EchoWorld, EchoInput>({
      game: echoGame,
      config: { ...echoConfig, reconnectGraceSeconds: 5 },
      inputCodec: echoInputCodec,
    });
    expect(custom.reconnectGraceSeconds).toBe(5);
  });
});
