/**
 * `GameSession` (IMPLEMENTATION 5.2): kiểm tra lớp ghép nối đúng các mảnh M3–M5
 * trên harness loopback — local đi đường prediction + smoothing, remote đi
 * đường interpolation (trễ ~100ms, không chứa local entity), HUD gộp số liệu.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics2D } from '@gm-net/physics-2d';
import {
  BOX_ENTITY_TYPE,
  boxSim,
  canonicalBoxInput,
  createBoxWorld,
  type BoxInput,
  type BoxSnapshot,
  type BoxWorld,
} from '@gm-net/shared/box-sim';
import { SERVER_TICK_MS } from '@gm-net/shared';
import { GameSession } from '../src/index.js';
import { SimLoopback, bounds, makeCodec, quantization } from './sim-loopback.js';

const REMOTE_ID = 2;
const IDLE = canonicalBoxInput(0, 0);

beforeAll(async () => {
  await initPhysics2D();
});

function makeSession(lb: SimLoopback): GameSession<BoxWorld, BoxInput, BoxSnapshot> {
  const session = new GameSession<BoxWorld, BoxInput, BoxSnapshot>(lb.transport, {
    codec: makeCodec(),
    quantization,
    sim: boxSim,
    world: createBoxWorld({ bounds }),
    now: () => lb.now,
  });
  lb.join();
  session.start();
  return session;
}

/** Chạy `n` tick 30Hz: session.tick → giao message → server tick → giao snapshot. */
function runTicks(
  lb: SimLoopback,
  session: GameSession<BoxWorld, BoxInput, BoxSnapshot>,
  n: number,
  payload: BoxInput,
  onFrame?: () => void,
): void {
  for (let i = 0; i < n; i++) {
    session.tick(payload, lb.now);
    lb.advance(0);
    lb.serverTick();
    lb.advance(SERVER_TICK_MS);
    onFrame?.();
  }
}

describe('GameSession (M5)', () => {
  it('getRenderState: local (predicted+smoothed) + remote (interpolated, không chứa local)', () => {
    const lb = new SimLoopback(50); // RTT 100ms
    // "Người chơi thứ hai" phía server: box chạy đều sang phải.
    boxSim.spawn(lb.server.world, REMOTE_ID, BOX_ENTITY_TYPE, {
      posX: -10, posY: 5, rot: 0, velX: 0, velY: 0,
    });
    lb.server.beforeStep = (world) => {
      boxSim.applyInput(world, REMOTE_ID, canonicalBoxInput(0.4, 0), lb.server.tick);
    };

    const session = makeSession(lb);
    runTicks(lb, session, 40, IDLE); // warmup: clock + neo + đổ đầy buffer interp

    const move = canonicalBoxInput(0.8, 0);
    const remoteXs: number[] = [];
    runTicks(lb, session, 60, move, () => {
      const rs = session.getRenderState(lb.now);
      if (rs.remote.get(REMOTE_ID)) remoteXs.push(rs.remote.get(REMOTE_ID)!.posX);
    });

    const rs = session.getRenderState(lb.now);
    // Local: prediction chạy (đi được quãng đường), smoothing bám sát sim.
    expect(rs.local).toBeDefined();
    expect(rs.local!.posX).toBeGreaterThan(1);
    // Smoothing đuổi theo sim: lag steady-state ≈ v·τ = 8 m/s × 0.08 s ≈ 0.64m.
    const sim = session.prediction!.localState()!;
    expect(Math.abs(rs.local!.posX - sim.posX)).toBeLessThan(1);

    // Remote: có entity 2, KHÔNG có local entity (id 1) trong map remote.
    expect(rs.remote.has(lb.server.entityId)).toBe(false);
    const remote = rs.remote.get(REMOTE_ID)!;
    expect(remote.mode).toBe('interp');
    // Trễ render: vị trí interpolated phải ở SAU vị trí server hiện tại (box đi +x).
    const serverRemote = boxSim.getEntity(lb.server.world, REMOTE_ID)!;
    expect(remote.posX).toBeLessThan(serverRemote.posX);
    expect(remote.posX).toBeGreaterThan(-10); // nhưng đã di chuyển từ spawn

    // Mượt: chuỗi vị trí remote đơn điệu tăng, bước nhảy ≤ ~1 tick chuyển động.
    const maxStepM = ((0.4 * 10) /* m/s */ * (SERVER_TICK_MS * 2)) / 1000;
    for (let i = 1; i < remoteXs.length; i++) {
      const d = remoteXs[i] - remoteXs[i - 1];
      expect(d).toBeGreaterThanOrEqual(-1e-9);
      expect(d).toBeLessThan(maxStepM);
    }

    // Không misprediction khi di chuyển tự do (điều kiện M4 vẫn giữ qua lớp ghép).
    const hud = session.hud(lb.now);
    expect(hud.corrections).toBe(0);
    expect(Number.isFinite(hud.rtt)).toBe(true);
    expect(hud.interpStarvedRatio).toBeLessThan(0.01);
  });

  it('hud trả số liệu gộp đủ trường trước và sau khi sync', () => {
    const lb = new SimLoopback(0);
    const session = makeSession(lb);

    const before = session.hud(lb.now);
    expect(before.predictedTick).toBeGreaterThanOrEqual(-1);
    expect(before.corrections).toBe(0);

    runTicks(lb, session, 20, IDLE);
    const after = session.hud(lb.now);
    expect(Number.isFinite(after.rtt)).toBe(true);
    expect(after.inputLead).toBeGreaterThanOrEqual(1);
    expect(after.lastSnapshotTick).toBeGreaterThan(0);
    expect(after.predictedTick).toBeGreaterThan(0);
  });
});
