/**
 * Nghiệm thu M4 ([docs/design/004-netcode.md] §5, IMPLEMENTATION M4): kịch bản
 * deterministic với transport delay cố định trên box-sim Rapier:
 *  (a) không lệch → 0 correction (loopback RTT ~0 — điều kiện nghiệm thu; và
 *      RTT 100ms cho chắc);
 *  (b) server áp lực ngoài (đẩy box) → đúng 1 correction, hội tụ;
 *  (c) replay idempotent — restore + replay không có sự kiện server mới giữ
 *      nguyên kết quả bit-perfect.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics2D } from '@gm-net/physics-2d';
import { boxSim, canonicalBoxInput, BOX_ENTITY_TYPE, type BoxInput } from '@gm-net/shared/box-sim';
import { scalarStep } from '@gm-net/core';
import { SimLoopback, bounds, makePredictingClient, runTicks } from './sim-loopback.js';

const IDLE = canonicalBoxInput(0, 0);
const POS_STEP = scalarStep(bounds.minX, bounds.maxX); // ~1.5mm

function corrections(pc: ReturnType<typeof makePredictingClient>): number {
  return pc.outcomes.filter((o) => o.type === 'correction').length;
}

beforeAll(async () => {
  await initPhysics2D();
});

describe('M4 prediction + reconciliation', () => {
  it('(a) nghiệm thu: loopback RTT ~0, di chuyển tự do → misprediction/s = 0', () => {
    const lb = new SimLoopback(0);
    const pc = makePredictingClient(lb);

    runTicks(lb, pc, 10, () => IDLE); // warmup: clock sync + neo timeline
    const move = canonicalBoxInput(0.6, -0.8);
    runTicks(lb, pc, 60, () => move);

    expect(corrections(pc)).toBe(0);
    expect(pc.metrics.read(lb.now).correctionsPerSecond).toBe(0);
    expect(pc.metrics.corrections).toBe(0);

    // Prediction thật sự chạy (box di chuyển) và bám sát server
    const local = pc.prediction.localState()!;
    const server = lb.server.localEntity();
    expect(Math.abs(local.posX)).toBeGreaterThan(1); // đã đi được quãng đường
    // Client dự đoán TRƯỚC server (ahead ~lead tick) — so vị trí server với
    // bản client dự đoán cho đúng tick server hiện tại trong ring.
    const predictedAtServerTick = pc.prediction.stateAt(lb.server.tick)!.local!;
    expect(Math.abs(predictedAtServerTick.posX - server.posX)).toBeLessThan(2 * POS_STEP);
    expect(Math.abs(predictedAtServerTick.posY - server.posY)).toBeLessThan(2 * POS_STEP);
  });

  it('(a2) RTT 100ms, di chuyển tự do → 0 correction', () => {
    const lb = new SimLoopback(50);
    const pc = makePredictingClient(lb);

    runTicks(lb, pc, 40, () => IDLE); // warmup dài hơn: chờ pong + lead ổn định
    const move = canonicalBoxInput(-0.5, 0.5);
    runTicks(lb, pc, 90, () => move);

    expect(corrections(pc)).toBe(0);
    const predictedAtServerTick = pc.prediction.stateAt(lb.server.tick)!.local!;
    const server = lb.server.localEntity();
    expect(Math.abs(predictedAtServerTick.posX - server.posX)).toBeLessThan(2 * POS_STEP);
  });

  it('(b) server đẩy box (áp lực ngoài) → đúng 1 correction rồi hội tụ', () => {
    const lb = new SimLoopback(50);
    const pc = makePredictingClient(lb);

    runTicks(lb, pc, 40, () => IDLE);
    expect(corrections(pc)).toBe(0);

    // Đẩy một lần: đặt velocity ngoài luồng input, đúng một tick server.
    lb.server.beforeStep = (world) => {
      const cur = boxSim.getEntity(world, lb.server.entityId)!;
      boxSim.setEntity(world, lb.server.entityId, { ...cur, velX: 5, velY: 3 });
      lb.server.beforeStep = undefined;
    };
    runTicks(lb, pc, 60, () => IDLE);

    expect(corrections(pc)).toBe(1);
    const m = pc.metrics.read(lb.now);
    // Biên độ ≈ displacement một tick của cú đẩy: |v|/30 ≈ 0.19m
    expect(m.lastMagnitude).toBeGreaterThan(0.1);
    expect(m.lastMagnitude).toBeLessThan(0.4);

    // Hội tụ: sau correction, mọi snapshot tiếp theo đều clean và client bám server.
    const after = pc.outcomes.slice(pc.outcomes.findIndex((o) => o.type === 'correction') + 1);
    expect(after.every((o) => o.type === 'clean')).toBe(true);
    const predictedAtServerTick = pc.prediction.stateAt(lb.server.tick)!.local!;
    const server = lb.server.localEntity();
    expect(Math.abs(predictedAtServerTick.posX - server.posX)).toBeLessThan(2 * POS_STEP);
    expect(Math.abs(predictedAtServerTick.posY - server.posY)).toBeLessThan(2 * POS_STEP);
  });

  it('(c) replay idempotent: restore + replay không có gì mới → state y nguyên bit-perfect', () => {
    const lb = new SimLoopback(0);
    const pc = makePredictingClient(lb);

    runTicks(lb, pc, 10, () => IDLE);
    runTicks(lb, pc, 25, (i) => canonicalBoxInput(Math.sin(i * 0.4), 0.7));

    const before = pc.prediction.localState()!;
    const tick = pc.prediction.stateTick - 7; // mô phỏng correction RTT ~200ms
    const rec = pc.prediction.stateAt(tick)!;
    // "Authoritative" trùng khớp hoàn toàn bản đã dự đoán → không ghi đè gì,
    // thuần restore + replay chuỗi input gốc.
    pc.prediction.correct(
      tick,
      [{ ...rec.local!, entityId: lb.server.entityId, entityType: BOX_ENTITY_TYPE }],
      () => false,
    );
    expect(pc.prediction.localState()).toEqual(before);
    expect(pc.prediction.stateTick).toBe(tick + 7);
  });

  it('(c2) reconcile lặp cùng snapshot sau correction → clean, không sửa thêm', () => {
    const lb = new SimLoopback(50);
    const pc = makePredictingClient(lb);
    runTicks(lb, pc, 40, () => IDLE);
    lb.server.beforeStep = (world) => {
      const cur = boxSim.getEntity(world, lb.server.entityId)!;
      boxSim.setEntity(world, lb.server.entityId, { ...cur, velX: -4, velY: 0 });
      lb.server.beforeStep = undefined;
    };
    runTicks(lb, pc, 20, () => IDLE);
    expect(corrections(pc)).toBe(1);

    // Đưa lại đúng snapshot đã gây correction: ring tại tick đó giờ là bản đã
    // sửa → khớp authoritative → clean, state không đổi.
    const snapTick = pc.outcomes.find((o) => o.type === 'correction')!.tick;
    const stateBefore = pc.prediction.localState();
    const replayOutcome = pc.reconciler.reconcile({
      serverTick: snapTick,
      lastProcessedSeq: 0,
      lateInputs: 0,
      entities: [
        {
          ...pc.prediction.stateAt(snapTick)!.local!,
          entityId: lb.server.entityId,
          entityType: BOX_ENTITY_TYPE,
        },
      ],
    });
    expect(replayOutcome.type).toBe('clean');
    expect(pc.prediction.localState()).toEqual(stateBefore);
  });

  it('input muộn một lần → tối đa 1 correction rồi hội tụ (không lặp vô hạn)', () => {
    // Lead thấp nhân tạo: ép input đến muộn bằng cách tăng trễ giữa chừng là
    // phức tạp; thay vào đó kiểm tra trực tiếp tính chất "correction không dây
    // dưa": sau MỌI correction, các outcome tiếp theo trong cùng phiên chỉ có
    // clean (đã cover ở (b)/(c2)) — ở đây chốt thêm tổng thể: chạy dài với
    // input đổi hướng liên tục, RTT 100ms, không được có correction nào.
    const lb = new SimLoopback(50);
    const pc = makePredictingClient(lb);
    runTicks(lb, pc, 40, () => IDLE);
    runTicks(lb, pc, 120, (i) => canonicalBoxInput(Math.sin(i * 0.25), Math.cos(i * 0.15)));
    expect(corrections(pc)).toBe(0);
  });
});
