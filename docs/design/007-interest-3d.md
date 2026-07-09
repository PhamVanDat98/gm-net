# Design 007 — 3D & Interest Management (đặc tả Phase 4)

Trạng thái: **Phác thảo định hướng — chi tiết hóa khi Phase 3 xong.** Phần 3D encode có thể làm sớm hơn nếu cần demo three.js.

## 1. Nén dữ liệu 3D

### `quat()` — smallest-three compression

Quaternion đơn vị: chỉ cần 3 thành phần + biết thành phần lớn nhất (thành phần thứ 4 = sqrt(1-a²-b²-c²), dấu chuẩn hóa về dương bằng cách negate cả quaternion nếu cần).

```
wire := u32:  [2 bit: index của thành phần lớn nhất][3 × 10 bit: 3 thành phần còn lại]
```

- Mỗi thành phần còn lại ∈ [-1/√2, 1/√2] → quantize 10 bit: `round((v + 0.7071) / 1.4142 * 1023)`.
- 4 byte thay vì 16 (4×f32) — đủ chính xác cho render (~0.1°).
- Interp hint mặc định của quat: `slerp` (thêm kind interp thứ 4 vào 004 §10; StateView implement slerp chuẩn, fallback nlerp nếu 2 quat gần nhau).
- Vào schema như leaf đơn (1 bit mask), kind `quat`, param 0.

### vec3 position

Không cần gì mới — `vec3(quantized(0.01))` đã có từ 004. Docs 3D lưu ý chọn step theo world scale.

## 2. Interest management (AOI — area of interest)

### Vấn đề

Phòng đông (50+ entity): gửi mọi entity cho mọi client là lãng phí và lộ thông tin (wallhack). Mỗi client chỉ nên nhận entity "liên quan".

### Thiết kế

```ts
class ArenaRoom extends SyncRoom {
  static interest = gridInterest({
    cellSize: 200,                       // world units
    radius: 2,                           // cells quanh cell của client
    positionOf: (entity) => entity.pos,  // đọc từ state
    anchorOf: (client, state) => ...,    // vị trí client (thường là entity của họ)
  })
}
// 3D: octreeInterest({...}) cùng interface — v1 có thể chỉ ship gridInterest 3D (grid 3 chiều) trước octree
```

- Chạy per-tick TRƯỚC bước diff per-client: tính `visibleSet(client): Set<entityId>`. Singleton (id 0) luôn visible.
- **Delta per-client giờ diff trên visible set**: entity rời visible set của client = `removed` (dù vẫn sống trên server); vào visible set = `added` (full encode). Cơ chế wire KHÔNG đổi — tái dùng hoàn toàn added/removed của DELTA. Đây là lý do design 002 chọn removed/added generic.
- Ring buffer hiện lưu TickSnapshot toàn cục; per-client cần thêm `visibleSet` đã gửi ở baseline tick → lưu per-client history 64 tick của visibleSet (Set nhỏ, structural sharing khi không đổi).
- Hysteresis chống flicker ở biên: radius vào < radius ra (mặc định ra = vào + 0.5 cell).

## 3. Ví dụ & docs Phase 4

- `examples/three-3d`: phòng 3D, di chuyển + xoay (quat), 20 NPC đi lại — chứng minh AOI: client chỉ nhận entity gần.
- `examples/babylon-3d`: port từ three-3d (chứng minh engine-agnostic — chỉ đổi lớp render).
- Metrics hook (backlog BRAINSTORM, làm ở phase này): `client.stats()` + `room.stats()` — bytes in/out/s, snapshot size trung bình, entity count visible. Docs "đo băng thông game của bạn".

## 4. Docs site (milestone Phase 4)

Cấu trúc `docs/` cho người dùng cuối (tiếng Anh, build bằng VitePress hoặc tương đương):
1. Concepts: authority, tick, snapshot interpolation, prediction — dịch/viết lại từ design docs, có hình.
2. Getting started: vanilla → per-engine (Phaser/Three/Babylon).
3. Recipes: lobby UI, chat, reconnect UX, hiển thị ping, network debug overlay.
4. API reference: sinh từ TSDoc (typedoc).
Định nghĩa xong: người mới làm theo getting-started có game 2 người di chuyển trong < 30 phút.
