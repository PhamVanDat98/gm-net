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
| Input schema + input buffer (seq number) | [004](004-netcode.md) §3–4 | ✅ server-side `InputBuffer` (M2) + test; sample/redundancy phía client là M3 |
| Client-side prediction cho local player | [004](004-netcode.md) §5 | ⬜ |
| Server reconciliation (ring buffer snapshot ~1s, restore + replay) | [004](004-netcode.md) §5 | ⬜ (spike Rapier ✅) |
| Snapshot interpolation remote (~100ms) | [004](004-netcode.md) §6 | ⬜ |
| Binary serialization + quantization | [005](005-serialization.md) | ✅ `@gm-net/core` protocol (M1) + test round-trip/golden/fuzz |
| Clock sync + RTT, adaptive input buffer | [004](004-netcode.md) §2, §4 | ⬜ |

### Phase 2 — Production features

| Hạng mục | Thiết kế |
|---|---|
| Delta compression (baseline đã ack) | [005](005-serialization.md) §4 |
| Lag compensation (history ~1s, rewind hit detection) | [006](006-server-rooms.md) §4 |
| Interest management / AOI (grid/quadtree) | [006](006-server-rooms.md) §6 |
| Reconnection + state resync (grace period) | [006](006-server-rooms.md) §5 |
| Headless client — bot fill + load testing | [006](006-server-rooms.md) §7 |

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
2. ✅ Spike Rapier2D Node + browser*, verify `takeSnapshot/restoreSnapshot` replay
   identical. (*Node đã PASS bit-perfect; nửa browser chạy khi demo-2d có trang web —
   dùng bản `-compat` nên rủi ro thấp.)
3. 🔶 Fixed timestep loop ✅ + input sequence protocol ⬜ (chưa cần physics).
4. ⬜ Demo tối giản: 1 box di chuyển, prediction + reconciliation hoạt động, đo
   misprediction khi giả lập lag.
5. ⬜ Benchmark: snapshot size & thời gian restore với 50/200/500 bodies.

## 4. Kế hoạch benchmark (bước 5)

**[ĐỀ XUẤT]** — quyết định 5 (snapshot cả world vs thủ công) chờ số liệu này:

- Script Node trong `packages/physics-2d/bench/`: world 50/200/500 dynamic bodies đang
  va chạm; đo (a) `takeSnapshot()` ms + size bytes, (b) `restoreSnapshot()` ms,
  (c) restore + replay 7 tick (tình huống reconciliation RTT 200ms).
- Ngưỡng quan tâm: ring buffer 30 snapshot chiếm bao nhiêu MB; restore+replay có lọt
  trong ngân sách 1 frame client (~16ms) không. Nếu 500 bodies không lọt → kích hoạt
  phương án "snapshot thủ công dynamic bodies quan trọng" đã lường trong quyết định 5.

## 5. Giả lập điều kiện mạng

**[CHỐT]** phương pháp đo: giả lập lag bằng `tc netem` hoặc proxy delay.

**[ĐỀ XUẤT]** cụ thể cho môi trường dev hiện tại (Windows): `tc netem` không có →
viết **proxy delay thuần Node** trong repo (`examples/` hoặc `packages/` tools): TCP/WS
proxy chèn delay mỗi chiều + drop ngẫu nhiên theo tỉ lệ cấu hình (200ms/5% cho bài nghiệm
thu §1). Ưu điểm: chạy được cả trong CI/Linux, tái lập chính xác, không cần quyền admin
(clumsy/WinDivert cần). Đây cũng chính là công cụ đo misprediction ở bước 4 tuần đầu.

## 6. Thứ tự việc tiếp theo (đề xuất)

1. Bước 3 còn lại: wire protocol tối thiểu (`INPUT`/`SNAPSHOT`/`PING`/`PONG` —
   [005](005-serialization.md)) + BitWriter/BitReader + test round-trip/golden.
2. `GameRoom` khung trên Colyseus + tick loop ([006](006-server-rooms.md) §1–2).
3. Client runtime khung: connect, clock sync, gửi input, nhận snapshot.
4. Demo 1 box: prediction + reconciliation + proxy delay + đếm misprediction (bước 4).
5. Benchmark snapshot (bước 5) → chốt quyết định 5.
