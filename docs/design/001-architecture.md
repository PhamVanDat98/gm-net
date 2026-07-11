# 001 — Kiến trúc tổng thể

Căn cứ: BRAINSTORM.md §1 (sơ đồ + nguyên tắc cốt lõi), §5 (quyết định 3, 6).

## 1. Mục tiêu và phạm vi

**[CHỐT]** gm-net là framework multiplayer cho game JS 2D & 3D với bốn trụ cột kỹ thuật:

1. **Server-authoritative physics** — server là nguồn sự thật duy nhất về trạng thái game.
   Client không bao giờ được tin; mọi input đều đi qua mô phỏng phía server.
2. **Client-side prediction** — local player phản hồi input ngay lập tức (0 frame delay),
   không chờ round-trip.
3. **Server reconciliation** — khi kết quả authoritative về tới client, client so với dự
   đoán của mình; nếu lệch thì rollback về state server, replay các input chưa được ack.
4. **Snapshot interpolation** — remote entities được render "trong quá khứ" (~100ms) bằng
   nội suy giữa hai snapshot đã nhận → mượt kể cả khi mạng jitter.

**[CHỐT]** Render-agnostic: framework không render gì cả, chỉ expose interpolated state.
Adapter mẫu cho Pixi/Three viết sau, nằm ngoài core.

**Ngoài phạm vi** (suy ra từ tài liệu khởi tạo): lockstep/rollback netcode (không cần vì
đã chọn server-authoritative — xem quyết định 2 trong [003](003-tech-stack.md)), voice chat,
persistence/database layer.

## 2. Các thành phần

```
┌─────────────┐         ┌──────────────────┐
│  Matchmaker  │◄──────►│  Redis            │
│  (stateless) │         │  (queue/registry) │
└──────┬──────┘         └──────────────────┘
       │ assign room
       ▼
┌─────────────────────────────┐
│  Game Servers (stateful)     │
│  - Room lifecycle (Colyseus) │
│  - Fixed-tick physics loop   │
│  - Binary snapshot broadcast │
└──────┬──────────────────────┘
       │ WebSocket (binary)
       ▼
┌─────────────────────────────┐
│  Client                      │
│  - Prediction (local player) │
│  - Reconciliation            │
│  - Interpolation (remote)    │
│  - Render adapter (Pixi/Three/Unity WebGL) │
└─────────────────────────────┘
```

### Game Server (stateful)

**[CHỐT]** Mỗi room là một thực thể stateful sống trong một process cụ thể (sticky):
- Room lifecycle + seat reservation dùng Colyseus (chi tiết: [006](006-server-rooms.md)).
- Vòng lặp physics fixed-tick (30Hz) chạy Rapier world — cùng simulation code với client.
- Broadcast snapshot dạng binary tự đóng gói (không dùng schema sync của Colyseus).

### Client

**[CHỐT]** Client runtime gồm 4 khối: prediction cho local player, reconciliation,
interpolation cho remote entities, và render adapter cắm ngoài. Có headless mode
(không render) để làm bot fill room và load test (Phase 2).

### Matchmaker (stateless, optional)

**[CHỐT]** Tách hoàn toàn khỏi core (quyết định 3): game room stateful và matchmaker
stateless scale theo cách khác nhau. Giao tiếp qua Redis (queue, pub/sub, server registry).
**Framework phải dùng được mà không cần matchmaker** — client kết nối thẳng vào game server
cũng chạy. Chi tiết: [007](007-matchmaker.md).

## 3. Nguyên tắc cốt lõi: shared simulation

**[CHỐT]** Simulation logic nằm trong package `shared`, được import bởi **cả client lẫn
server**. Đây là lý do chọn JS full-stack: prediction chỉ đúng khi client chạy *đúng cùng
một đoạn code* mô phỏng như server.

Hệ quả thiết kế:

- Mọi rule gameplay (di chuyển, bắn, va chạm response) viết trong `shared` dưới dạng hàm
  thuần trên (state, input) → state; **không** được tham chiếu DOM, Colyseus, socket hay
  bất cứ thứ gì chỉ có ở một đầu.
- Physics dùng Rapier WASM — cùng một binary chạy Node lẫn browser → hai đầu mô phỏng
  gần như identical (xem [003](003-tech-stack.md) về determinism).
- `shared` chứa luôn input schema và constants (tick rate, giới hạn tốc độ…) để hai đầu
  không bao giờ lệch config.

## 4. Luồng dữ liệu

### Chiều client → server (input)

```
[Client tick t]
  đọc input thiết bị → InputCommand { seq, tick, payload }
  ├─ apply ngay vào simulation local (prediction)
  ├─ đẩy vào pending buffer (chờ ack)
  └─ gửi lên server (kèm vài input trước đó để chống packet loss — [ĐỀ XUẤT], xem 004 §4)
```

### Chiều server → client (snapshot)

```
[Server tick T]
  gom input đến hạn của mọi client (input buffer per-client)
  → step Rapier world 1 tick
  → đóng gói snapshot binary: state các entity + lastProcessedSeq per client
  → broadcast (Phase 2: lọc theo AOI, delta so với baseline đã ack)

[Client nhận snapshot]
  ├─ local player: reconciliation — so với prediction tại tick tương ứng,
  │  lệch → restore + replay input chưa ack (004 §5)
  └─ remote entities: đẩy vào interpolation buffer, render trễ ~100ms (004 §6)
```

### Chiều matchmaker (Phase 3)

```
Client → Matchmaker: "tìm trận"
Matchmaker → Redis: queue + tra registry server còn chỗ
Matchmaker → Game server: tạo/tìm room, seat reservation
Matchmaker → Client: { serverEndpoint, reservationToken }
Client → Game server: connect WebSocket + nộp token
```

## 5. Mô hình tin cậy

**[ĐỀ XUẤT]** (hệ quả tất yếu của server-authoritative, ghi rõ để giữ kỷ luật khi code):

- Client chỉ gửi **input**, không bao giờ gửi state/position. Server không có code path
  nào nhận vị trí từ client.
- Server validate input: clamp giá trị (trục analog trong [-1,1]), giới hạn tần suất
  (không nhận quá X input/tick), bỏ input có tick quá xa quá khứ/tương lai.
- Snapshot gửi xuống client là dữ liệu công khai trong phạm vi AOI — chống wallhack toàn
  cục thuộc Phase 2 (AOI), không phải Phase 1.
