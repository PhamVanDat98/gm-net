/**
 * Load test N bot/room ([006] §7, M11) — nghiệm thu: **50 bot/room ổn định**.
 *
 * Chạy: `pnpm --filter demo-2d loadtest [bots] [seconds] [--proxy]`
 *   vd: `pnpm --filter demo-2d loadtest 50 20 --proxy`
 *
 * Dựng server thật + N {@link HeadlessBot} (mỗi bot = một GameSession đầy đủ:
 * prediction + reconciliation + interpolation, chỉ không render). Đo phía server
 * **tick p50/p99** + **bandwidth/client**, phía bot đếm correction + buffer cạn.
 *
 * Lưu ý đọc số: server và bot chạy CHUNG một process Node, nên CPU của 50 bot
 * (50 world Rapier!) cũng ăn vào cùng máy — tick p99 đo được là **cận trên bi
 * quan**. Production chỉ chạy phần server.
 */
import net from 'node:net';
import { createNetemProxy } from '@gm-net/netem-proxy';
import { HeadlessBot, GameSession, connectGameRoom } from '@gm-net/client';
import { initPhysics2D } from '@gm-net/physics-2d';
import { createGameServer, createSimulationGame, type RoomMetrics } from '@gm-net/server';
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
import { DEMO_BOUNDS, DEMO_VMAX, MOVE_SPEED, SPAWN_POINTS, makeDemoCodec, quantization } from './game.js';

export interface LoadTestOptions {
  bots: number;
  seconds: number;
  /** Cho traffic đi qua netem-proxy (delay/loss) thay vì nối thẳng. */
  proxy?: { delayMs: number; dropRate: number };
  /** AOI bán kính (bỏ trống → tắt AOI, mọi bot thấy nhau). */
  aoiRadius?: number;
  onSample?: (m: RoomMetrics) => void;
}

export interface LoadTestResult {
  bots: number;
  seconds: number;
  /** Lát cắt metrics cuối cùng của room. */
  server: RoomMetrics;
  /** Tick p99 lớn nhất quan sát được trong suốt phiên (cái đáng lo, không phải trung bình). */
  worstTickP99: number;
  /** Tổng correction (misprediction) của mọi bot / giây. */
  correctionsPerSecond: number;
  /** Tỉ lệ buffer interpolation cạn lớn nhất trong các bot. */
  worstStarvedRatio: number;
  /** RTT trung bình các bot (ms). */
  avgRtt: number;
  /** Số tick sim trung bình mỗi bot chạy được (kỳ vọng ≈ 30 × seconds). */
  avgBotTicks: number;
}

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

export async function runLoadTest(opts: LoadTestOptions): Promise<LoadTestResult> {
  await initPhysics2D();

  const samples: RoomMetrics[] = [];
  const serverPort = await freePort();
  const nextIds = new WeakMap<BoxWorld, number>();

  const server = createGameServer({
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
      aoi: opts.aoiRadius ? { radius: opts.aoiRadius } : undefined,
      onMetrics: (m) => {
        samples.push(m);
        opts.onSample?.(m);
      },
    },
    inputCodec: boxInputCodec,
  });
  await server.listen(serverPort);

  const proxy = opts.proxy
    ? createNetemProxy({
        listenPort: 0,
        targetPort: serverPort,
        delayMs: opts.proxy.delayMs,
        dropRate: opts.proxy.dropRate,
        graceMs: 1500,
        seed: 7,
      })
    : undefined;
  const port = proxy ? await proxy.listen() : serverPort;

  // Bot vào room lần lượt (join dồn một lượt làm nghẽn matchmaking, không phải
  // thứ ta muốn đo).
  const bots: Array<HeadlessBot<BoxWorld, BoxInput, BoxSnapshot>> = [];
  const rooms: Array<{ leave: () => void }> = [];
  for (let i = 0; i < opts.bots; i++) {
    const { transport, room } = await connectGameRoom(`ws://127.0.0.1:${port}`);
    const session = new GameSession<BoxWorld, BoxInput, BoxSnapshot>(transport, {
      codec: makeDemoCodec(),
      quantization,
      sim: boxSim,
      world: createBoxWorld({ bounds: DEMO_BOUNDS, moveSpeed: MOVE_SPEED }),
    });
    // Mỗi bot lượn vòng tròn với pha riêng — traffic đều, không va chạm nhau.
    const phase = (i / opts.bots) * Math.PI * 2;
    const bot = new HeadlessBot<BoxWorld, BoxInput, BoxSnapshot>(session, {
      input: ({ elapsedMs }) => {
        const w = (2 * Math.PI) / 2000;
        return canonicalBoxInput(Math.cos(phase + w * elapsedMs) * 0.8, Math.sin(phase + w * elapsedMs) * 0.8);
      },
    });
    bots.push(bot);
    rooms.push({ leave: () => void room.leave() });
    bot.start();
    await new Promise((r) => setTimeout(r, 20));
  }

  await new Promise((r) => setTimeout(r, opts.seconds * 1000));

  const huds = bots.map((b) => b.session.hud());
  const result: LoadTestResult = {
    bots: opts.bots,
    seconds: opts.seconds,
    server: samples[samples.length - 1] ?? {
      tick: 0,
      clients: 0,
      tickMs: { p50: NaN, p99: NaN, max: NaN },
      bytesSent: 0,
      bytesPerClientPerSecond: 0,
      keyframes: 0,
      deltas: 0,
    },
    // Bỏ mẫu đầu (lúc bot còn đang join dồn) — đo trạng thái ổn định.
    worstTickP99: Math.max(...samples.slice(1).map((s) => s.tickMs.p99), 0),
    correctionsPerSecond: huds.reduce((sum, h) => sum + h.correctionsPerSecond, 0),
    worstStarvedRatio: Math.max(...huds.map((h) => h.interpStarvedRatio), 0),
    avgRtt: huds.reduce((sum, h) => sum + h.rtt, 0) / Math.max(1, huds.length),
    avgBotTicks: bots.reduce((sum, b) => sum + b.ticks, 0) / Math.max(1, bots.length),
  };

  for (const bot of bots) bot.stop();
  for (const r of rooms) r.leave();
  await new Promise((r) => setTimeout(r, 200));
  await proxy?.close();
  await server.gracefullyShutdown(false);

  return result;
}

async function main(): Promise<void> {
  const bots = Number(process.argv[2] ?? 50);
  const seconds = Number(process.argv[3] ?? 20);
  const useProxy = process.argv.includes('--proxy');
  const aoiArg = process.argv.find((a) => a.startsWith('--aoi='));
  const aoiRadius = aoiArg ? Number(aoiArg.slice('--aoi='.length)) : undefined;

  console.log(
    `[loadtest] ${bots} bot × ${seconds}s${useProxy ? ' qua proxy 200ms/5%' : ' (nối thẳng)'}` +
      `${aoiRadius ? `, AOI r=${aoiRadius}` : ', AOI tắt'}…`,
  );
  const r = await runLoadTest({
    bots,
    seconds,
    aoiRadius,
    proxy: useProxy ? { delayMs: 100, dropRate: 0.05 } : undefined,
  });

  console.log(`\n=== Kết quả (${r.bots} bot, ${r.seconds}s) ===`);
  console.log(`server tick p50/p99/max : ${r.server.tickMs.p50.toFixed(2)} / ${r.server.tickMs.p99.toFixed(2)} / ${r.server.tickMs.max.toFixed(2)} ms  (ngân sách 33.3ms)`);
  console.log(`tick p99 xấu nhất       : ${r.worstTickP99.toFixed(2)} ms`);
  console.log(`bandwidth/client        : ${r.server.bytesPerClientPerSecond.toFixed(0)} B/s`);
  console.log(`keyframe / delta        : ${r.server.keyframes} / ${r.server.deltas}`);
  console.log(`RTT trung bình          : ${r.avgRtt.toFixed(0)} ms`);
  console.log(`correction/s (tổng bot) : ${r.correctionsPerSecond.toFixed(2)}`);
  console.log(`buffer cạn (xấu nhất)   : ${(r.worstStarvedRatio * 100).toFixed(2)}%`);
  console.log(`tick sim/bot (kỳ vọng ${30 * r.seconds}) : ${r.avgBotTicks.toFixed(0)}`);
  process.exit(0);
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('src/loadtest.ts')) {
  await main();
}
