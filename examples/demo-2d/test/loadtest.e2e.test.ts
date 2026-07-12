/**
 * Hồi quy cho load test ([006] §7, M11).
 *
 * Nghiệm thu thật (**50 bot/room**) chạy bằng runner — số liệu ghi ở
 * [008 §6](../../../docs/design/008-roadmap.md); test này chạy **16 bot** để CI
 * không phải gánh 50 world Rapier trong một process, nhưng vẫn khoá đúng các bất
 * biến: server không trễ nhịp, bot chạy đủ tick, không rubber-band, không cạn buffer.
 */
import { describe, expect, it } from 'vitest';
import { runLoadTest } from '../src/loadtest.js';

const BOTS = 16;
const SECONDS = 6;
const TICK_BUDGET_MS = 33.3;

describe('load test — N bot/room (M11)', () => {
  it(`${BOTS} bot: server giữ nhịp tick, bot chơi bình thường`, async () => {
    const r = await runLoadTest({ bots: BOTS, seconds: SECONDS });

    // Server nhận đủ bot và vẫn trong ngân sách tick 30Hz.
    expect(r.server.clients).toBe(BOTS);
    expect(r.server.tickMs.p99).toBeLessThan(TICK_BUDGET_MS);
    expect(r.worstTickP99).toBeLessThan(TICK_BUDGET_MS);

    // Delta đang hoạt động (không phải toàn keyframe).
    expect(r.server.deltas).toBeGreaterThan(r.server.keyframes);
    expect(r.server.bytesPerClientPerSecond).toBeGreaterThan(0);

    // Bot chạy đủ nhịp sim (≈30 tick/s; nới rộng vì timer Windows không đều).
    expect(r.avgBotTicks).toBeGreaterThan(SECONDS * 25);

    // Chất lượng netcode không sụp khi đông.
    //
    // Correction KHÔNG kỳ vọng bằng 0 ở đây: demo chỉ có vài spawn point nên 16 bot
    // chồng lên nhau và va chạm thật — va chạm với vật server-simulated thì
    // correction là đúng ([008] §1 chỉ đòi ~0 khi KHÔNG va chạm). Cái phải khoá là
    // nó không bùng nổ (correction loop) — vài cái/giây/bot, không phải mỗi tick.
    const perBotPerSecond = r.correctionsPerSecond / BOTS;
    expect(perBotPerSecond).toBeLessThan(5);

    // Remote vẫn mượt: buffer interpolation không cạn.
    expect(r.worstStarvedRatio).toBeLessThan(0.01);
  }, 60_000);
});
