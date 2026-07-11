/**
 * Interpolation buffer cho remote entities ([docs/design/004-netcode.md] §6,
 * IMPLEMENTATION 5.1): remote render trễ ~100ms bằng nội suy giữa hai snapshot
 * kẹp `renderTick`. Thiếu snapshot (loss/jitter làm buffer cạn) → extrapolate
 * tối đa ~2 tick từ velocity cuối, quá nữa thì freeze — không bao giờ
 * extrapolate xa vì sai còn xấu hơn đứng. Delay adaptive: cạn buffer → tăng
 * (tối đa ~200ms), mạng sạch kéo dần về 100ms; mọi thay đổi delay trượt từ từ
 * (vài ms mỗi frame) để không thấy time-warp.
 *
 * **Đồng hồ render neo theo dòng snapshot** (stream clock), không theo
 * `ClockSync.serverTickNow`: ước lượng của ClockSync đứng ở "hiện tại server"
 * (+RTT/2), nếu trừ delay 100ms thì RTT 200ms đã cạn buffer vĩnh viễn — trong
 * khi thứ interpolation cần là "tick mới nhất đã VỀ TỚI client" trôi đều theo
 * thời gian thực. Vì vậy: `streamTick(now) = now/tickMs + offset`, `offset`
 * bám max (gói ít bị trễ nhất) và rỉ chậm xuống để hấp thụ drift.
 *
 * Thuần logic + đồng hồ truyền vào (ms) — test bằng đồng hồ ảo, không DOM.
 */
import type { Snapshot, SnapshotEntity } from '@gm-net/core';
import { SERVER_TICK_MS, type EntityTransform } from '@gm-net/shared';

export interface InterpolationOptions {
  /** Độ dài tick (ms). Mặc định `SERVER_TICK_MS`. */
  tickMs?: number;
  /** Delay render tối thiểu / khởi điểm (ms). Mặc định 100. */
  minDelayMs?: number;
  /** Delay render tối đa khi mạng xấu (ms). Mặc định 200. */
  maxDelayMs?: number;
  /** Số tick extrapolate tối đa khi thiếu snapshot. Mặc định 2. */
  extrapolateMaxTicks?: number;
  /** Tốc độ trượt delay hiệu dụng về target (ms delay / s thực). Mặc định 100 (~1.7ms/frame @60fps). */
  slewPerSecond?: number;
  /** Mỗi lần buffer cạn, target delay cộng thêm (ms). Mặc định 15. */
  starveBumpMs?: number;
  /** Tốc độ target delay rỉ về min khi mạng sạch (ms delay / s thực). Mặc định 2. */
  decayPerSecond?: number;
  /** Số tick lịch sử giữ per entity (~2s). Mặc định 64. */
  historyTicks?: number;
  /** Entity vắng mặt khỏi snapshot quá N tick coi như despawn. Mặc định 2. */
  despawnGraceTicks?: number;
}

/** Một mẫu transform tại một tick (từ snapshot). */
interface Sample extends EntityTransform {
  tick: number;
}

interface Track {
  entityId: number;
  entityType: number;
  /** Mẫu theo tick tăng dần (append-only, prune đầu). */
  samples: Sample[];
}

/** Transform nội suy + cách thu được (HUD/debug/test). */
export interface InterpolatedEntity extends EntityTransform {
  entityId: number;
  entityType: number;
  /** `interp` = kẹp giữa 2 mẫu; `extrapolate` = quá mẫu cuối ≤ cap; `freeze` = quá cap, đứng yên; `old` = renderTick trước mẫu đầu. */
  mode: 'interp' | 'extrapolate' | 'freeze' | 'old';
}

export interface InterpolationStats {
  /** Delay hiệu dụng hiện tại (ms). */
  delayMs: number;
  /** Delay đích adaptive đang trượt tới (ms). */
  targetDelayMs: number;
  /** Số lần sample() rơi vào trạng thái buffer cạn (stream chưa có dữ liệu tại renderTick). */
  starvedSamples: number;
  /** Tổng số lần sample() có ít nhất một entity. */
  totalSamples: number;
  /** Tỉ lệ cạn tích lũy [0,1] — tiêu chí 008 §1: < 1%. */
  starvedRatio: number;
}

const TWO_PI = Math.PI * 2;

/** Hiệu góc ngắn nhất `b - a` trong (-π, π]. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d <= -Math.PI) d += TWO_PI;
  return d;
}

function lerpSample(a: Sample, b: Sample, alpha: number): EntityTransform {
  return {
    posX: a.posX + (b.posX - a.posX) * alpha,
    posY: a.posY + (b.posY - a.posY) * alpha,
    rot: a.rot + angleDelta(a.rot, b.rot) * alpha,
    velX: a.velX + (b.velX - a.velX) * alpha,
    velY: a.velY + (b.velY - a.velY) * alpha,
  };
}

export class InterpolationBuffer {
  private readonly tickMs: number;
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly extrapolateMaxTicks: number;
  private readonly slewPerSecond: number;
  private readonly starveBumpMs: number;
  private readonly decayPerSecond: number;
  private readonly historyTicks: number;
  private readonly despawnGraceTicks: number;

  private readonly tracks = new Map<number, Track>();
  /** Tick snapshot mới nhất đã nạp; -1 = chưa có. */
  private newestTick = -1;
  /** Offset stream clock (tick − now/tickMs); NaN = chưa neo. */
  private offset = Number.NaN;

  private delayMs: number;
  private targetDelayMs: number;
  private lastSampleAt = Number.NaN;

  private starved = 0;
  private total = 0;

  constructor(opts: InterpolationOptions = {}) {
    this.tickMs = opts.tickMs ?? SERVER_TICK_MS;
    this.minDelayMs = opts.minDelayMs ?? 100;
    this.maxDelayMs = opts.maxDelayMs ?? 200;
    this.extrapolateMaxTicks = opts.extrapolateMaxTicks ?? 2;
    this.slewPerSecond = opts.slewPerSecond ?? 100;
    this.starveBumpMs = opts.starveBumpMs ?? 15;
    this.decayPerSecond = opts.decayPerSecond ?? 2;
    this.historyTicks = opts.historyTicks ?? 64;
    this.despawnGraceTicks = opts.despawnGraceTicks ?? 2;
    this.delayMs = this.minDelayMs;
    this.targetDelayMs = this.minDelayMs;
  }

  /** Đã có dữ liệu để render chưa. */
  get hasData(): boolean {
    return this.newestTick >= 0;
  }

  /**
   * Nạp một snapshot nhận lúc `now` (ms). `exclude` (thường local entity —
   * local đi đường prediction, không interpolation) bị bỏ qua. Snapshot cũ hơn
   * bản đã có → bỏ (SnapshotReceiver đã chặn, đây là phòng thủ thêm).
   */
  push(snap: Snapshot, now: number, exclude?: number): void {
    if (snap.serverTick <= this.newestTick) return;
    this.newestTick = snap.serverTick;

    // Stream clock: bám gói ít bị trễ nhất (max), rỉ chậm xuống hấp thụ drift.
    const cand = snap.serverTick - now / this.tickMs;
    this.offset = Number.isNaN(this.offset) ? cand : cand > this.offset ? cand : this.offset + (cand - this.offset) * 0.02;

    for (const e of snap.entities) {
      if (e.entityId === exclude) continue;
      this.pushEntity(e, snap.serverTick);
    }
  }

  /** Tick render (số thực) tại thời điểm `now`; NaN khi chưa có snapshot. */
  renderTick(now: number): number {
    if (Number.isNaN(this.offset)) return Number.NaN;
    return now / this.tickMs + this.offset - this.delayMs / this.tickMs;
  }

  /**
   * Nội suy toàn bộ remote entity tại thời điểm `now` (gọi mỗi frame render).
   * Đồng thời cập nhật adaptive delay (trượt dần) và thống kê buffer cạn.
   */
  sample(now: number): Map<number, InterpolatedEntity> {
    const out = new Map<number, InterpolatedEntity>();
    const dtMs = Number.isNaN(this.lastSampleAt) ? 0 : Math.max(0, now - this.lastSampleAt);
    this.lastSampleAt = now;

    const rt = this.renderTick(now);
    if (Number.isNaN(rt)) return out;

    // Buffer cạn ở mức stream: render time đã vượt dữ liệu mới nhất đã về.
    const starvedNow = this.tracks.size > 0 && rt > this.newestTick;
    if (this.tracks.size > 0) {
      this.total++;
      if (starvedNow) {
        this.starved++;
        this.targetDelayMs = Math.min(this.maxDelayMs, this.targetDelayMs + this.starveBumpMs);
      }
    }
    if (!starvedNow) {
      this.targetDelayMs = Math.max(this.minDelayMs, this.targetDelayMs - (this.decayPerSecond * dtMs) / 1000);
    }
    // Delay hiệu dụng trượt về target vài ms mỗi frame — không time-warp.
    const maxStep = (this.slewPerSecond * dtMs) / 1000;
    const diff = this.targetDelayMs - this.delayMs;
    this.delayMs += Math.abs(diff) <= maxStep ? diff : Math.sign(diff) * maxStep;

    for (const [entityId, track] of this.tracks) {
      const last = track.samples[track.samples.length - 1];
      // Despawn: server vẫn phát snapshot (stream sống) mà entity vắng mặt —
      // gỡ track khi render time đã đi qua hết lịch sử của nó.
      if (this.newestTick - last.tick > this.despawnGraceTicks && rt > last.tick + this.extrapolateMaxTicks) {
        this.tracks.delete(entityId);
        continue;
      }
      out.set(entityId, this.sampleTrack(track, rt));
    }
    return out;
  }

  stats(): InterpolationStats {
    return {
      delayMs: this.delayMs,
      targetDelayMs: this.targetDelayMs,
      starvedSamples: this.starved,
      totalSamples: this.total,
      starvedRatio: this.total > 0 ? this.starved / this.total : 0,
    };
  }

  /** Quên toàn bộ (rời room / đổi world). */
  reset(): void {
    this.tracks.clear();
    this.newestTick = -1;
    this.offset = Number.NaN;
    this.delayMs = this.minDelayMs;
    this.targetDelayMs = this.minDelayMs;
    this.lastSampleAt = Number.NaN;
    this.starved = 0;
    this.total = 0;
  }

  private pushEntity(e: SnapshotEntity, tick: number): void {
    let track = this.tracks.get(e.entityId);
    if (!track) {
      track = { entityId: e.entityId, entityType: e.entityType, samples: [] };
      this.tracks.set(e.entityId, track);
    }
    track.samples.push({ tick, posX: e.posX, posY: e.posY, rot: e.rot, velX: e.velX, velY: e.velY });
    const minTick = tick - this.historyTicks;
    while (track.samples.length > 1 && track.samples[0].tick < minTick) track.samples.shift();
  }

  private sampleTrack(track: Track, rt: number): InterpolatedEntity {
    const samples = track.samples;
    const base = { entityId: track.entityId, entityType: track.entityType };
    const first = samples[0];
    const last = samples[samples.length - 1];

    if (rt <= first.tick) {
      return { ...base, mode: 'old', posX: first.posX, posY: first.posY, rot: first.rot, velX: first.velX, velY: first.velY };
    }
    if (rt <= last.tick) {
      // Kẹp giữa hai mẫu — quét từ cuối vì renderTick luôn gần mép mới.
      for (let i = samples.length - 2; i >= 0; i--) {
        const a = samples[i];
        if (a.tick <= rt) {
          const b = samples[i + 1];
          const alpha = (rt - a.tick) / (b.tick - a.tick);
          return { ...base, mode: 'interp', ...lerpSample(a, b, alpha) };
        }
      }
      // Không tới được: nhánh rt <= first.tick đã chặn.
    }
    // Quá mẫu cuối: extrapolate theo velocity cuối, cap rồi freeze.
    const dtTicks = Math.min(rt - last.tick, this.extrapolateMaxTicks);
    const dtSec = (dtTicks * this.tickMs) / 1000;
    return {
      ...base,
      mode: rt - last.tick > this.extrapolateMaxTicks ? 'freeze' : 'extrapolate',
      posX: last.posX + last.velX * dtSec,
      posY: last.posY + last.velY * dtSec,
      rot: last.rot,
      velX: last.velX,
      velY: last.velY,
    };
  }
}
