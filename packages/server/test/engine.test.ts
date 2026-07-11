import { describe, expect, it } from 'vitest';
import { ProtocolCodec } from '@gm-net/core';
import { RoomEngine } from '../src/index.js';
import { echoConfig, echoGame, echoInputCodec, type EchoInput } from './echo-game.js';

const quantization = { world: echoConfig.worldBounds, vMax: echoConfig.vMax };
/** Codec phía "client thô" để tạo/parse gói giống thật. */
const wire = new ProtocolCodec<EchoInput>({ quantization, inputCodec: echoInputCodec });

function newEngine() {
  return new RoomEngine({ game: echoGame, config: echoConfig, inputCodec: echoInputCodec });
}

function inputBytes(latestSeq: number, tick: number, mv: EchoInput): Uint8Array {
  return wire.encodeInput({ ackTick: 0, latestSeq, inputs: [{ tick, payload: mv }] });
}

describe('RoomEngine — echo simulation (nghiệm thu M2)', () => {
  it('handshake mang tickRate + entityId của chính mình', () => {
    const engine = newEngine();
    const { entityId, handshake } = engine.addClient('A');
    expect(handshake.tickRate).toBe(30);
    expect(handshake.protocolVersion).toBe(1);
    expect(handshake.entityId).toBe(entityId);
    expect(handshake.worldBounds).toEqual(echoConfig.worldBounds);
  });

  it('input cộng dồn vị trí, ack = seq đã xử lý', () => {
    const engine = newEngine();
    const { entityId } = engine.addClient('A');
    engine.ingestInput('A', inputBytes(0, 0, { dx: 1, dy: 0 }));
    engine.advance();

    const snap = wire.decodeSnapshot(engine.encodeSnapshotFor('A'));
    expect(snap.serverTick).toBe(1);
    expect(snap.lastProcessedSeq).toBe(0);
    const me = snap.entities.find((e) => e.entityId === entityId)!;
    expect(me.posX).toBeCloseTo(1, 2);
    expect(me.posY).toBeCloseTo(0, 2);
  });

  it('2 client thô thấy state của nhau qua snapshot', () => {
    const engine = newEngine();
    const a = engine.addClient('A').entityId;
    const b = engine.addClient('B').entityId;

    engine.ingestInput('A', inputBytes(0, 0, { dx: 2, dy: 0 }));
    engine.ingestInput('B', inputBytes(0, 0, { dx: -3, dy: 1 }));
    engine.advance();

    for (const sid of ['A', 'B']) {
      const snap = wire.decodeSnapshot(engine.encodeSnapshotFor(sid));
      expect(snap.entities.length).toBe(2);
      const ea = snap.entities.find((e) => e.entityId === a)!;
      const eb = snap.entities.find((e) => e.entityId === b)!;
      expect(ea.posX).toBeCloseTo(2, 2);
      expect(eb.posX).toBeCloseTo(-3, 2);
      expect(eb.posY).toBeCloseTo(1, 2);
    }
  });

  it('ack riêng từng client', () => {
    const engine = newEngine();
    engine.addClient('A');
    engine.addClient('B');
    engine.ingestInput('A', inputBytes(5, 0, { dx: 1, dy: 0 }));
    engine.ingestInput('B', inputBytes(9, 0, { dx: 1, dy: 0 }));
    engine.advance();
    expect(wire.decodeSnapshot(engine.encodeSnapshotFor('A')).lastProcessedSeq).toBe(5);
    expect(wire.decodeSnapshot(engine.encodeSnapshotFor('B')).lastProcessedSeq).toBe(9);
  });

  it('repeat-last: tick không có input mới thì lặp input cuối', () => {
    const engine = newEngine();
    const { entityId } = engine.addClient('A');
    engine.ingestInput('A', inputBytes(0, 0, { dx: 1, dy: 0 }));
    engine.advance(); // tick 0: x = 1
    engine.advance(); // tick 1: không input mới → lặp dx=1 → x = 2
    const me = wire
      .decodeSnapshot(engine.encodeSnapshotFor('A'))
      .entities.find((e) => e.entityId === entityId)!;
    expect(me.posX).toBeCloseTo(2, 2);
  });

  it('lateInputs nổi lên trong snapshot (nuôi adaptive lead)', () => {
    const engine = newEngine();
    engine.addClient('A');
    for (let i = 0; i < 3; i++) engine.advance(); // serverTick = 3
    engine.ingestInput('A', inputBytes(1, 0, { dx: 1, dy: 0 })); // tick 0 đã qua → muộn
    const snap = wire.decodeSnapshot(engine.encodeSnapshotFor('A'));
    expect(snap.lateInputs).toBeGreaterThanOrEqual(1);
  });

  it('removeClient despawn entity (client còn lại không thấy nữa)', () => {
    const engine = newEngine();
    const a = engine.addClient('A').entityId;
    engine.addClient('B');
    engine.advance();
    expect(engine.clientCount).toBe(2);

    engine.removeClient('A');
    expect(engine.clientCount).toBe(1);
    const snapB = wire.decodeSnapshot(engine.encodeSnapshotFor('B'));
    expect(snapB.entities.some((e) => e.entityId === a)).toBe(false);
    expect(snapB.entities.length).toBe(1);
    // Client đã rời không còn encode được.
    expect(() => engine.encodeSnapshotFor('A')).toThrow();
  });

  it('byte rác vào ingestInput thì ném, room tự nuốt', () => {
    const engine = newEngine();
    engine.addClient('A');
    expect(() => engine.ingestInput('A', new Uint8Array([0, 255, 255]))).toThrow();
  });

  it('PING → PONG mang serverTick', () => {
    const engine = newEngine();
    engine.addClient('A');
    engine.advance();
    engine.advance();
    const ping = wire.encodePing({ clientTime: 123456 });
    const decodedPing = engine.decodePing(ping);
    const pong = wire.decodePong(engine.encodePong(decodedPing.clientTime, 999));
    expect(pong.clientTime).toBe(123456);
    expect(pong.serverTime).toBe(999);
    expect(pong.serverTick).toBe(2);
  });
});
