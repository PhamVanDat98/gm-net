/**
 * demo-2d browser (IMPLEMENTATION 5.4–5.5): canvas 2D tối giản — local player
 * prediction + smoothing, remote interpolation ~100ms, HUD RTT/misprediction/
 * correction. Đồng thời là bài kiểm chứng rapier2d-compat chạy trong browser
 * (nửa còn lại của spike bước 2 tuần đầu — [008] §3).
 *
 * Nghiệm thu Phase 1: chạy server + proxy (RTT +200ms, drop 5%) rồi mở
 *   http://localhost:5173/?server=ws://localhost:2568
 */
import { FixedTimestep } from '@gm-net/core';
import { GameSession, connectGameRoom } from '@gm-net/client';
import { initPhysics2D } from '@gm-net/physics-2d';
import { SERVER_TICK_MS } from '@gm-net/shared';
import {
  boxSim,
  canonicalBoxInput,
  createBoxWorld,
  type BoxInput,
  type BoxSnapshot,
  type BoxWorld,
} from '@gm-net/shared/box-sim';
import { DEMO_BOUNDS, DEMO_PORT, MOVE_SPEED, makeDemoCodec, quantization } from './game.js';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const hudEl = document.getElementById('hud') as HTMLPreElement;

const WORLD_W = DEMO_BOUNDS.maxX - DEMO_BOUNDS.minX;
const WORLD_H = DEMO_BOUNDS.maxY - DEMO_BOUNDS.minY;
const SCALE = canvas.width / WORLD_W;
const HALF_EXTENT = 0.5;

function toScreen(x: number, y: number): [number, number] {
  return [(x - DEMO_BOUNDS.minX) * SCALE, (DEMO_BOUNDS.maxY - y) * SCALE];
}

// --- Input: WASD / phím mũi tên ---
const keys = new Set<string>();
addEventListener('keydown', (e) => keys.add(e.code));
addEventListener('keyup', (e) => keys.delete(e.code));

function sampleInput(): BoxInput {
  const x = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  const y = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  const len = Math.hypot(x, y);
  // Chuẩn hóa chéo (không nhanh hơn đi thẳng) + canonical (bản server sẽ decode).
  return len > 1 ? canonicalBoxInput(x / len, y / len) : canonicalBoxInput(x, y);
}

function drawBox(x: number, y: number, rot: number, fill: string, stroke?: string): void {
  const [sx, sy] = toScreen(x, y);
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(-rot);
  const s = HALF_EXTENT * SCALE;
  ctx.fillStyle = fill;
  ctx.fillRect(-s, -s, 2 * s, 2 * s);
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.strokeRect(-s, -s, 2 * s, 2 * s);
  }
  ctx.restore();
}

function fmt(v: number, digits = 1): string {
  return Number.isFinite(v) ? v.toFixed(digits) : '—';
}

async function start(): Promise<void> {
  hudEl.textContent = 'Đang nạp Rapier WASM…';
  await initPhysics2D(); // kiểm chứng rapier2d-compat trong browser (5.5)

  const endpoint =
    new URLSearchParams(location.search).get('server') ?? `ws://${location.hostname}:${DEMO_PORT}`;
  hudEl.textContent = `Đang kết nối ${endpoint}…`;
  const { transport, room } = await connectGameRoom(endpoint);

  const session = new GameSession<BoxWorld, BoxInput, BoxSnapshot>(transport, {
    codec: makeDemoCodec(),
    quantization,
    sim: boxSim,
    world: createBoxWorld({ bounds: DEMO_BOUNDS, moveSpeed: MOVE_SPEED }),
  });
  session.start();

  const timestep = new FixedTimestep({ stepMs: SERVER_TICK_MS });
  let lastFrame = performance.now();

  function frame(nowFrame: number): void {
    const dt = nowFrame - lastFrame;
    lastFrame = nowFrame;

    // Sim 30Hz tách khỏi render 60Hz ([004] §1).
    timestep.advance(dt, () => session.tick(sampleInput()));

    const rs = session.getRenderState();

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#334';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, WORLD_W * SCALE, WORLD_H * SCALE);

    for (const [, e] of rs.remote) {
      // Remote: cam; freeze (mất dữ liệu quá cap extrapolate) → xám.
      drawBox(e.posX, e.posY, e.rot, e.mode === 'freeze' ? '#666a75' : '#e8863a');
    }
    if (rs.local) drawBox(rs.local.posX, rs.local.posY, rs.local.rot, '#3fb950', '#eafbe7');

    const h = session.hud();
    hudEl.textContent = [
      `server        ${endpoint}  (session ${room.sessionId}, entity ${session.entityId})`,
      `rtt           ${fmt(h.rtt, 0)} ms   jitter ${fmt(h.jitter)} ms   input lead ${h.inputLead} tick   pending ${h.pendingInputs}`,
      `misprediction ${fmt(h.correctionsPerSecond)}/s   tổng ${h.corrections}   biên độ cuối ${fmt(h.lastCorrectionMagnitude, 3)} m`,
      `interp        delay ${fmt(h.interpDelayMs, 0)} ms   buffer cạn ${fmt(h.interpStarvedRatio * 100, 2)}%   remote ${rs.remote.size}`,
      `tick          server ${h.lastSnapshotTick}   predicted ${h.predictedTick}`,
      `di chuyển: WASD / phím mũi tên`,
    ].join('\n');

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

start().catch((err) => {
  hudEl.textContent = `Lỗi: ${err instanceof Error ? err.message : String(err)}\n(server đã chạy chưa? pnpm --filter demo-2d server)`;
});
