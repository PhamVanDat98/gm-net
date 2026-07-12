/**
 * Nghiệm thu M8 ([006] §5, IMPLEMENTATION Phase 2): **rớt mạng 10s → quay lại
 * chơi tiếp không lỗi.**
 *
 * Socket thật + Colyseus thật + `netem-proxy.setOffline()` cắt dây giữa chừng.
 * Kiểm: client tự nối lại, giữ nguyên entityId, nhận keyframe resync, và điều
 * khiển được tiếp (vị trí đổi theo input sau khi nối lại). Player kia không hề
 * thấy entity của người rớt biến mất (grace period giữ entity trong world).
 */
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNetemProxy, type NetemProxy } from '@gm-net/netem-proxy';
import { FixedTimestep } from '@gm-net/core';
import { GameSession, connectGameRoom, connectReconnectingRoom } from '@gm-net/client';
import { initPhysics2D } from '@gm-net/physics-2d';
import { createGameServer, createSimulationGame } from '@gm-net/server';
import { SERVER_TICK_MS } from '@gm-net/shared';
import {
  BOX_ENTITY_TYPE,
  boxInputCodec,
  boxSim,
  canonicalBoxInput,
  createBoxWorld,
  type BoxInput,
  type BoxSnapshot,
  type BoxWorld,
} from '@gm-net/shared/box-sim';
import { DEMO_BOUNDS, DEMO_VMAX, MOVE_SPEED, SPAWN_POINTS, makeDemoCodec, quantization } from '../src/game.js';

const OUTAGE_MS = 10_000; // đúng bài nghiệm thu: rớt 10 giây
const GRACE_SECONDS = 30;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

type Server = ReturnType<typeof createGameServer>;
let server: Server;
/** Proxy riêng cho client sẽ bị cắt mạng — cắt dây của A không đụng B. */
let proxyA: NetemProxy;
let proxyB: NetemProxy;

beforeAll(async () => {
  await initPhysics2D();
  const serverPort = await freePort();
  const nextIds = new WeakMap<BoxWorld, number>();

  server = createGameServer({
    game: createSimulationGame(boxSim, {
      createWorld: (cfg) => createBoxWorld({ bounds: cfg.worldBounds, moveSpeed: MOVE_SPEED }),
      spawnPlayer: (world) => {
        const entityId = nextIds.get(world) ?? 1;
        nextIds.set(world, entityId + 1);
        const p = SPAWN_POINTS[(entityId - 1) % SPAWN_POINTS.length];
        boxSim.spawn(world, entityId, BOX_ENTITY_TYPE, { posX: p.x, posY: p.y, rot: 0, velX: 0, velY: 0 });
        return entityId;
      },
    }),
    config: {
      tickRate: 30,
      worldBounds: DEMO_BOUNDS,
      vMax: DEMO_VMAX,
      reconnectGraceSeconds: GRACE_SECONDS,
    },
    inputCodec: boxInputCodec,
  });
  await server.listen(serverPort);

  // Mạng "sạch" ở bài này: điều cần đo là reconnect, không phải loss.
  proxyA = createNetemProxy({ listenPort: 0, targetPort: serverPort, delayMs: 20, dropRate: 0 });
  proxyB = createNetemProxy({ listenPort: 0, targetPort: serverPort, delayMs: 20, dropRate: 0 });
  await proxyA.listen();
  await proxyB.listen();
}, 30_000);

afterAll(async () => {
  await proxyA?.close();
  await proxyB?.close();
  await server?.gracefullyShutdown(false);
});

describe('nghiệm thu M8 — rớt mạng 10s rồi quay lại', () => {
  it('client nối lại, giữ entityId, nhận keyframe resync và chơi tiếp được', async () => {
    let reconnected = false;
    let gaveUp: unknown;

    // A: transport tự nối lại (đường sẽ bị cắt).
    const a = await connectReconnectingRoom(`ws://127.0.0.1:${proxyA.port}`, {
      retryDelayMs: 500,
      maxRetryMs: 25_000,
      onReconnect: () => {
        reconnected = true;
      },
      onGiveUp: (err) => {
        gaveUp = err;
      },
    });
    const sessionA = new GameSession<BoxWorld, BoxInput, BoxSnapshot>(a.transport, {
      codec: makeDemoCodec(),
      quantization,
      sim: boxSim,
      world: createBoxWorld({ bounds: DEMO_BOUNDS, moveSpeed: MOVE_SPEED }),
    });
    sessionA.start();

    // B: người chơi bình thường — chứng nhân rằng entity của A không biến mất.
    const b = await connectGameRoom(`ws://127.0.0.1:${proxyB.port}`);
    const sessionB = new GameSession<BoxWorld, BoxInput, BoxSnapshot>(b.transport, {
      codec: makeDemoCodec(),
      quantization,
      sim: boxSim,
      world: createBoxWorld({ bounds: DEMO_BOUNDS, moveSpeed: MOVE_SPEED }),
    });
    sessionB.start();

    const stepA = new FixedTimestep({ stepMs: SERVER_TICK_MS });
    const stepB = new FixedTimestep({ stepMs: SERVER_TICK_MS });

    let cutAt = 0;
    let restoredAt = 0;
    let entityIdBefore = -1;
    let posBeforeCut = { x: 0, y: 0 };
    let keyframesBeforeCut = 0;
    let sawEntityADuringOutage = false;

    const t0 = Date.now();
    let last = t0;
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        const now = Date.now();
        const dt = now - last;
        last = now;
        const elapsed = now - t0;

        // A đi sang phải, B đứng yên.
        stepA.advance(dt, () => sessionA.tick(canonicalBoxInput(1, 0)));
        stepB.advance(dt, () => sessionB.tick(canonicalBoxInput(0, 0)));
        sessionA.getRenderState();
        sessionB.getRenderState();

        // t=2s: chụp mốc rồi CẮT DÂY của A.
        if (!cutAt && elapsed > 2_000) {
          entityIdBefore = sessionA.entityId;
          const local = sessionA.getRenderState().local;
          posBeforeCut = { x: local?.posX ?? 0, y: local?.posY ?? 0 };
          keyframesBeforeCut = sessionA.client.snapshotStats().keyframes;
          proxyA.setOffline(true);
          cutAt = now;
        }

        // Trong lúc A mất mạng: B vẫn phải thấy entity của A trong world (grace).
        if (cutAt && !restoredAt && elapsed > 4_000) {
          if (sessionB.getRenderState().remote.has(entityIdBefore)) sawEntityADuringOutage = true;
        }

        // Hết 10s: nối dây lại.
        if (cutAt && !restoredAt && now - cutAt >= OUTAGE_MS) {
          proxyA.setOffline(false);
          restoredAt = now;
        }

        // Chơi tiếp thêm 5s sau khi nối lại rồi kết thúc.
        if (restoredAt && now - restoredAt > 5_000) {
          clearInterval(timer);
          resolve();
        }
      }, 8);
    });

    const hudA = sessionA.hud();
    const localA = sessionA.getRenderState().local;

    expect(gaveUp).toBeUndefined();
    expect(reconnected).toBe(true);

    // Entity giữ nguyên qua reconnect (grace period, [006] §5).
    expect(sessionA.entityId).toBe(entityIdBefore);
    expect(sawEntityADuringOutage).toBe(true);

    // Resync bằng KEYFRAME: server reset baseline nên client nhận full snapshot mới.
    expect(sessionA.client.snapshotStats().keyframes).toBeGreaterThan(keyframesBeforeCut);

    // Chơi tiếp được: A vẫn đi sang phải sau khi nối lại (input được áp trở lại).
    expect(localA).toBeDefined();
    expect(localA!.posX).toBeGreaterThan(posBeforeCut.x + 0.5);

    // Đồng hồ/tick bắt nhịp lại (không kẹt ở timeline cũ).
    expect(hudA.rtt).toBeGreaterThan(0);
    expect(hudA.predictedTick).toBeGreaterThan(0);

    // B thấy A trở lại như thường.
    expect(sessionB.getRenderState().remote.has(entityIdBefore)).toBe(true);

    sessionA.leave();
    sessionB.leave();
    await new Promise((r) => setTimeout(r, 200));
  }, 60_000);
});
