/**
 * Nghiệm thu Phase 1 ([docs/design/008-roadmap.md] §1, IMPLEMENTATION M5):
 * server Colyseus thật + netem-proxy 200ms RTT + 5% loss + 2 client headless
 * (GameSession đầy đủ prediction/reconciliation/interpolation qua socket thật).
 *
 * Tiêu chí đo được:
 * - Local: misprediction/s ~0 khi di chuyển tự do (không va chạm).
 * - Remote: không teleport/rubber-band (bước nhảy giữa hai frame render < 1m),
 *   buffer interpolation cạn < 1%.
 *
 * Test chạy thời gian thật (~12s) — timeout nới rộng.
 */
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNetemProxy, type NetemProxy } from '@gm-net/netem-proxy';
import { FixedTimestep } from '@gm-net/core';
import { GameSession, connectGameRoom } from '@gm-net/client';
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

const RUN_MS = 12_000;
const WARMUP_MS = 4_000;

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
let proxy: NetemProxy;
let proxyPort: number;

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
    config: { tickRate: 30, worldBounds: DEMO_BOUNDS, vMax: DEMO_VMAX },
    inputCodec: boxInputCodec,
  });
  await server.listen(serverPort);

  // Bài nghiệm thu [CHỐT]: RTT giả lập 200ms (100ms/chiều) + 5% loss.
  proxy = createNetemProxy({
    listenPort: 0,
    targetPort: serverPort,
    delayMs: 100,
    dropRate: 0.05,
    graceMs: 1500, // join/handshake đi kênh reliable — không thuộc bài loss
    seed: 7,
  });
  proxyPort = await proxy.listen();
}, 30_000);

afterAll(async () => {
  await proxy?.close();
  await server?.gracefullyShutdown(false);
});

interface HeadlessClient {
  session: GameSession<BoxWorld, BoxInput, BoxSnapshot>;
  timestep: FixedTimestep;
  leave: () => void;
  /** Bước nhảy vị trí remote lớn nhất giữa hai frame liên tiếp (sau warmup). */
  maxRemoteJump: number;
  /** Số correction tại mốc hết warmup (trừ đi khỏi tổng cuối). */
  warmupCorrections: number;
  lastRemote: Map<number, { x: number; y: number }>;
}

async function joinHeadless(): Promise<HeadlessClient> {
  const { transport, room } = await connectGameRoom(`ws://127.0.0.1:${proxyPort}`);
  const session = new GameSession<BoxWorld, BoxInput, BoxSnapshot>(transport, {
    codec: makeDemoCodec(),
    quantization,
    sim: boxSim,
    world: createBoxWorld({ bounds: DEMO_BOUNDS, moveSpeed: MOVE_SPEED }),
  });
  session.start();
  return {
    session,
    timestep: new FixedTimestep({ stepMs: SERVER_TICK_MS }),
    leave: () => {
      session.leave();
      void room.leave();
    },
    maxRemoteJump: 0,
    warmupCorrections: 0,
    lastRemote: new Map(),
  };
}

describe('nghiệm thu Phase 1 — demo qua proxy 200ms RTT + 5% loss', () => {
  it('local không giật (misprediction/s ~0), remote mượt (không teleport, buffer cạn <1%)', async () => {
    const a = await joinHeadless();
    const b = await joinHeadless();
    const clients = [a, b];

    // Mỗi client lượn vòng tròn quanh chỗ spawn (không va chạm nhau/tường).
    const inputAt = (phase: number, tMs: number): BoxInput => {
      const w = (2 * Math.PI) / 2000; // chu kỳ 2s
      return canonicalBoxInput(Math.cos(phase + w * tMs) * 0.8, Math.sin(phase + w * tMs) * 0.8);
    };

    const t0 = Date.now();
    let lastLoop = t0;
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        const now = Date.now();
        const dt = now - lastLoop;
        lastLoop = now;
        const elapsed = now - t0;

        clients.forEach((c, i) => {
          // Sim 30Hz qua accumulator (timer Windows ~15ms không đều).
          c.timestep.advance(dt, () => c.session.tick(inputAt(i * Math.PI, elapsed)));

          // "Frame render": đo độ mượt remote sau warmup.
          const rs = c.session.getRenderState();
          if (elapsed > WARMUP_MS) {
            for (const [id, e] of rs.remote) {
              const prev = c.lastRemote.get(id);
              if (prev) {
                c.maxRemoteJump = Math.max(c.maxRemoteJump, Math.hypot(e.posX - prev.x, e.posY - prev.y));
              }
              c.lastRemote.set(id, { x: e.posX, y: e.posY });
            }
          }
        });

        if (elapsed >= WARMUP_MS && a.warmupCorrections === 0 && b.warmupCorrections === 0) {
          a.warmupCorrections = a.session.metrics.corrections;
          b.warmupCorrections = b.session.metrics.corrections;
        }
        if (elapsed >= RUN_MS) {
          clearInterval(timer);
          resolve();
        }
      }, 8);
    });

    const measuredSec = (RUN_MS - WARMUP_MS) / 1000;
    for (const c of clients) {
      const hud = c.session.hud();

      // Kết nối qua proxy thật sự chịu RTT ~200ms.
      expect(hud.rtt).toBeGreaterThanOrEqual(180);
      expect(hud.rtt).toBeLessThan(400);

      // Hai người chơi thấy nhau.
      expect(c.lastRemote.size).toBeGreaterThanOrEqual(1);

      // Local: misprediction/s ~0 khi di chuyển tự do (cho phép nhiễu hiếm do
      // input muộn lúc adaptive lead đang chỉnh — trung bình < 0.5/s).
      const corrections = c.session.metrics.corrections - c.warmupCorrections;
      expect(corrections / measuredSec).toBeLessThan(0.5);

      // Remote: không teleport/rubber-band — bước nhảy giữa hai frame < 1m
      // (di chuyển thật ~8 m/s × 33ms ≈ 0.27m/tick; teleport là nhiều mét).
      expect(c.maxRemoteJump).toBeGreaterThan(0); // remote thật sự chuyển động
      expect(c.maxRemoteJump).toBeLessThan(1);

      // Buffer interpolation cạn < 1%.
      expect(hud.interpStarvedRatio).toBeLessThan(0.01);
    }

    a.leave();
    b.leave();
    // Cho room dispose trước khi shutdown.
    await new Promise((r) => setTimeout(r, 200));
  }, 60_000);
});
