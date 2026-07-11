# Kế hoạch triển khai gm-net

Tài liệu điều phối toàn bộ quá trình code. Đọc kèm: [BRAINSTORM.md](../BRAINSTORM.md)
(nguồn sự thật gốc) và [docs/design 001–008](README.md) (đặc tả chi tiết — kế hoạch này
chỉ tham chiếu, không lặp lại nội dung thiết kế).

## 0. Quy tắc làm việc

1. **Một milestone = một mạch làm việc trọn vẹn** — kết thúc bằng test xanh
   (`pnpm build && pnpm test && pnpm typecheck`) và một commit theo mốc. Không bắt đầu
   milestone sau khi tiêu chí nghiệm thu milestone trước chưa đạt.
2. **Test đi cùng code, không nợ lại** — mỗi task có mục test riêng; task chưa có test
   coi như chưa xong.
3. **Docs là hợp đồng**: code làm đúng theo design docs; khi thực tế buộc đổi một điều
   **[ĐỀ XUẤT]**, sửa doc trong cùng commit. Muốn đổi điều **[CHỐT]** → dừng lại, thảo
   luận với chủ dự án trước.
4. **Ranh giới package** theo [002 §2](design/002-repo-structure.md): `core` không I/O,
   không Colyseus/DOM; `client` ↮ `server`; đồ dùng chung rơi xuống `core`/`shared`.
5. Kích thước task: S ≈ dưới nửa buổi, M ≈ một buổi, L ≈ một ngày+. Dùng để cân phiên
   làm việc, không phải cam kết thời gian.

## 1. Bản đồ milestone & phụ thuộc

```
Phase 1                                Phase 2                    Phase 3
M1 protocol ──► M2 server ──► M3 client ──► M4 prediction ──► M5 demo+nghiệm thu
                                  │                              │
                                  └──────────► M6 benchmark ◄────┘
                                               (chạy song song M4–M5 được)

M5 đạt ──► M7 delta ──► M9 AOI          M8 reconnect (sau M5, độc lập M7/M9)
       ──► M10 lag comp (sau M6)         M11 headless + load test (sau M8)

M11 đạt ──► M12 3D port    M13 matchmaker    M14 metrics/replay/spectator
            (M12–M14 độc lập nhau, làm theo nhu cầu)
```

---

## Phase 1 — Core netcode 2D

### M1 — Protocol & serialization nền tảng

Đặc tả: [005](design/005-serialization.md) §1–3, §6. Không phụ thuộc gì — làm đầu tiên.

| # | Task | Nơi đặt | Cỡ |
|---|---|---|---|
| 1.1 | `BitWriter`/`BitReader` (cursor, LE, bit + byte ops, grow buffer) | `core/src/serialization/` | M |
| 1.2 | Quantization helpers: `quantize/dequantize` position u16, angle u16, velocity i16, tham số hóa theo `worldBounds`/`vMax` | `core/src/serialization/quantize.ts` | S |
| 1.3 | Encode/decode 4 message `INPUT`/`SNAPSHOT`/`PING`/`PONG` + registry encoder custom payload của game | `core/src/protocol/` | M |
| 1.4 | Message type enum + protocolVersion const | `core/src/protocol/constants.ts` | S |

**Test:** round-trip mọi message (property-based với giá trị biên); golden bytes cố định
(đổi format → test đỏ → ép sửa doc 005); fuzz decoder không crash với bytes rác; sai số
quantize ≤ ngưỡng đặc tả.

**Nghiệm thu:** encode+decode một `SNAPSHOT` 10 entity đúng 13 byte/entity + header như
ước tính [005 §7](design/005-serialization.md).

### M2 — Server skeleton trên Colyseus

Đặc tả: [006](design/006-server-rooms.md) §1–3. Phụ thuộc M1.

| # | Task | Nơi đặt | Cỡ |
|---|---|---|---|
| 2.1 | `GameRoom` base: onCreate/onJoin/onLeave, handshake JSON (protocolVersion, tickRate, worldBounds, entityId), state Colyseus để trống | `server/src/room.ts` | M |
| 2.2 | Tick loop 30Hz drift-corrected dùng `FixedTimestep` (kiểm tra `setSimulationInterval` của Colyseus có drift không, nếu có thì tự quản timer) | `server/src/tick.ts` | S |
| 2.3 | Jitter buffer input per-client: nhận `INPUT` binary, dedupe seq, xếp theo tick, rút tại tick T, thiếu → lặp input cuối; đếm lateInputs | `server/src/input-buffer.ts` | M |
| 2.4 | Validate input: clamp payload, cửa sổ tick ±1s, ngân sách 2 input/tick ([006 §3](design/006-server-rooms.md)) | trong 2.3 | S |
| 2.5 | `PING`→`PONG` handler; broadcast `SNAPSHOT` mỗi tick qua `sendBytes` (lastProcessedSeq riêng từng client) | `server/src/room.ts` | S |
| 2.6 | Gắn `@colyseus/uwebsockets-transport`; entry `createGameServer()` | `server/src/index.ts` | S |
| 2.7 | Hooks cho game: `onPlayerJoin/Leave`, `applyInput`, `simulate`, `encodeCustomState` | `server/src/room.ts` | S |

**Test:** unit jitter buffer (đến sớm/muộn/trùng/flood); integration: client WS thô connect
→ handshake → gửi INPUT → nhận SNAPSHOT có seq được ack; tick ổn định (đo 100 tick, drift < 1 tick).

**Nghiệm thu:** server chạy được một room "echo simulation" (state = vị trí do applyInput
cộng dồn, chưa physics), 2 client thô thấy state của nhau qua snapshot.

### M3 — Client runtime skeleton

Đặc tả: [004](design/004-netcode.md) §2–4, §7. Phụ thuộc M1, M2. Ràng buộc: không import DOM.

| # | Task | Nơi đặt | Cỡ |
|---|---|---|---|
| 3.1 | `GameClient`: connect (colyseus.js), handshake, vòng đời join/leave | `client/src/client.ts` | M |
| 3.2 | Clock sync: ping scheduler (dày 2s đầu rồi ~500ms), min-RTT cửa sổ trượt, EWMA jitter, ước lượng serverTickNow | `client/src/clock.ts` | M |
| 3.3 | Input pipeline: lấy mẫu 1 lần/tick, seq, pendingInputs ring, gửi kèm redundancy 3–5, ackTick đính kèm | `client/src/input.ts` | M |
| 3.4 | Adaptive inputLead: khởi điểm `ceil(RTT/2/TICK_MS)+1`, điều chỉnh ±1 tick theo lateInputs với hysteresis | trong 3.2/3.3 | S |
| 3.5 | Nhận snapshot: parse, bỏ bản cũ hơn bản mới nhất, phát sự kiện cho lớp trên (M4/M5 tiêu thụ) | `client/src/snapshot.ts` | S |

**Test:** clock sync hội tụ với RTT giả lập có jitter (mock transport); input redundancy —
mất 1 packet không mất input; adaptive lead tăng khi lateInputs cao, giảm khi sạch.

**Nghiệm thu:** client Node kết nối server M2, di chuyển "echo box" bằng input, RTT/lead
đo được in ra log.

### M4 — Prediction + Reconciliation (tích hợp physics)

Đặc tả: [004 §5](design/004-netcode.md), [003 quyết định 1, 5](design/003-tech-stack.md).
Phụ thuộc M3. Milestone rủi ro cao nhất Phase 1 — dành trọn tâm trí.

| # | Task | Nơi đặt | Cỡ |
|---|---|---|---|
| 4.1 | Interface `Simulation` trong shared: `applyInput(world, entity, input)` + factory world; demo game implement | `shared/src/simulation.ts` | S |
| 4.2 | Server: thay echo sim bằng Rapier world (physics-2d), step 1 tick/tick, `takeSnapshot` → ring buffer 30 slot | `server/src/room.ts` | M |
| 4.3 | Client: Rapier world local, prediction — áp input → step → `takeSnapshot` vào ring buffer local kèm map seq→tick | `client/src/prediction.ts` | M |
| 4.4 | Reconciliation: so state quantized-vs-quantized, epsilon; lệch → restore ring, ghi đè authoritative, replay pendingInputs | `client/src/reconcile.ts` | L |
| 4.5 | Visual smoothing: tách sim transform / render transform, exponential smoothing ~50–100ms, bỏ qua khi teleport | `client/src/render-state.ts` | S |
| 4.6 | Metrics client: misprediction/s, biên độ correction ([004 §8](design/004-netcode.md)) | `client/src/metrics.ts` | S |

**Test:** kịch bản deterministic với mock transport delay cố định: (a) không lệch → 0
correction; (b) server áp lực ngoài (đẩy box) → đúng 1 correction, hội tụ; (c) replay giữ
nguyên kết quả khi không có sự kiện server mới (idempotent).

**Nghiệm thu:** trên loopback (RTT ~0), local player điều khiển box Rapier,
misprediction/s = 0 khi di chuyển tự do.

### M5 — Interpolation + demo-2d + nghiệm thu Phase 1

Đặc tả: [004 §6](design/004-netcode.md), [008 §1, §5](design/008-roadmap.md). Phụ thuộc M4.

| # | Task | Nơi đặt | Cỡ |
|---|---|---|---|
| 5.1 | Interpolation buffer remote: delay 100ms, lerp/slerp, extrapolate cap 2 tick, adaptive delay trượt dần | `client/src/interpolation.ts` | M |
| 5.2 | API render: `client.getRenderState(now)` — local (smoothed) + remote (interpolated) | `client/src/render-state.ts` | S |
| 5.3 | Proxy delay thuần Node: TCP/WS proxy, delay mỗi chiều + drop % cấu hình được | `packages/netem-proxy/` (package tool mới) | M |
| 5.4 | demo-2d: server room + trang web canvas 2D tối giản (không cần Pixi) — 2+ người chơi box, HUD hiển thị RTT, misprediction/s, correction | `examples/demo-2d/` | L |
| 5.5 | Kiểm chứng browser cho spike Rapier (nửa còn lại bước 2 tuần đầu): demo chạy rapier2d-compat trong browser | trong 5.4 | S |

**Test:** interpolation unit (thiếu snapshot → extrapolate rồi freeze; adaptive delay);
e2e script: server + 2 headless client qua proxy 200ms/5% → misprediction & buffer-cạn
dưới ngưỡng [008 §1](design/008-roadmap.md).

**Nghiệm thu — điều kiện [CHỐT] của Phase 1:** chơi demo 2D qua proxy 200ms RTT + 5% loss:
local không giật, remote mượt, theo tiêu chí đo được ở [008 §1](design/008-roadmap.md).
**Đạt mốc này mới coi là "core hoạt động".**

### M6 — Benchmark snapshot (chốt quyết định 5)

Đặc tả: [008 §4](design/008-roadmap.md). Phụ thuộc M1 (chỉ cần physics-2d); chạy song song
M4–M5 được.

| # | Task | Nơi đặt | Cỡ |
|---|---|---|---|
| 6.1 | Bench script: 50/200/500 bodies va chạm — đo takeSnapshot ms/size, restore ms, restore+replay 7 tick | `packages/physics-2d/bench/` | M |
| 6.2 | Ghi kết quả vào doc 003 (quyết định 5): giữ snapshot cả world hay chuyển snapshot thủ công | `docs/design/003-tech-stack.md` | S |

**Nghiệm thu:** bảng số liệu trong doc + kết luận rõ ràng cho quyết định 5.

---

## Phase 2 — Production features

Chỉ bắt đầu sau khi M5 nghiệm thu. Đặc tả chi tiết đã có sẵn trong docs; các milestone
dưới đây độc lập tương đối — thứ tự đề xuất: M7 → M8 → M9 → M10 → M11.

### M7 — Delta compression ([005 §4](design/005-serialization.md))
Baseline per-client theo ackTick; `DELTA` bitmask entity/field; keyframe khi baseline già
\>1s hoặc join. Test property: chuỗi snapshot+ack ngẫu nhiên → client state == server state.
Nghiệm thu: bandwidth/client giảm đo được (log trước/sau) với demo 10 entity. **Cỡ: L**

### M8 — Reconnection + resync ([006 §5](design/006-server-rooms.md))
`allowReconnection` grace 30s, hook `onPlayerDisconnected`, full snapshot + reset seq khi
quay lại. Test e2e: rớt mạng (proxy cắt) 10s → quay lại chơi tiếp không lỗi. **Cỡ: M**

### M9 — Interest management / AOI ([006 §6](design/006-server-rooms.md))
Uniform grid, 3×3 cell, hysteresis vào/ra, spawn/despawn event trong snapshot. Test: entity
ngoài vùng không xuất hiện trong bytes gửi; đi qua ranh giới không flapping. **Cỡ: L**

### M10 — Lag compensation ([006 §4](design/006-server-rooms.md))
History position/rotation 30 tick per entity (phương án b — hitscan); client báo interp
delay, server clamp ≤200ms; API `room.rewindRaycast(...)`. Test: bot đứng yên + bắn qua
proxy 200ms trúng 100%; không lag comp thì trượt (test chứng minh giá trị). **Cỡ: L**

### M11 — Headless client + load test ([006 §7](design/006-server-rooms.md))
Bot API (input scripted), runner N bot qua proxy, thu metrics server (tick p99, bandwidth).
Nghiệm thu: 50 bot/room ổn định, số liệu ghi vào docs. **Cỡ: M**

---

## Phase 3 — Mở rộng

Kích hoạt theo nhu cầu sau Phase 2; ba nhánh độc lập:

- **M12 — Port 3D**: `physics-3d` (rapier3d-compat) sao chép cấu trúc adapter 2D; thêm
  quantize quaternion (smallest-three) vào 005; demo-3d. Core netcode **không đổi** —
  nếu phải đổi tức là M1–M5 rò rỉ giả định 2D, sửa tại gốc. **Cỡ: L**
- **M13 — Matchmaker** ([007](design/007-matchmaker.md)): registry TTL heartbeat, queue
  worker, reservation flow, REST/WS endpoint; e2e với 2 game server giả. **Cỡ: L**
- **M14 — Quan sát & tiện ích**: xuất metrics ([004 §8](design/004-netcode.md)) ra
  endpoint/log có cấu trúc; replay recording (log input + seed — sim đã là f(state₀,
  inputs) từ M4); spectator mode (client interpolation-only). **Cỡ: M/L mỗi mục**

---

## 2. Rủi ro chính & điểm thoát

| Rủi ro | Phát hiện ở | Phương án thoát (đã lường trong docs) |
|---|---|---|
| Snapshot/restore quá đắt với world lớn | M6 | Snapshot thủ công dynamic bodies quan trọng (quyết định 5) |
| Replay reconciliation không lọt frame budget khi RTT cao | M4 (đo), M6 | Giảm tần suất full-check, chỉ reconcile khi server báo lệch; giảm ring xuống 0.5s |
| `setSimulationInterval` Colyseus drift | M2 | Tự quản timer drift-corrected (đã dự phòng 2.2) |
| uWS transport trục trặc Windows/CI | M2 | Fallback transport WS mặc định của Colyseus, giữ interface không đổi |
| Sai số Rapier client/server gây correction liên tục | M4 | So sánh quantized-vs-quantized; nới epsilon; bật `enhanced-determinism` |
| Colyseus 0.17 API khác giả định trong docs | M2 | Docs 006 ghi ánh xạ [ĐỀ XUẤT] — chỉnh doc theo API thật, giữ nguyên hành vi đặc tả |

## 3. Theo dõi tiến độ

Trạng thái milestone cập nhật tại [008 — roadmap](design/008-roadmap.md) (bảng Phase 1)
và đánh dấu tại đây khi nghiệm thu:

- [x] M0 — Scaffold + spike Rapier + FixedTimestep (commit `67b5636`)
- [x] M1 — Protocol & serialization (`@gm-net/core`: BitWriter/BitReader, quantize, ProtocolCodec 4 message + custom codec)
- [x] M2 — Server skeleton (`@gm-net/server`: RoomEngine echo + InputBuffer jitter + TickScheduler drift-corrected + GameRoom/createGameServer)
- [x] M3 — Client runtime skeleton (`@gm-net/client`: GameClient transport-agnostic + ClockSync + InputPipeline redundancy/adaptive lead + SnapshotReceiver; adapter colyseus.js; nghiệm thu qua loopback in-memory)
- [x] M4 — Prediction + reconciliation (`shared`: interface `Simulation` + demo `box-sim` Rapier subpath export; `server`: `createSimulationGame` + ring history 30 slot; `client`: `PredictionWorld` timeline liên tục + `Reconciler` quantized-epsilon + `TransformSmoother` + `PredictionMetrics`; nghiệm thu loopback RTT ~0: misprediction/s = 0, đẩy box → đúng 1 correction, replay idempotent bit-perfect)
- [x] M5 — Demo 2D + nghiệm thu Phase 1 ⭐ (`client`: `InterpolationBuffer` stream-clock
  + adaptive delay + lớp ghép `GameSession.getRenderState`; `@gm-net/netem-proxy` WS
  delay/drop/seed; `examples/demo-2d` server + canvas 2D + HUD (kiểm chứng Rapier
  browser); e2e socket thật qua proxy 200ms RTT + 5% loss đạt ngưỡng 008 §1;
  `connectGameRoom` tự matchmake reshape reservation 0.17→0.16)
- [ ] M6 — Benchmark snapshot
- [ ] M7–M11 — Phase 2
- [ ] M12–M14 — Phase 3
