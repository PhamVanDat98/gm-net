/**
 * M6 — Benchmark snapshot ([008 §4](../../../docs/design/008-roadmap.md)).
 *
 * Trả lời quyết định 5 ([003](../../../docs/design/003-tech-stack.md)): giữ ring buffer
 * `takeSnapshot()` cả world, hay chuyển sang snapshot thủ công các dynamic body quan trọng?
 *
 * Đo trên world N dynamic body **đang va chạm** (đống bóng rơi vào hộp kín — có contact,
 * warm-start solver, không body nào ngủ):
 *   (a) `takeSnapshot()`  — ms + size bytes
 *   (b) `restoreSnapshot()` — ms
 *   (c) restore + replay `replayTicks` bước — ms (tình huống reconciliation RTT 200ms
 *       ⇒ ~7 tick @30Hz, [004 §5](../../../docs/design/004-netcode.md))
 *
 * Ngưỡng quan tâm: ring 30 slot chiếm bao nhiêu MB, và (c) có lọt ngân sách 1 frame
 * client (~16ms) không.
 */
import { initPhysics2D, RAPIER } from '../src/index.js';

export interface BenchOptions {
  /** Số dynamic body trong world. */
  bodies: number;
  /** Số tick replay sau restore (mặc định 7 ≈ RTT 200ms @30Hz). */
  replayTicks?: number;
  /** Số lần lặp mỗi phép đo (mặc định 30 — bằng số slot ring 1s). */
  samples?: number;
  /** Số tick chạy trước khi đo, để world có contact thật (mặc định 90). */
  warmupTicks?: number;
  /** Số vòng đo bỏ đi trước khi tính giờ — loại nhiễu JIT/alloc lần đầu (mặc định 3). */
  warmupSamples?: number;
  /** Số slot ring buffer để quy ra dung lượng bộ nhớ (mặc định 30 ≈ 1s @30Hz). */
  ringSlots?: number;
}

export interface Timing {
  meanMs: number;
  p99Ms: number;
  maxMs: number;
}

export interface BenchResult {
  bodies: number;
  replayTicks: number;
  samples: number;
  /** Số contact pair đang hoạt động lúc đo — bằng chứng world thật sự va chạm. */
  contactPairs: number;
  snapshotBytes: number;
  /** `snapshotBytes × ringSlots`, quy ra MB. */
  ringMB: number;
  takeSnapshot: Timing;
  restore: Timing;
  /** restore + replay `replayTicks` bước (đường đi nóng của reconciliation). */
  restoreReplay: Timing;
  /** Chỉ step, không snapshot — mốc so sánh để thấy overhead của snapshot. */
  step: Timing;
}

function summarize(samplesMs: number[]): Timing {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  // p99 kiểu nearest-rank: với n mẫu nhỏ (30) rơi vào phần tử cuối — chấp nhận được,
  // đây là chỉ số "xấu nhất thường gặp", không phải thống kê chặt chẽ.
  const idx = Math.min(sorted.length - 1, Math.ceil(0.99 * sorted.length) - 1);
  return {
    meanMs: sum / sorted.length,
    p99Ms: sorted[Math.max(0, idx)],
    maxMs: sorted[sorted.length - 1],
  };
}

/** World kín: sàn + 4 tường, N quả bóng dynamic rơi chồng lên nhau → contact liên tục. */
function createCollidingWorld(bodies: number): InstanceType<typeof RAPIER.World> {
  const world = new RAPIER.World({ x: 0, y: -9.81 });

  const halfWidth = 20;
  const halfHeight = 20;
  world.createCollider(RAPIER.ColliderDesc.cuboid(halfWidth, 0.5).setTranslation(0, -0.5));
  world.createCollider(RAPIER.ColliderDesc.cuboid(halfWidth, 0.5).setTranslation(0, 2 * halfHeight));
  world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, halfHeight).setTranslation(-halfWidth, halfHeight));
  world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, halfHeight).setTranslation(halfWidth, halfHeight));

  // Lưới bóng r=0.5, cách nhau 1.1 → rơi xuống là chạm nhau ngay.
  const perRow = Math.ceil(Math.sqrt(bodies));
  const radius = 0.5;
  const spacing = 1.1;
  for (let i = 0; i < bodies; i++) {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    const x = (col - perRow / 2) * spacing;
    const y = 1 + row * spacing;
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, y)
        // Body ngủ = physics rẻ đi một cách giả tạo; giữ chúng thức để đo trường hợp xấu.
        .setCanSleep(false),
    );
    world.createCollider(RAPIER.ColliderDesc.ball(radius).setRestitution(0.3), body);
  }
  return world;
}

function countContactPairs(world: InstanceType<typeof RAPIER.World>): number {
  let pairs = 0;
  world.forEachCollider((collider) => {
    world.narrowPhase.contactPairsWith(collider.handle, () => {
      pairs++;
    });
  });
  return pairs / 2; // mỗi cặp đếm hai lần (một lần cho mỗi collider)
}

export async function benchSnapshot(options: BenchOptions): Promise<BenchResult> {
  await initPhysics2D();
  const {
    bodies,
    replayTicks = 7,
    samples = 30,
    warmupTicks = 90,
    warmupSamples = 3,
    ringSlots = 30,
  } = options;

  const world = createCollidingWorld(bodies);
  for (let i = 0; i < warmupTicks; i++) world.step();

  const contactPairs = countContactPairs(world);

  const takeMs: number[] = [];
  const restoreMs: number[] = [];
  const replayMs: number[] = [];
  const stepMs: number[] = [];

  let snapshot = world.takeSnapshot();
  const snapshotBytes = snapshot.byteLength;

  // Vòng warm-up: chạy đúng đường đi sẽ đo nhưng bỏ kết quả — nếu không, mẫu đầu tiên
  // gánh chi phí JIT + cấp phát WASM lần đầu và thổi p99 lên gấp chục lần.
  for (let i = 0; i < warmupSamples; i++) {
    const w = RAPIER.World.restoreSnapshot(world.takeSnapshot());
    for (let k = 0; k < replayTicks; k++) w.step();
    w.free();
  }

  for (let i = 0; i < samples; i++) {
    // (a) takeSnapshot — đo trên world đang chạy tiếp, mỗi mẫu một tick (như tick loop thật).
    world.step();
    let t = performance.now();
    snapshot = world.takeSnapshot();
    takeMs.push(performance.now() - t);

    // (b) restoreSnapshot
    t = performance.now();
    const restored = RAPIER.World.restoreSnapshot(snapshot);
    restoreMs.push(performance.now() - t);

    // (c) restore + replay N tick — đúng đường đi của reconciliation.
    t = performance.now();
    const replayed = RAPIER.World.restoreSnapshot(snapshot);
    for (let k = 0; k < replayTicks; k++) replayed.step();
    replayMs.push(performance.now() - t);

    // Mốc so sánh: chi phí step thuần trên world tương đương.
    t = performance.now();
    restored.step();
    stepMs.push(performance.now() - t);

    restored.free();
    replayed.free();
  }

  world.free();

  return {
    bodies,
    replayTicks,
    samples,
    contactPairs,
    snapshotBytes,
    ringMB: (snapshotBytes * ringSlots) / (1024 * 1024),
    takeSnapshot: summarize(takeMs),
    restore: summarize(restoreMs),
    restoreReplay: summarize(replayMs),
    step: summarize(stepMs),
  };
}

const FRAME_BUDGET_MS = 16; // 1 frame client @60Hz

function fmt(n: number, digits = 2): string {
  return n.toFixed(digits);
}

/** In bảng markdown dán thẳng vào doc 003 (quyết định 5). */
export function formatMarkdown(results: BenchResult[]): string {
  const lines = [
    `| Bodies | Contact pairs | Snapshot size | Ring 30 slot | takeSnapshot (mean/p99) | restore (mean/p99) | restore+replay 7 tick (mean/p99) | step thuần (mean) |`,
    `|---|---|---|---|---|---|---|---|`,
  ];
  for (const r of results) {
    lines.push(
      `| ${r.bodies} | ${r.contactPairs} | ${(r.snapshotBytes / 1024).toFixed(1)} KB | ` +
        `${fmt(r.ringMB)} MB | ${fmt(r.takeSnapshot.meanMs)} / ${fmt(r.takeSnapshot.p99Ms)} ms | ` +
        `${fmt(r.restore.meanMs)} / ${fmt(r.restore.p99Ms)} ms | ` +
        `${fmt(r.restoreReplay.meanMs)} / ${fmt(r.restoreReplay.p99Ms)} ms | ` +
        `${fmt(r.step.meanMs)} ms |`,
    );
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const counts = process.argv[2] ? process.argv[2].split(',').map(Number) : [50, 200, 500];
  const results: BenchResult[] = [];
  for (const bodies of counts) {
    const r = await benchSnapshot({ bodies });
    results.push(r);
    const verdict = r.restoreReplay.p99Ms < FRAME_BUDGET_MS ? 'lọt' : 'KHÔNG lọt';
    console.log(
      `${String(bodies).padStart(4)} bodies: snapshot ${(r.snapshotBytes / 1024).toFixed(1)} KB, ` +
        `ring30 ${fmt(r.ringMB)} MB, take ${fmt(r.takeSnapshot.meanMs)}ms, restore ${fmt(r.restore.meanMs)}ms, ` +
        `restore+replay7 p99 ${fmt(r.restoreReplay.p99Ms)}ms (${verdict} ngân sách ${FRAME_BUDGET_MS}ms)`,
    );
  }
  console.log(`\nNode ${process.version} — ${process.platform}/${process.arch}\n`);
  console.log(formatMarkdown(results));
}

// Chạy main chỉ khi gọi trực tiếp (`tsx bench/snapshot-bench.ts`), không khi import từ test.
if (process.argv[1]?.replace(/\\/g, '/').endsWith('bench/snapshot-bench.ts')) {
  await main();
}
