# 008 — Roadmap & kiểm chứng

Căn cứ: BRAINSTORM.md §4 (tính năng theo phase), §6 (bước khởi động tuần đầu + định nghĩa
"core hoạt động").

## 1. Định nghĩa "core hoạt động" (điều kiện nghiệm thu Phase 1)

**[CHỐT]**

> Chơi được demo 2D với **200ms RTT giả lập + 5% packet loss** mà local player **không
> giật**, remote players **mượt**.

Diễn giải thành tiêu chí đo được **[ĐỀ XUẤT]**:
- Local player: correction hiển thị (sau smoothing) không vượt ngưỡng mắt thấy trong
  gameplay bình thường; misprediction/s ~0 khi không va chạm với vật server-simulated.
- Remote players: không teleport/rubber-band khi loss 5%; buffer interpolation cạn < 1%/phút.
- Server tick p99 < 33ms trong suốt phiên demo.

## 2. Tính năng theo phase

**[CHỐT]** (checklist gốc; cột trạng thái cập nhật theo thực tế repo)

### Phase 1 — Core netcode (2D)

| Hạng mục | Thiết kế | Trạng thái |
|---|---|---|
| Fixed timestep loop (server 30Hz sim, client 60Hz render) | [004](004-netcode.md) §1 | ✅ `FixedTimestep` (core) + test |
| Input schema + input buffer (seq number) | [004](004-netcode.md) §3–4 | ✅ server `InputBuffer` (M2) + client `InputPipeline` sample/redundancy/adaptive-lead (M3) + test |
| Client-side prediction cho local player | [004](004-netcode.md) §5 | ✅ `PredictionWorld` (M4): timeline liên tục, ring kép state+input 30 slot, box-sim Rapier chạy chung client/server |
| Server reconciliation (ring buffer snapshot ~1s, restore + replay) | [004](004-netcode.md) §5 | ✅ `Reconciler` (M4): so quantized-vs-quantized + epsilon, restore+replay idempotent; server ring history 30 slot (`RoomEngine.snapshotAt`) |
| Snapshot interpolation remote (~100ms) | [004](004-netcode.md) §6 | ✅ `InterpolationBuffer` (M5): stream-clock + adaptive delay 100→200ms + extrapolate cap 2 tick; lớp ghép `GameSession.getRenderState` + test |
| Binary serialization + quantization | [005](005-serialization.md) | ✅ `@gm-net/core` protocol (M1) + test round-trip/golden/fuzz |
| Clock sync + RTT, adaptive input buffer | [004](004-netcode.md) §2, §4 | ✅ client `ClockSync` (min-RTT/jitter/serverTickNow) + adaptive `inputLead` (M3) + test |

### Phase 2 — Production features

| Hạng mục | Thiết kế | Trạng thái |
|---|---|---|
| Delta compression (baseline đã ack) | [005](005-serialization.md) §4 | ✅ M7: `DELTA` bitmask field + keyframe policy; **140 B → 22.9 B mỗi client/tick (−83.6%)** với 10 entity |
| Lag compensation (history ~1s, rewind hit detection) | [006](006-server-rooms.md) §4 | ⬜ M10 |
| Interest management / AOI (grid/quadtree) | [006](006-server-rooms.md) §6 | ⬜ M9 |
| Reconnection + state resync (grace period) | [006](006-server-rooms.md) §5 | ⬜ M8 |
| Headless client — bot fill + load testing | [006](006-server-rooms.md) §7 | ⬜ M11 |

### Phase 3 — Mở rộng

| Hạng mục | Thiết kế |
|---|---|
| Port 3D (rapier3d, core netcode giữ nguyên) | `physics-3d` port từ `physics-2d` |
| Matchmaker (queue, skill-based optional, allocation) | [007](007-matchmaker.md) |
| Metrics: tick duration, mispredictions/s, bandwidth/client | counter cắm từ Phase 1 — [004](004-netcode.md) §8 |
| Replay recording (log input + seed) | phụ thuộc [004](004-netcode.md): sim = f(state₀, inputs) |
| Spectator mode | client chỉ-interpolation, không prediction |

## 3. Bước khởi động tuần đầu

**[CHỐT]** 5 bước, trạng thái hiện tại (2026-07-11):

1. ✅ `pnpm init` monorepo, scaffold packages, tsconfig. (Xong — commit `67b5636`.)
2. ✅ Spike Rapier2D Node + browser, verify `takeSnapshot/restoreSnapshot` replay
   identical. (Node PASS bit-perfect; browser chạy trong demo-2d M5 — `-compat`
   init WASM qua vite không cần cấu hình thêm.)
3. ✅ Fixed timestep loop + input sequence protocol.
4. ✅ Demo tối giản: box di chuyển, prediction + reconciliation, đo misprediction
   dưới lag giả lập. (M4 loopback headless + M5 demo web `examples/demo-2d` +
   e2e proxy 200ms/5% — `examples/demo-2d/test/e2e.test.ts`.)
5. ✅ Benchmark: snapshot size & thời gian restore với 50/200/500 bodies. (M6 —
   `packages/physics-2d/bench/snapshot-bench.ts`; kết luận ở §4 và
   [003 quyết định 5](003-tech-stack.md).)

## 4. Benchmark snapshot (bước 5) — **đã chạy, M6 (2026-07-12)**

Mục tiêu: chốt quyết định 5 (snapshot cả world vs thủ công).

- Script: `packages/physics-2d/bench/snapshot-bench.ts` — `pnpm --filter @gm-net/physics-2d
  bench` (mặc định 50,200,500; truyền `50,100` để đổi). World kín, N bóng dynamic
  `canSleep=false` đang va chạm; đo (a) `takeSnapshot()` ms + bytes, (b) `restoreSnapshot()`
  ms, (c) restore + replay 7 tick (reconciliation RTT 200ms), (d) `step()` thuần làm mốc.
- Harness có test đi kèm (`packages/physics-2d/test/snapshot-bench.test.ts`): assert phép đo
  hợp lệ (world thật sự có contact, snapshot lớn dần theo body, replay đắt hơn restore trần)
  — không assert con số hiệu năng để tránh flaky trên CI.

**Kết quả (Node v22.18.0, win32/x64):**

| Bodies | Snapshot size | Ring 30 slot | takeSnapshot (mean) | restore (mean) | restore+replay 7 tick (p99) |
|---|---|---|---|---|---|
| 50 | 36.8 KB | 1.08 MB | 0.08 ms | 0.41 ms | 2.31 ms |
| 200 | 143.0 KB | 4.19 MB | 0.15 ms | 0.27 ms | 2.80 ms |
| 500 | 353.1 KB | 10.34 MB | 0.26 ms | 0.43 ms | 3.92 ms |

**Kết luận: giữ snapshot cả world** — restore+replay p99 3.92 ms ở 500 body, lọt ngân sách
1 frame (~16 ms) hơn 4×; takeSnapshot ~0.8% tick 33 ms. Chi phí đáng kể duy nhất là bộ nhớ
(10.3 MB/room ở 500 body). Bảng đầy đủ + ngưỡng xem lại: [003 quyết định 5](003-tech-stack.md).

## 5. Giả lập điều kiện mạng

**[CHỐT]** phương pháp đo: giả lập lag bằng `tc netem` hoặc proxy delay.

**[ĐỀ XUẤT]** cụ thể cho môi trường dev hiện tại (Windows): `tc netem` không có →
viết **proxy delay thuần Node** trong repo (`examples/` hoặc `packages/` tools): TCP/WS
proxy chèn delay mỗi chiều + drop ngẫu nhiên theo tỉ lệ cấu hình (200ms/5% cho bài nghiệm
thu §1). Ưu điểm: chạy được cả trong CI/Linux, tái lập chính xác, không cần quyền admin
(clumsy/WinDivert cần). Đây cũng chính là công cụ đo misprediction ở bước 4 tuần đầu.

**Đã làm ở M5:** `@gm-net/netem-proxy` — proxy WS mức message (WS chạy trên TCP nên
"packet loss" = drop nguyên message WS, đúng semantics netcode UDP-style cần), delay mỗi
chiều + drop rate + PRNG seed được; forward HTTP matchmaking nguyên vẹn; `graceMs` đầu
kết nối không drop (join/handshake thuộc kênh reliable, không thuộc bài loss). CLI:
`pnpm --filter demo-2d proxy` (2568 → 2567, RTT +200ms, drop 5%).

## 6. Thứ tự việc tiếp theo (đề xuất)

1. Bước 3 còn lại: wire protocol tối thiểu (`INPUT`/`SNAPSHOT`/`PING`/`PONG` —
   [005](005-serialization.md)) + BitWriter/BitReader + test round-trip/golden.
2. `GameRoom` khung trên Colyseus + tick loop ([006](006-server-rooms.md) §1–2).
3. Client runtime khung: connect, clock sync, gửi input, nhận snapshot.
4. Demo 1 box: prediction + reconciliation + proxy delay + đếm misprediction (bước 4).
5. Benchmark snapshot (bước 5) → chốt quyết định 5.
