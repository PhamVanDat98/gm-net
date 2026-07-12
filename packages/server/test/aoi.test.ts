/**
 * Interest management / AOI ([006] §6, M9).
 *
 * Nghiệm thu ([IMPLEMENTATION] M9): entity ngoài vùng **không xuất hiện trong bytes
 * gửi**; đi qua ranh giới **không flapping** (nhờ hysteresis).
 */
import { describe, expect, it } from 'vitest';
import { ProtocolCodec, applySnapshotDelta, type Snapshot } from '@gm-net/core';
import { InterestGrid, RoomEngine } from '../src/index.js';
import { echoConfig, echoGame, echoInputCodec, type EchoInput, type EchoWorld } from './echo-game.js';

const wire = new ProtocolCodec<EchoInput>({
  quantization: { world: echoConfig.worldBounds, vMax: echoConfig.vMax },
  inputCodec: echoInputCodec,
});

/** Echo game: entity di chuyển bằng input cộng dồn — đủ để lái vị trí trong test. */
function makeEngine(aoi?: { radius: number; hysteresis?: number; cellSize?: number }) {
  return new RoomEngine<EchoWorld, EchoInput>({
    game: echoGame,
    config: { ...echoConfig, aoi },
    inputCodec: echoInputCodec,
  });
}

/** Đẩy entity của `sid` thêm (dx, dy) — echo game cộng dồn vị trí theo input. */
function moveTo(engine: RoomEngine<EchoWorld, EchoInput>, sid: string, dx: number, dy: number, seq: number) {
  engine.ingestInput(
    sid,
    wire.encodeInput({
      ackTick: 0,
      latestSeq: seq,
      inputs: [{ tick: engine.tick, payload: { dx, dy } }],
    }),
  );
}

/** Đọc entity mà client thấy từ **bytes thật** (không nhìn trộm state server). */
function seenBy(engine: RoomEngine<EchoWorld, EchoInput>, sid: string, prev?: Snapshot): Snapshot {
  const state = engine.encodeSnapshotFor(sid);
  return state.keyframe
    ? wire.decodeSnapshot(state.bytes)
    : applySnapshotDelta(prev!, wire.decodeDelta(state.bytes));
}

describe('InterestGrid', () => {
  const grid = new InterestGrid({ radius: 10 });

  it('vào tập ở bán kính r, ở lại tới r×1.2, ra ngoài thì biến mất', () => {
    const near = { entityId: 1, entityType: 0, posX: 9, posY: 0, rot: 0, velX: 0, velY: 0 };
    const mid = { entityId: 2, entityType: 0, posX: 11, posY: 0, rot: 0, velX: 0, velY: 0 }; // giữa r và r×1.2
    const far = { entityId: 3, entityType: 0, posX: 13, posY: 0, rot: 0, velX: 0, velY: 0 };
    grid.rebuild([near, mid, far]);

    // Chưa từng thấy: chỉ entity trong bán kính VÀO.
    const fresh = grid.visible(0, 0, new Set()).map((e) => e.entityId);
    expect(fresh).toEqual([1]);

    // Đã thấy id 2 từ trước → nó ở lại (hysteresis) dù đã ra ngoài bán kính vào.
    const sticky = grid.visible(0, 0, new Set([2])).map((e) => e.entityId).sort();
    expect(sticky).toEqual([1, 2]);

    // id 3 ngoài bán kính RA → không giữ lại dù từng thấy.
    const dropped = grid.visible(0, 0, new Set([3])).map((e) => e.entityId);
    expect(dropped).toEqual([1]);
  });

  it('cellSize mặc định = bán kính ra → vùng quan tâm gọn trong 3×3 ô', () => {
    expect(grid.exitRadius).toBeCloseTo(12);
    expect(grid.cellSize).toBeCloseTo(12);
  });

  it('từ chối cấu hình vô lý', () => {
    expect(() => new InterestGrid({ radius: 0 })).toThrow(RangeError);
    expect(() => new InterestGrid({ radius: 10, hysteresis: 0.5 })).toThrow(RangeError);
  });
});

describe('RoomEngine + AOI — nghiệm thu M9', () => {
  it('entity ngoài vùng KHÔNG có trong bytes gửi', () => {
    const engine = makeEngine({ radius: 10 });
    engine.addClient('A'); // entity 1 tại (0,0)
    engine.addClient('B'); // entity 2 tại (0,0)
    engine.addClient('C'); // entity 3 tại (0,0)

    // Đẩy C ra xa (30, 0) — ngoài bán kính 10 của A.
    moveTo(engine, 'C', 30, 0, 1);
    engine.advance();

    const seen = seenBy(engine, 'A');
    const ids = seen.entities.map((e) => e.entityId).sort();

    expect(ids).toEqual([1, 2]); // thấy chính mình + B (cùng chỗ), KHÔNG thấy C
    expect(ids).not.toContain(3);
  });

  it('không bật AOI → thấy cả world (mặc định giữ nguyên hành vi cũ)', () => {
    const engine = makeEngine();
    engine.addClient('A');
    engine.addClient('C');
    moveTo(engine, 'C', 30, 0, 1);
    engine.advance();

    expect(seenBy(engine, 'A').entities.map((e) => e.entityId).sort()).toEqual([1, 2]);
  });

  it('entity của chính client luôn có mặt (dù một mình giữa map)', () => {
    const engine = makeEngine({ radius: 5 });
    engine.addClient('A');
    engine.addClient('B');
    moveTo(engine, 'B', 50, 50, 1); // B đi rất xa
    engine.advance();

    const ids = seenBy(engine, 'B').entities.map((e) => e.entityId);
    expect(ids).toContain(2); // B vẫn thấy chính mình
    expect(ids).not.toContain(1);
  });

  it('đi qua ranh giới KHÔNG flapping (hysteresis) — nghiệm thu M9', () => {
    const engine = makeEngine({ radius: 10, hysteresis: 1.2 });
    engine.addClient('A'); // entity 1, đứng yên ở (0,0)
    engine.addClient('B'); // entity 2 — sẽ dao động quanh mép

    let seq = 1;
    let seen: Snapshot = seenBy(engine, 'A');
    const timeline: boolean[] = [];

    // B dao động quanh bán kính vào (10): 9.5 ↔ 10.5 — biên độ nhỏ, đúng kịch bản
    // gây flapping nếu không có hysteresis.
    for (let i = 0; i < 12; i++) {
      const x = i % 2 === 0 ? 10.5 : 9.5;
      // Echo game cộng dồn: đặt lại bằng cách gửi delta cần thiết.
      const cur = engine.worldState.entities.get(2)!;
      moveTo(engine, 'B', x - cur.x, 0, seq++);
      engine.advance();
      seen = seenBy(engine, 'A', seen);
      timeline.push(seen.entities.some((e) => e.entityId === 2));
    }

    // Vào tập ở 9.5 (≤10) rồi ở lại khi ra 10.5 (≤12 = r×1.2) → không nhấp nháy.
    const transitions = timeline.filter((v, i) => i > 0 && v !== timeline[i - 1]).length;
    expect(transitions).toBeLessThanOrEqual(1);
    expect(timeline[timeline.length - 1]).toBe(true); // vẫn đang thấy nhau
  });

  it('AOI + delta: client tái dựng đúng tập entity của mình (spawn/despawn qua delta)', () => {
    const engine = makeEngine({ radius: 10 });
    engine.addClient('A');
    engine.addClient('B');

    let seen: Snapshot = seenBy(engine, 'A'); // keyframe: thấy 1, 2
    expect(seen.entities.map((e) => e.entityId).sort()).toEqual([1, 2]);

    // A ack tick 0 để server chuyển sang delta.
    engine.ingestInput('A', wire.encodeInput({ ackTick: 0, latestSeq: 1, inputs: [{ tick: 1, payload: { dx: 0, dy: 0 } }] }));

    // B đi ra ngoài vùng → delta phải mang despawn.
    let seq = 2;
    for (let i = 0; i < 3; i++) {
      const cur = engine.worldState.entities.get(2)!;
      moveTo(engine, 'B', 30 - cur.x, 0, seq++);
      engine.advance();
      seen = seenBy(engine, 'A', seen);
      engine.ingestInput(
        'A',
        wire.encodeInput({ ackTick: seen.serverTick, latestSeq: seq++, inputs: [{ tick: engine.tick, payload: { dx: 0, dy: 0 } }] }),
      );
    }
    expect(seen.entities.map((e) => e.entityId)).toEqual([1]); // B đã despawn khỏi tập của A

    // B quay lại gần → delta mang block FULL, client dựng lại đủ field.
    for (let i = 0; i < 3; i++) {
      const cur = engine.worldState.entities.get(2)!;
      moveTo(engine, 'B', 2 - cur.x, 0, seq++);
      engine.advance();
      seen = seenBy(engine, 'A', seen);
      engine.ingestInput(
        'A',
        wire.encodeInput({ ackTick: seen.serverTick, latestSeq: seq++, inputs: [{ tick: engine.tick, payload: { dx: 0, dy: 0 } }] }),
      );
    }
    const b = seen.entities.find((e) => e.entityId === 2);
    expect(b).toBeDefined();
    expect(b!.posX).toBeCloseTo(2, 1); // full block: vị trí đúng, không phải rác
  });
});
