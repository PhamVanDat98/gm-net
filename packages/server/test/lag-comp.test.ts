/**
 * Lag compensation ([006] §4, M10).
 *
 * Nghiệm thu ([IMPLEMENTATION] M10): "bắn qua proxy 200ms trúng 100%; **không lag
 * comp thì trượt** (test chứng minh giá trị)". Test dưới đây dựng đúng tình huống
 * đó một cách deterministic: mục tiêu di chuyển, người bắn nhắm vào chỗ nó **nhìn
 * thấy** (trễ 200ms). Server có lag comp → trúng; không bù → trượt.
 */
import { describe, expect, it } from 'vitest';
import { ProtocolCodec } from '@gm-net/core';
import { RoomEngine, hitscan, rayCircle, EntityHistory } from '../src/index.js';
import { echoConfig, echoGame, echoInputCodec, type EchoInput, type EchoWorld } from './echo-game.js';

const wire = new ProtocolCodec<EchoInput>({
  quantization: { world: echoConfig.worldBounds, vMax: echoConfig.vMax },
  inputCodec: echoInputCodec,
});

const TARGET_RADIUS = 0.5;
const INTERP_DELAY_MS = 200; // RTT 200ms: client nhìn remote trễ ~200ms

function makeEngine(config: Partial<typeof echoConfig> = {}) {
  return new RoomEngine<EchoWorld, EchoInput>({
    game: echoGame,
    config: { ...echoConfig, ...config },
    inputCodec: echoInputCodec,
  });
}

function sendInput(
  engine: RoomEngine<EchoWorld, EchoInput>,
  sid: string,
  opts: { seq: number; tick: number; dx?: number; dy?: number; interpDelayMs?: number },
) {
  engine.ingestInput(
    sid,
    wire.encodeInput({
      ackTick: 0,
      interpDelayMs: opts.interpDelayMs ?? 0,
      latestSeq: opts.seq,
      inputs: [{ tick: opts.tick, payload: { dx: opts.dx ?? 0, dy: opts.dy ?? 0 } }],
    }),
  );
}

describe('rayCircle', () => {
  it('trúng khi tia xuyên hình tròn, trả khoảng cách tới điểm chạm', () => {
    // Tia từ (0,0) sang phải; tròn tâm (10,0) r=1 → chạm ở x=9.
    expect(rayCircle(0, 0, 1, 0, 10, 0, 1, 100)).toBeCloseTo(9, 5);
  });

  it('trượt khi lệch quá bán kính / ở phía sau / quá tầm', () => {
    expect(rayCircle(0, 0, 1, 0, 10, 5, 1, 100)).toBeUndefined(); // lệch
    expect(rayCircle(0, 0, 1, 0, -10, 0, 1, 100)).toBeUndefined(); // phía sau
    expect(rayCircle(0, 0, 1, 0, 10, 0, 1, 5)).toBeUndefined(); // ngoài tầm bắn
  });

  it('origin nằm trong hitbox → trúng ở khoảng cách 0 (bắn áp sát)', () => {
    expect(rayCircle(10, 0, 1, 0, 10, 0, 1, 100)).toBe(0);
  });

  it('vector hướng 0 → không trúng gì (không chia cho 0)', () => {
    expect(rayCircle(0, 0, 0, 0, 1, 0, 1, 100)).toBeUndefined();
  });
});

describe('EntityHistory', () => {
  it('trả transform đúng tick; ngoài ring → undefined', () => {
    const h = new EntityHistory(3);
    for (let t = 0; t < 5; t++) {
      h.record(t, [{ entityId: 1, entityType: 0, posX: t, posY: 0, rot: 0, velX: 0, velY: 0 }]);
    }
    expect(h.at(4)?.[0].posX).toBe(4);
    expect(h.at(2)?.[0].posX).toBe(2);
    expect(h.at(1)).toBeUndefined(); // đã bị ghi đè (ring 3 slot)
  });
});

describe('hitscan — bỏ qua người bắn, chọn mục tiêu gần nhất', () => {
  const entities = [
    { entityId: 1, posX: 0, posY: 0, rot: 0 }, // người bắn
    { entityId: 2, posX: 5, posY: 0, rot: 0 },
    { entityId: 3, posX: 10, posY: 0, rot: 0 },
  ];

  it('trúng mục tiêu gần nhất, không tự bắn mình', () => {
    const hit = hitscan(entities, {
      originX: 0, originY: 0, dirX: 1, dirY: 0,
      maxDistance: 100, targetRadius: TARGET_RADIUS, ignoreEntityId: 1,
    }, 7);
    expect(hit?.entityId).toBe(2);
    expect(hit?.tick).toBe(7);
  });
});

describe('Nghiệm thu M10 — bắn qua RTT 200ms', () => {
  /**
   * Kịch bản: mục tiêu (entity 2) chạy ngang qua trước mặt người bắn (entity 1).
   * Người bắn thấy mục tiêu TRỄ 200ms (6 tick @30Hz) nên nhắm vào vị trí cũ.
   * Server phải tua ngược 6 tick mới thấy nó trúng.
   */
  function runScenario(opts: { lagComp: boolean }) {
    const engine = makeEngine(opts.lagComp ? {} : { lagCompHistoryTicks: 0 });
    engine.addClient('shooter'); // entity 1, đứng yên tại (0,0)
    engine.addClient('target'); // entity 2

    // Đưa mục tiêu tới (0, 10) rồi cho chạy sang phải 1 đơn vị/tick.
    sendInput(engine, 'target', { seq: 1, tick: engine.tick, dx: 0, dy: 10 });
    engine.advance();

    let seq = 2;
    const seenPositions: Array<{ tick: number; x: number }> = [];
    for (let i = 0; i < 20; i++) {
      sendInput(engine, 'target', { seq: seq++, tick: engine.tick, dx: 1, dy: 0 });
      // Người bắn gửi input rỗng nhưng KHAI interp delay của mình.
      sendInput(engine, 'shooter', {
        seq: seq++,
        tick: engine.tick,
        interpDelayMs: INTERP_DELAY_MS,
      });
      engine.advance();
      const t = engine.worldState.entities.get(2)!;
      seenPositions.push({ tick: engine.tick, x: t.x });
    }

    // Vị trí mục tiêu mà NGƯỜI BẮN đang nhìn thấy lúc này (trễ 200ms = 6 tick).
    const rewindTick = engine.rewindTickFor('shooter', engine.tick);
    const seen = seenPositions.find((p) => p.tick === rewindTick)!;
    const current = engine.worldState.entities.get(2)!;

    // Bắn thẳng vào chỗ nhìn thấy: tia từ (0,0) tới (seen.x, 10).
    const hit = engine.rewindHitscan(
      'shooter',
      {
        originX: 0,
        originY: 0,
        dirX: seen.x,
        dirY: 10,
        maxDistance: 100,
        targetRadius: TARGET_RADIUS,
        ignoreEntityId: 1,
      },
      engine.tick,
    );

    return { hit, rewindTick, seenX: seen.x, currentX: current.x, engineTick: engine.tick };
  }

  it('CÓ lag comp: bắn vào chỗ nhìn thấy → TRÚNG', () => {
    const r = runScenario({ lagComp: true });

    // Rewind đúng 6 tick (200ms @30Hz) — server tua về đúng cái client thấy.
    expect(r.engineTick - r.rewindTick).toBe(6);
    // Mục tiêu đã chạy tiếp: vị trí hiện tại khác xa chỗ người bắn nhìn thấy.
    expect(r.currentX - r.seenX).toBeCloseTo(6, 0);

    expect(r.hit).toBeDefined();
    expect(r.hit!.entityId).toBe(2);
    expect(r.hit!.tick).toBe(r.rewindTick);
  });

  it('KHÔNG lag comp: cùng phát bắn đó → TRƯỢT (chứng minh giá trị)', () => {
    const r = runScenario({ lagComp: false });

    // Không có history → kiểm ở tick hiện tại, nơi mục tiêu đã chạy đi 6 đơn vị.
    expect(r.hit).toBeUndefined();
  });

  it('clamp delay client khai: 5 giây → chỉ tua tối đa 200ms', () => {
    const engine = makeEngine();
    engine.addClient('cheater');
    for (let i = 0; i < 20; i++) engine.advance(); // đủ lịch sử để tua thật

    sendInput(engine, 'cheater', { seq: 1, tick: engine.tick, interpDelayMs: 5000 });

    // 200ms @30Hz = 6 tick — không phải 150 tick như client khai.
    expect(engine.tick - engine.rewindTickFor('cheater', engine.tick)).toBe(6);
  });

  it('không tua về trước tick 0 (room vừa mở)', () => {
    const engine = makeEngine();
    engine.addClient('A');
    engine.advance();
    sendInput(engine, 'A', { seq: 1, tick: engine.tick, interpDelayMs: 5000 });

    expect(engine.rewindTickFor('A', engine.tick)).toBe(0);
  });

  it('client không khai delay → không tua (kiểm ở hiện tại)', () => {
    const engine = makeEngine();
    engine.addClient('A');
    engine.advance();
    sendInput(engine, 'A', { seq: 1, tick: engine.tick });

    expect(engine.rewindTickFor('A', engine.tick)).toBe(engine.tick);
  });
});
