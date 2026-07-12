/**
 * Delta compression ([005] §4, M7): server chỉ gửi field đổi so với baseline mà
 * client đã ack; client tái dựng snapshot đầy đủ từ baseline + delta.
 *
 * Test bắt buộc theo [005] §8: round-trip, golden bytes, fuzz decoder, và
 * property "chuỗi snapshot + ack ngẫu nhiên → client state == server state".
 */
import { describe, expect, it } from 'vitest';
import {
  DeltaField,
  MessageType,
  ProtocolCodec,
  ProtocolError,
  applySnapshotDelta,
  type CustomCodec,
  type Snapshot,
  type SnapshotEntity,
} from '../src/index.js';

const QUANT = {
  world: { minX: -100, maxX: 100, minY: -100, maxY: 100 },
  vMax: 50,
};

const plain = new ProtocolCodec({ quantization: QUANT });

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function entity(id: number, over: Partial<SnapshotEntity> = {}): SnapshotEntity {
  return { entityId: id, entityType: 1, posX: 0, posY: 0, rot: 0, velX: 0, velY: 0, ...over };
}

function snapshot(tick: number, entities: SnapshotEntity[]): Snapshot {
  return { serverTick: tick, lastProcessedSeq: 0, lateInputs: 0, entities };
}

/** Snapshot như client thấy nó: đi qua wire full (đã quantize + dequantize). */
function throughWire(snap: Snapshot, codec = plain): Snapshot {
  return codec.decodeSnapshot(codec.encodeSnapshot(snap));
}

/**
 * So state (bỏ qua header) — client tái dựng phải khớp server sau quantize.
 * Sắp theo entityId: thứ tự mảng không phải hợp đồng (consumer tra theo id), và
 * client dựng lại từ baseline nên thứ tự có thể khác server.
 */
function expectSameState(actual: Snapshot, expected: Snapshot): void {
  const byId = (s: Snapshot) => [...s.entities].sort((a, b) => a.entityId - b.entityId);
  expect(byId(actual)).toEqual(byId(expected));
}

describe('DELTA — round-trip', () => {
  it('chỉ field đổi có mặt trên dây; client tái dựng đúng snapshot server', () => {
    const base = snapshot(10, [entity(1, { posX: 5, posY: 5 }), entity(2, { posX: -20, velX: 3 })]);
    const next = snapshot(11, [
      entity(1, { posX: 7, posY: 5 }), // chỉ posX đổi
      entity(2, { posX: -20, velX: 3 }), // không đổi → không lên dây
    ]);

    const bytes = plain.encodeDelta(next, { serverTick: base.serverTick, entities: base.entities });
    const delta = plain.decodeDelta(bytes);

    expect(delta.serverTick).toBe(11);
    expect(delta.baselineTick).toBe(10);
    expect(delta.changed).toHaveLength(1);
    expect(delta.changed[0].entityId).toBe(1);
    expect(delta.changed[0].mask).toBe(DeltaField.PosX);
    expect(delta.despawns).toEqual([]);

    expectSameState(applySnapshotDelta(throughWire(base), delta), throughWire(next));
  });

  it('entity mới → block FULL; entity biến mất → despawn id', () => {
    const base = snapshot(10, [entity(1), entity(2)]);
    const next = snapshot(11, [entity(1), entity(3, { entityType: 2, posX: 9 })]);

    const delta = plain.decodeDelta(
      plain.encodeDelta(next, { serverTick: base.serverTick, entities: base.entities }),
    );

    expect(delta.despawns).toEqual([2]);
    expect(delta.changed).toHaveLength(1);
    expect(delta.changed[0].entityId).toBe(3);
    expect(delta.changed[0].mask & DeltaField.Full).toBeTruthy();
    expect(delta.changed[0].entity.entityType).toBe(2);

    expectSameState(applySnapshotDelta(throughWire(base), delta), throughWire(next));
  });

  it('delta rỗng (không entity nào đổi) nhỏ hơn nhiều so với full snapshot', () => {
    const entities = Array.from({ length: 10 }, (_, i) => entity(i + 1, { posX: i, posY: -i }));
    const base = snapshot(10, entities);
    const next = snapshot(11, entities.map((e) => ({ ...e })));

    const full = plain.encodeSnapshot(next);
    const delta = plain.encodeDelta(next, { serverTick: base.serverTick, entities: base.entities });

    expect(delta.byteLength).toBeLessThan(full.byteLength / 4);
    const applied = applySnapshotDelta(throughWire(base), plain.decodeDelta(delta));
    expectSameState(applied, throughWire(next));
  });

  it('custom block delta ở mức có-đổi/không-đổi ([005] §5)', () => {
    const hpCodec: CustomCodec<{ hp: number }> = {
      encode: (w, s) => w.writeU8(s.hp),
      decode: (r) => ({ hp: r.readU8() }),
    };
    const codec = new ProtocolCodec({
      quantization: QUANT,
      entityCodecs: new Map([[1, hpCodec as CustomCodec]]),
    });

    const base = snapshot(10, [entity(1, { custom: { hp: 100 } })]);
    const sameHp = snapshot(11, [entity(1, { custom: { hp: 100 } })]);
    const newHp = snapshot(11, [entity(1, { custom: { hp: 80 } })]);

    const unchanged = codec.decodeDelta(
      codec.encodeDelta(sameHp, { serverTick: 10, entities: base.entities }),
    );
    expect(unchanged.changed).toHaveLength(0);

    const changed = codec.decodeDelta(
      codec.encodeDelta(newHp, { serverTick: 10, entities: base.entities }),
    );
    expect(changed.changed[0].mask & DeltaField.Custom).toBeTruthy();
    expect(changed.changed[0].entity.custom).toEqual({ hp: 80 });

    expectSameState(
      applySnapshotDelta(throughWire(base, codec), changed),
      throughWire(newHp, codec),
    );
  });
});

describe('DELTA — golden bytes (đổi format là test đỏ, ép cập nhật doc 005)', () => {
  it('một entity đổi posX, một entity despawn', () => {
    const base = snapshot(1, [entity(1, { posX: 0 }), entity(2)]);
    const next: Snapshot = {
      serverTick: 2,
      lastProcessedSeq: 7,
      lateInputs: 0,
      entities: [entity(1, { posX: 100 })], // posX max → u16 0xffff
    };

    const bytes = plain.encodeDelta(next, { serverTick: 1, entities: base.entities });

    expect([...bytes]).toEqual([
      MessageType.Delta,
      2, 0, 0, 0, // serverTick u32
      1, 0, 0, 0, // baselineTick u32
      7, 0, // lastProcessedSeq u16
      0, // lateInputs u8
      1, 0, // despawnCount u16
      2, 0, // despawn entityId 2
      1, 0, // changedCount u16
      1, 0, // entityId 1
      DeltaField.PosX, // fieldMask
      0xff, 0xff, // posX quantized
    ]);
  });
});

describe('DELTA — fuzz decoder', () => {
  it('bytes rác không crash/hang (ném ProtocolError hoặc trả về)', () => {
    const rng = makeRng(99);
    for (let i = 0; i < 500; i++) {
      const len = Math.floor(rng() * 40);
      const bytes = new Uint8Array(len);
      for (let k = 0; k < len; k++) bytes[k] = Math.floor(rng() * 256);
      bytes[0] = MessageType.Delta;
      try {
        plain.decodeDelta(bytes);
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
      }
    }
  });

  it('từ chối packet sai messageType', () => {
    expect(() => plain.decodeDelta(plain.encodeSnapshot(snapshot(1, [])))).toThrow(ProtocolError);
  });
});

describe('DELTA — property: chuỗi snapshot + ack ngẫu nhiên ([005] §8)', () => {
  it('client tái dựng == server state với ack trễ/nhảy cóc bất kỳ', () => {
    const rng = makeRng(2026);

    // Ack đi kèm INPUT nên tới server TRỄ: baseline server chọn thường là một
    // snapshot CŨ của client, không phải bản mới nhất → client phải giữ ring
    // snapshot gần đây (không chỉ bản latest) mới áp được delta.
    const sent = new Map<number, Snapshot>(); // server: snapshot đã gửi
    const clientRing = new Map<number, Snapshot>(); // client: snapshot đã tái dựng
    let clientState: Snapshot | undefined;
    let ackTick = -1; // tick client đã ack mà SERVER biết (trễ)
    const ackInFlight: number[] = [];

    let entities: SnapshotEntity[] = [entity(1, { posX: 0, posY: 0 })];
    let nextId = 2;

    for (let tick = 0; tick < 200; tick++) {
      // Server mô phỏng: xê dịch, thỉnh thoảng spawn/despawn.
      entities = entities.map((e) => ({
        ...e,
        posX: Math.max(-99, Math.min(99, e.posX + (rng() - 0.5) * 4)),
        posY: Math.max(-99, Math.min(99, e.posY + (rng() - 0.5) * 4)),
        velX: (rng() - 0.5) * 10,
        rot: rng() * Math.PI,
      }));
      if (rng() < 0.1 && entities.length < 12) entities.push(entity(nextId++, { posX: rng() * 50 }));
      if (rng() < 0.08 && entities.length > 1) entities.splice(Math.floor(rng() * entities.length), 1);

      const server = snapshot(tick, entities.map((e) => ({ ...e })));
      sent.set(tick, server);

      // Server chọn: có baseline client đã ack (còn trong ring) → delta, không → keyframe.
      const baseline = ackTick >= 0 ? sent.get(ackTick) : undefined;
      if (baseline && tick - ackTick <= 30) {
        const bytes = plain.encodeDelta(server, {
          serverTick: baseline.serverTick,
          entities: baseline.entities,
        });
        const delta = plain.decodeDelta(bytes);
        // Client áp lên đúng snapshot baseline trong ring của nó (không phải latest).
        const clientBaseline = clientRing.get(delta.baselineTick);
        expect(clientBaseline).toBeDefined();
        clientState = applySnapshotDelta(clientBaseline!, delta);
      } else {
        clientState = plain.decodeSnapshot(plain.encodeSnapshot(server));
      }

      // Client state phải khớp đúng snapshot server tại tick đó (sau quantize).
      expectSameState(clientState, throughWire(server));
      clientRing.set(clientState.serverTick, clientState);

      // Ack đi kèm INPUT: client ack bản mới nhất, server nhận sau vài tick.
      ackInFlight.push(clientState.serverTick);
      if (ackInFlight.length > 3 + Math.floor(rng() * 3)) ackTick = ackInFlight.shift()!;
    }
  });
});
