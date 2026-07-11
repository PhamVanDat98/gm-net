# 004 — Core netcode (Phase 1)

Căn cứ: BRAINSTORM.md §4 Phase 1 (7 hạng mục), §1 (nguyên tắc shared simulation), §6
(bước 3–4 tuần đầu). Đây là tài liệu triển khai chính của Phase 1.

Các con số đã chốt trong tài liệu khởi tạo: **server sim 30Hz, client render 60Hz, render
delay remote ~100ms, ring buffer snapshot ~1s**. Các con số khác trong tài liệu này là
**[ĐỀ XUẤT]** — điểm khởi đầu hợp lý, chỉnh theo đo đạc thực tế.

## 1. Mô hình thời gian

**[CHỐT]** Fixed timestep: simulation chạy đúng nhịp tick cố định, tách khỏi nhịp render.

- `SERVER_TICK_RATE = 30` Hz → `SERVER_TICK_MS = 1000/30 ≈ 33.33ms` (đã có trong
  `@gm-net/shared`).
- Client render 60Hz (rAF), nhưng **simulation phía client cũng step theo tick 30Hz**
  giống hệt server — bắt buộc, vì prediction phải chạy cùng timestep với authoritative
  simulation (cùng dt → cùng kết quả tích phân).
- Tick là số nguyên đơn điệu tăng, bắt đầu 0 khi room khởi tạo. Mọi message đều gắn tick.

**Đã có sẵn:** `FixedTimestep` trong `@gm-net/core` (accumulator kiểu Gaffer): caller gọi
`advance(elapsedMs, step)`, nhận `alpha` ∈ [0,1) làm hệ số nội suy render giữa hai tick
sim; `maxStepsPerAdvance` (mặc định 5) chặn spiral of death, backlog vượt quá bị bỏ.

Client mỗi rAF frame: `advance(dt)` → 0..n bước sim 30Hz → render dùng
`state(tick-1)` lerp `state(tick)` theo `alpha` cho local player.

## 2. Clock sync + RTT estimation

**[CHỐT]** là hạng mục Phase 1. **[ĐỀ XUẤT]** cách làm:

Mục tiêu: client ước lượng (a) RTT và (b) *server tick hiện tại* để biết nên gửi input
nhắm vào tick nào.

- Ping/pong định kỳ (mỗi ~500ms, và dày hơn trong 2s đầu sau connect): client gửi
  `PING{clientTime}`, server đáp `PONG{clientTime, serverTick, serverTimeInTick}`.
- RTT lấy theo **min-RTT trong cửa sổ trượt** (~10 mẫu gần nhất) — min ít nhiễu hơn mean
  vì loại được jitter đuôi; thêm EWMA của jitter (độ lệch RTT) để dùng cho adaptive buffer.
- Ước lượng tick server tại thời điểm t bất kỳ:
  `serverTickNow ≈ pongServerTick + (now - pongReceivedAt + RTT/2) / TICK_MS`.
- Client chọn **input target tick** = `serverTickNow + inputLead`, trong đó `inputLead`
  đủ để input tới nơi *trước khi* server mô phỏng tick đó (xem §4 adaptive input buffer).

## 3. Input schema

**[CHỐT]** Client gửi input kèm sequence number; server ack seq đã xử lý.

**[ĐỀ XUẤT]** cấu trúc (mở rộng `InputCommand` hiện có trong `shared`):

```ts
interface InputCommand {
  seq: number;    // đơn điệu tăng per-client, không reset trong session
  tick: number;   // tick mô phỏng mà input này nhắm tới
  payload: GameInput; // do game định nghĩa — với demo-2d: { moveX, moveY, buttons }
}
```

- `payload` do game định nghĩa qua generic; framework chỉ cần biết cách serialize
  (game đăng ký encoder/decoder — xem [005](005-serialization.md) §5).
- Quy tắc một-input-một-tick: mỗi tick client lấy mẫu thiết bị đúng một lần. Input giữa
  hai tick (chuột di chuyển nhiều lần) được gộp tại thời điểm lấy mẫu.

## 4. Đường đi của input & input buffer phía server

**[CHỐT]** Input buffer + adaptive là hạng mục Phase 1. **[ĐỀ XUẤT]** chi tiết:

**Chống packet loss bằng redundancy:** mỗi packet input chứa N input gần nhất chưa được
ack (thường 3–5). Input bé (vài byte sau khi pack) nên gửi thừa rẻ hơn nhiều so với chờ
retransmit — mất 1 packet không sao, packet sau mang lại input đó. Server bỏ qua seq đã xử lý.

**Input buffer per-client phía server (jitter buffer):**

- Server giữ hàng đợi input theo tick nhắm tới. Tại tick T, lấy input có `tick == T` ra
  áp dụng. Input đến muộn (tick < T, chưa xử lý) → **bỏ**, và đánh dấu client đó thiếu
  input tick T (áp dụng "input rỗng" hoặc lặp lại input cuối — chọn qua config, mặc định
  lặp input cuối để di chuyển không khựng).
- **Adaptive:** client theo dõi tỉ lệ input đến muộn (server báo trong snapshot —
  trường `lateInputs`) và jitter đo được, điều chỉnh `inputLead` (thêm/bớt 1 tick mỗi lần,
  có hysteresis) — cân bằng giữa input delay và độ ổn định. Khởi điểm:
  `inputLead = ceil(RTT/2 / TICK_MS) + 1`.

**Ghi chú triển khai M3** ([ĐỀ XUẤT] đã cụ thể hóa):

- `lateInputs` trong snapshot là **đếm theo cửa sổ** (server reset mỗi lần đọc,
  `InputBuffer.consumeLateInputs`), không phải tổng trọn đời — mỗi snapshot mang
  đúng "số muộn kể từ snapshot trước" nên client dùng thẳng làm delta cho adaptive
  lead, và u8 không bão hòa sau ~255 lần muộn.
- **Redundancy chống flood:** khi server hết `budgetPerTick`, phần còn lại của packet
  bị **hoãn** (không đánh dấu seq đã thấy) thay vì bỏ hẳn — burst input sau mất gói
  được redundancy của packet kế mang lại khi budget reset (`InputBuffer` §2–3).
- **Seq client bắt đầu từ 1** (không phải 0): server ack `lastProcessedSeq = 0` vừa
  nghĩa "chưa xử lý gì" vừa nghĩa "đã xử lý seq 0"; bắt đầu từ 1 để ack 0 không cắt
  nhầm input đầu tiên khỏi `pendingInputs`.

## 5. Prediction + Reconciliation (local player)

**[CHỐT]** Cơ chế: client dự đoán bằng chính simulation code trong `shared`; khi snapshot
authoritative về, restore snapshot Rapier từ ring buffer (~1s) rồi replay input chưa ack.

**[ĐỀ XUẤT]** vòng đời chi tiết phía client:

```
Mỗi tick sim t (30Hz):
  1. Lấy mẫu input → InputCommand{seq, tick: t + inputLead}
  2. Lưu vào pendingInputs (ring, giữ tới khi được ack)
  3. Gửi packet input (kèm redundancy §4)
  4. Áp input vào Rapier world local → world.step()
  5. takeSnapshot() → đẩy vào ring buffer local (30 slot ~ 1s)
     (kèm map seq→tick để biết snapshot nào ứng với input nào)

Khi nhận snapshot server (tick T, lastProcessedSeq = s):
  1. Xóa pendingInputs có seq ≤ s
  2. So state local player mà mình ĐÃ dự đoán tại tick T
     với state server gửi về (position/velocity)
  3. Nếu lệch ≤ epsilon (vd 1mm vị trí, ~0.5° góc): chấp nhận, không làm gì
  4. Nếu lệch > epsilon (MISPREDICTION):
     a. restoreSnapshot(ring[T])  ← trạng thái local tại tick T
     b. Ghi đè state authoritative của local player (và các entity server gửi)
     c. Replay: với mỗi input trong pendingInputs (seq > s) theo thứ tự:
        áp input → world.step() → cập nhật lại ring buffer
     d. Bây giờ world local ở tick hiện tại, đã sửa theo sự thật server
```

Ghi chú quan trọng:

- **Visual smoothing:** không snap render ngay sau correction — tách "simulation
  transform" và "render transform", render transform đuổi theo simulation transform
  (exponential smoothing, thời hằng ~50–100ms, bỏ qua smoothing nếu lệch quá lớn như
  teleport). Nếu thiếu smoothing, mọi correction nhỏ đều thành giật hình.
- **Replay là nơi ăn CPU nhất** khi RTT cao (RTT 200ms ≈ replay 6–7 tick mỗi lần lệch).
  Benchmark restore+step nằm trong kế hoạch tuần đầu ([008](008-roadmap.md) §4).
- **Đo misprediction** ngay từ demo đầu (bước 4 tuần đầu): đếm correction/s và biên độ
  lệch — đây là chỉ số sức khỏe chính của netcode.

**Ghi chú triển khai M4** ([ĐỀ XUẤT] đã cụ thể hóa):

- **Timeline dự đoán liên tục** (`PredictionWorld.nextInputTick`): local sim tick +1 mỗi
  bước và input nhắm đúng tick đó; KHÔNG suy target tick lại từ clock mỗi tick — ước
  lượng `serverTickNow` có jitter dưới-tick nên `ceil` bounce làm tick lặp/nhảy, server
  áp input lệch tick với local → misprediction hệ thống (đo được ~114 correction/120
  tick với input biến thiên). Clock chỉ dùng để neo lần đầu và nhảy tới khi lệch thật
  (≥ 2 tick: sau pause, lead tăng dồn); clock đòi tick nhỏ hơn → giữ timeline (input
  đến sớm hơn cần, vô hại).
- **Ring kép cùng khóa tick**: `stateRing[t]` = snapshot + transform local *tại tick t*
  (cùng semantics `serverTick`); `inputRing[t]` = payload đã áp *tại tick t* (kể cả
  fill repeat-last khi có gap — mirror hành vi server). Replay khi correction đọc lại
  `inputRing` nên tự tái lập cả các tick fill → idempotent bit-perfect khi không có sự
  kiện server mới (test kịch bản c).
- **Neo/re-base**: snapshot có `serverTick ≥ stateTick` (snapshot đầu, warmup, tab
  pause) → không có prediction để so, ghi đè toàn bộ theo authoritative + reset ring.
- **Epsilon theo bước lượng tử** per miền (position/velocity/rotation, mặc định 1/1/2
  bước): hấp thụ trọn sai số làm tròn hai phía. Khi correction, chỉ ghi đè entity thật
  sự lệch (>0 bước) — entity đã khớp giữ nguyên float gốc + sleep state để restore+replay
  thuần còn bit-perfect.
- **Input canonical**: payload áp local phải là bản round-trip qua codec (vd
  `canonicalBoxInput`) — server chỉ thấy bản decode từ wire, áp bản thô là tự tạo
  misprediction trôi dần.
- Demo box (`@gm-net/shared/box-sim`, subpath export để không kéo WASM vào bundle game
  thật): top-down không trọng lực, `setLinvel` theo input, `lockRotations` vì wire chưa
  mang angular velocity.

## 6. Snapshot interpolation (remote entities)

**[CHỐT]** Remote entities render trễ ~100ms bằng nội suy giữa snapshot.

**[ĐỀ XUẤT]** chi tiết:

- 100ms ≈ 3 tick @ 30Hz → buffer đích ~3 snapshot. `renderTime = estimatedServerTime - delay`,
  với `delay` khởi điểm 100ms.
- Mỗi frame render: tìm hai snapshot kẹp `renderTime` → lerp position, slerp/lerp-angle
  rotation. Trường rời rạc (state enum, HP…) lấy theo snapshot sớm hơn (step).
- **Thiếu snapshot** (loss/jitter làm buffer cạn): extrapolate tối đa ~2 tick từ velocity
  cuối, quá nữa thì giữ nguyên (freeze) — không bao giờ extrapolate xa vì sai còn xấu hơn đứng.
- **Adaptive delay:** nếu tỉ lệ buffer cạn cao → tăng delay (tối đa ~200ms); mạng tốt kéo
  dần về 100ms. Đổi delay phải trượt từ từ (vài ms mỗi frame) để không thấy time-warp.
- Snapshot đến bị trễ/đảo thứ tự: bỏ snapshot cũ hơn cái mới nhất đã có (state sync chỉ
  cần bản mới nhất — với delta xem [005](005-serialization.md) §4).

## 7. Wire messages Phase 1

**[ĐỀ XUẤT]** tập message tối thiểu (format bit-level ở [005](005-serialization.md)):

| Chiều | Message | Nội dung chính |
|---|---|---|
| C→S | `INPUT` | seq mới nhất + N input redundant (mỗi cái: seq, tick, payload) |
| S→C | `SNAPSHOT` | serverTick, lastProcessedSeq (per client), lateInputs, entity states |
| C→S | `PING` | clientTime |
| S→C | `PONG` | clientTime echo, serverTick, serverTimeInTick |

Join/leave/reservation đi qua kênh Colyseus có sẵn (JSON, tần suất thấp — không cần tối ưu).

**Kiến trúc client M3** ([ĐỀ XUẤT]): `@gm-net/client` tách **runtime khỏi transport**
(`GameClient` nói qua interface `ClientTransport`, không import Colyseus/DOM) — cùng triết
lý `RoomEngine`↔`GameRoom` phía server, để test netcode bằng transport giả (loopback
in-memory) không cần socket. `colyseusTransport()` là adapter mỏng duy nhất biết colyseus.js.
Nghiệm thu M3 chạy ở tầng loopback (giống M2 chốt "2 client echo" ở tầng `RoomEngine`);
e2e socket thật để dành M5. **Lưu ý version:** server `colyseus` 0.17, client `colyseus.js`
mới nhất còn 0.16 — join + `onMessage`/`sendBytes` ổn định, nhưng ghim lại theo bản khớp
khi làm e2e M5 nếu lệch protocol.

## 8. Metrics tối thiểu phải đo từ Phase 1

**[ĐỀ XUẤT]** (Phase 3 mới làm dashboard, nhưng counter phải cắm từ đầu vì demo tuần đầu
cần đo misprediction):

- Client: misprediction/s, biên độ correction (m), RTT + jitter, tỉ lệ buffer
  interpolation cạn, inputLead hiện tại.
- Server: tick duration (ms, p50/p99), input muộn/tick, kích thước snapshot (byte),
  bandwidth per client.
