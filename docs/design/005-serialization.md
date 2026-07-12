# 005 — Binary serialization

Căn cứ: BRAINSTORM.md §3 (dòng Serialization: "Tự viết bit-packing (DataView/ArrayBuffer),
quantize position (16-bit fixed point), delta compression") và §4 Phase 1 ("Binary
serialization + quantization"), Phase 2 ("Delta compression so với baseline đã ack").

**[CHỐT]**: tự viết trên `DataView`/`ArrayBuffer`; quantize position 16-bit fixed point;
delta compression (Phase 2). Mọi format cụ thể dưới đây là **[ĐỀ XUẤT]** — chốt dần khi code,
nhưng đổi format thì phải cập nhật doc này (đây sẽ là đặc tả wire duy nhất).

## 1. Nguyên tắc chung

- Little-endian toàn bộ (mặc định của x86/ARM, `DataView` chỉ định rõ mỗi lần đọc/ghi).
- Writer/reader dạng cursor (`BitWriter`/`BitReader` trong `@gm-net/core`): hỗ trợ ghi
  theo bit (cờ, bitmask) lẫn theo byte (u8/u16/u32/f32) — pack cờ theo bit, số theo byte
  cho cân bằng giữa gọn và tốc độ.
- Mọi message mở đầu bằng 1 byte `messageType`.
- Phiên bản protocol: 1 byte `protocolVersion` trao trong handshake join (không lặp lại
  trong từng message); lệch version → từ chối join.

## 2. Quantization

**[CHỐT]** position 16-bit fixed point. **[ĐỀ XUẤT]** tham số hóa:

- **Position:** map dải thế giới `[worldMin, worldMax]` vào u16 (65536 mức).
  Ví dụ map 300×300m → độ phân giải ~4.6mm — dưới ngưỡng mắt thấy ở scale game thường.
  `worldBounds` là config của game (trong `shared` của game), không hard-code framework.
- **Rotation 2D:** góc → u16 (65536 mức trên 2π ≈ 0.0055°).
- **Velocity:** dải `[-vMax, vMax]` (config game) → i16 per trục. Cần gửi velocity cho
  local player (reconciliation so cả velocity) và để extrapolate remote.
- **Quy tắc quan trọng — quantize cả hai phía so sánh:** khi client so state dự đoán với
  state server (reconciliation), phải so *giá trị đã quantize* với *giá trị đã quantize*,
  nếu không sai số quantization sẽ đọc nhầm thành misprediction thật.

## 3. Format `SNAPSHOT` (full)

```
u8  messageType = SNAPSHOT
u32 serverTick
u16 lastProcessedSeq      ← ack cho riêng client nhận (ghi lúc gửi từng client)
u8  lateInputs            ← số input muộn KỂ TỪ SNAPSHOT TRƯỚC, clamp 255 (cho adaptive
                            input lead; delta per-snapshot, không phải tổng tích lũy —
                            tổng chỉ tăng sẽ bão hòa u8 và làm chết tín hiệu)
u16 entityCount
entity × entityCount:
  u16 entityId
  u8  entityType          ← game định nghĩa; quyết định layout phần custom
  u16 posX, posY          ← quantized
  u16 rot                 ← quantized
  i16 velX, velY          ← quantized
  [custom fields]         ← encoder của game (xem §5)
```

Entity id: u16 do server cấp khi spawn, tái sử dụng sau khi despawn được báo hết.

## 4. Delta compression (Phase 2)

**[CHỐT]** cơ chế: chỉ gửi field thay đổi **so với baseline mà client đã ack**.

**[ĐỀ XUẤT]** thiết kế:

- Client ack tick snapshot mới nhất đã nhận (đính vào packet `INPUT` — 4 byte, khỏi tốn
  message riêng). Server giữ, per client, snapshot gần nhất được ack làm **baseline**.
- `DELTA` = so với baseline: bitmask entity thay đổi; mỗi entity thay đổi mang bitmask
  field + chỉ các field đó. Entity mới → full block; entity biến mất → danh sách despawn id.
- Server giữ vòng ~1s snapshot đã gửi để làm baseline (dùng chung ring buffer với lag
  compensation nếu tiện). Baseline già hơn 1s (client ngộp/loss dài) → gửi lại **full
  snapshot** (keyframe). Join/reconnect → luôn full snapshot đầu tiên.
- Vì WebSocket là TCP (in-order, reliable), ack chỉ trễ chứ không mất — mô hình baseline
  đơn giản hơn nhiều so với trên UDP.

## 5. Custom fields của game

Framework không biết field gameplay (HP, ammo, trạng thái anim…). Game đăng ký per
`entityType` một cặp:

```ts
{ encode(writer, entity): void; decode(reader): CustomState }
```

Framework lo phần transform + envelope + delta bitmask ở mức field-group; custom block
được delta ở mức "có đổi/không đổi" (so bytes) trước, tinh vi hơn tính sau.

## 6. Format `INPUT`

```
u8  messageType = INPUT
u32 ackTick               ← snapshot tick mới nhất client đã nhận (phục vụ §4)
u16 latestSeq
u8  count                 ← số input trong packet (redundancy 3–5)
input × count (từ cũ → mới):
  (seq suy ra: latestSeq - count + 1 + i)
  u32 tick
  [payload]               ← encoder input của game
```

## 6b. Format `PING` / `PONG`

**[ĐỀ XUẤT]** (BRAINSTORM chỉ chốt "clock sync"; format cụ thể chốt tại M1). Dùng
cho đo RTT + ước lượng đồng hồ/tick server ([004] clock sync). Thời gian cắt còn u32 ms
(wrap ~49 ngày — dư cho RTT vì client trừ với chính đồng hồ mình).

⚠️ **Hệ quả bắt buộc:** `Date.now()` (~1.78e12) **không lọt u32** → clientTime trên dây là
bản đã cắt. Client phải tính RTT bằng **số học wrap u32** (`u32TimeDelta` trong core, cùng
họ với `seqDistance`), không trừ thẳng `receivedAt − clientTime`. Trừ thẳng cho ra RTT
~1.78e12 ms → `serverTickNow` ~2.7e10 → `PredictionWorld.advance()` step hàng tỉ lần → treo
cứng client. Hồi quy khoá ở `packages/client/test/clock.test.ts` ("đồng hồ thật (epoch ms >
u32)").

```
PING
u8  messageType = PING
u32 clientTime            ← đồng hồ client lúc gửi

PONG
u8  messageType = PONG
u32 clientTime            ← echo lại clientTime của ping
u32 serverTime            ← đồng hồ server lúc trả
u32 serverTick            ← tick server lúc trả (ước lượng serverTickNow)
```

## 7. Kích thước ước tính (sanity check)

Full snapshot, entity transform-only: 2+1+4+4+2 = 13 byte/entity + header ~10 byte.
10 entity ≈ 140 B × 30Hz ≈ **4.2 KB/s** mỗi client trước delta — đã rất nhỏ; delta Phase 2
chủ yếu để scale số entity lớn (AOI + delta mới là bộ đôi cho 100+ entity).

## 8. Test bắt buộc

- Round-trip: encode → decode == input (modulo sai số quantize đã định nghĩa).
- Golden bytes: vài buffer mẫu cố định — đổi format là test đỏ, ép cập nhật doc này.
- Fuzz decoder: bytes rác không được crash/hang (server nhận dữ liệu không tin được).
- Delta: chuỗi snapshot + ack ngẫu nhiên → client tái dựng state == server state (property test).
