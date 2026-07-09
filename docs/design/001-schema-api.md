# Design 001 — Schema API

Trạng thái: **Đã chốt (2026-07-09) — sẵn sàng code Phase 2**

Schema là API người dùng chạm vào nhiều nhất và khó sửa nhất sau khi phát hành. Tài liệu này chốt hình dáng API trước khi viết dòng code nào.

## Mục tiêu

- Khai báo state một lần, dùng được cả client lẫn server (isomorphic).
- Sinh ra: binary encoder/decoder, delta encoder, TypeScript types (inference).
- Người dùng JS thuần dùng được — **không dùng decorator** (cần config build riêng, không chạy trong JS thuần).
- State là **plain object** — người dùng mutate trực tiếp, không cần gọi setter đặc biệt.

## Hình dáng API (kiểu zod/builder — đã chốt)

```ts
import { entity, state, map, f32, u8, u16, str, bool, vec2, quantized, Infer } from '@gm-net/core'

const Player = entity('Player', {
  pos: vec2(quantized(0.01)),  // lượng tử hóa bước 0.01 → varint, tiết kiệm ~70% so với f32
  angle: quantized(0.001),
  hp: u8,
  score: u16,
  name: str,                    // chỉ gửi khi thay đổi (delta), string ít đổi nên rẻ
  alive: bool,
})

const GameState = state({
  players: map(Player),         // key = entityId (varint), quản lý add/remove tự động
  bullets: map(Bullet),
})

// Type inference — không cần viết interface tay
type PlayerT = Infer<typeof Player>  // { pos: {x,y}, angle: number, hp: number, ... }
```

Lý do chọn builder thay vì decorator (kiểu Colyseus):

| | Builder (chọn) | Decorator |
|---|---|---|
| JS thuần | ✅ chạy ngay | ❌ cần Babel/TS config |
| Type inference | ✅ `Infer<>` như zod | phải khai báo class + type 2 lần |
| Serialization order | ✅ theo thứ tự khai báo object literal | phụ thuộc metadata reflection |

## Kiểu dữ liệu

### Nguyên thủy

| Kiểu | Wire size | Ghi chú |
|---|---|---|
| `u8, u16, u32` | 1/2/4 bytes | |
| `i8, i16, i32` | 1/2/4 bytes | |
| `f32, f64` | 4/8 bytes | |
| `varint` | 1–5 bytes | unsigned LEB128 |
| `svarint` | 1–5 bytes | zigzag + LEB128, cho số âm |
| `bool` | 1 byte (v1) | v2: gom bit vào change mask |
| `str` | varint len + utf8 | giới hạn mặc định 255 bytes, server validate |
| `quantized(step)` | varint | `round(value/step)` → svarint. Bước 0.01 cho position là đủ với game 2D/3D thường |

### Tổ hợp

| Kiểu | Cấu tạo |
|---|---|
| `vec2(t)`, `vec3(t)` | `{x, y}` / `{x, y, z}` cùng kiểu t |
| `quat` | v1: 4×quantized; v2: smallest-three compression (29 bits) |
| `map(entity)` | key = entityId varint; hỗ trợ add/remove/change trong delta |
| `list(t, maxLen)` | mảng ngắn cố định max length (inventory, v.v.) — **không** dùng cho entities |
| `optional(t)` | 1 bit trong presence mask |
| Nested entity | entity lồng trong entity, phẳng hóa khi encode |

## Mô hình mutation: plain object + per-tick diff (đã chốt)

Hai lựa chọn đã cân nhắc:

1. **Dirty-tracking proxy** (Colyseus): mutate qua Proxy, lib biết ngay field nào đổi. Nhanh khi ít thay đổi, nhưng: object không còn "plain" (đau khi debug/serialize/console.log), edge case với nested/array, chi phí proxy trên mọi property access.
2. **Per-tick diff** (nengi-style, **chọn**): state là plain object thật. Mỗi tick server encode state theo schema rồi so với bản encode của tick trước ở mức field. Chi phí = encode toàn bộ state mỗi tick — chấp nhận được với 16 người/phòng (đo lại ở Phase 2, budget: <1ms cho 16 entities × 20 fields).

Hệ quả cho người dùng — code server tự nhiên tối đa:

```ts
room.state.players.get(id).hp -= 10   // chỉ vậy, không markDirty()
```

## Schema registry & hash

- Mỗi `entity()` đăng ký vào registry với id tăng dần (u8 — tối đa 256 loại entity).
- **Thứ tự khai báo quyết định wire format** → client và server phải import cùng file schema (shared module) — đây là pattern bắt buộc, docs phải nói rõ.
- `schemaHash` (FNV-1a 32-bit trên chuỗi mô tả toàn bộ registry) gửi trong handshake — lệch hash là từ chối kết nối ngay với error rõ ràng, thay vì lỗi giải mã khó hiểu sau đó.

## Ngoài scope v1

- Inheritance giữa các entity (dùng composition).
- Union types / polymorphic field.
- Migration schema tự động giữa version.

## Các quyết định đã chốt (2026-07-09)

1. **`map()` key = varint id do thư viện cấp.** API `room.spawn(collection, {...})` trả về entity đã có `id`; user tự lưu liên kết client↔entity (vd `client.data.player = p`). Không cho string key — key string bị lặp trong mọi delta, phá mục tiêu băng thông.
2. **Giới hạn cứng 64 field/entity.** Change mask luôn ≤ 8 byte. Schema >64 field ném lỗi ngay lúc `entity()` chạy, thông điệp hướng dẫn tách nested entity.
3. **Interpolation hint nằm trong schema, có mặc định thông minh.** Mặc định: float/vec → lerp, int/bool/string → step. Ghi đè khi đặc biệt: `.lerpAngle()` (góc có wrap-around), `.slerp()` (quaternion), `.step()` (float không muốn nội suy). Client render tự đọc hint từ schema — một nguồn sự thật.
