# Design 004 — Schema & Serialization (đặc tả triển khai Phase 2, phần 1)

Trạng thái: **Đặc tả — code theo đúng tài liệu này. Nếu phát hiện mâu thuẫn/thiếu sót, cập nhật tài liệu TRƯỚC khi code khác đi.**

Vị trí code: `packages/core/src/schema/` (isomorphic — cấm import Node API).

## 1. Phạm vi Phase 2

Có: primitives, `quantized`, `str`, `bool`, `vec2`, `vec3`, nested entity, `map()` ở root, root scalars (singleton), interp hints, schema hash, full encode, delta encode với change mask.

**Hoãn (không code ở Phase 2):** `optional()`, `list()`, `quat()` (smallest-three — design 007), string key, map lồng trong entity.

## 2. Public API

```ts
// Kiểu leaf — mỗi hàm trả về một FieldType descriptor (immutable, chainable)
export const u8, u16, u32, i8, i16, i32, f32, f64, varint, svarint, bool: FieldType<number|boolean>
export function str(maxBytes?: number): FieldType<string>          // mặc định 255
export function quantized(step: number): FieldType<number>         // svarint(round(v/step))
export function vec2<T>(t: FieldType<number>): FieldType<{x,y}>    // 2 leaf
export function vec3<T>(t: FieldType<number>): FieldType<{x,y,z}>  // 3 leaf

// Interp hint — method trên descriptor số, trả descriptor mới
type.lerp()       // nội suy tuyến tính (mặc định của f32/f64/quantized và vec của chúng)
type.step()       // không nội suy (mặc định của int/bool/str/varint)
type.lerpAngle()  // lerp góc radian có wrap qua ±PI (đường ngắn nhất)

// Entity & state
export function entity<S extends Shape>(name: string, shape: S): EntityDef<S>
export function map<E>(entityDef: EntityDef<E>, maxEntities?: number): MapDef<E>  // mặc định 1024
export function state<S>(shape: S): StateDef<S>  // shape = mix của MapDef và FieldType (root scalars)
export type Infer<T> // suy ra kiểu TS plain object từ EntityDef/StateDef

export function schemaHash(stateDef: StateDef): number  // u32
```

Ví dụ chuẩn (dùng trong docs + test):

```ts
const Player = entity('Player', {
  pos: vec2(quantized(0.01)),
  angle: quantized(0.001).lerpAngle(),
  hp: u8,
  name: str(32),
  ownerId: str(24),          // pattern ownership: client so với client.clientId của mình
})
const Bullet = entity('Bullet', { pos: vec2(quantized(0.01)), vel: vec2(quantized(0.01)) })
const GameState = state({
  matchTimer: f32,           // root scalar → singleton entity
  players: map(Player, 64),
  bullets: map(Bullet, 256),
})
```

## 3. Mô hình dữ liệu nội bộ

Mọi entity được **phẳng hóa thành danh sách leaf** theo thứ tự khai báo (đệ quy depth-first):
`Player → [pos.x, pos.y, angle, hp, name, ownerId]` (6 leaf).

```ts
interface LeafDef {
  path: string          // 'pos.x'
  kind: LeafKind        // 'u8'|'i32'|'f32'|...|'varint'|'svarint'|'bool'|'str'|'quantized'
  param: number         // step của quantized / maxBytes của str / 0
  interp: 'lerp' | 'step' | 'lerpAngle'
  encode(w: ByteWriter, v: unknown): void
  decode(r: ByteReader): unknown
}
interface EntityMeta { name: string; leaves: LeafDef[]; maskBytes: number } // maskBytes = ceil(leaves.length/8)
interface CollectionMeta { id: number; name: string; entity: EntityMeta; maxEntities: number }
```

Ràng buộc kiểm tra **ngay khi `entity()`/`state()` chạy** (ném `SchemaError` với thông điệp dẫn hướng):
- \>64 leaf/entity → "tách thành nested entity/bỏ bớt field".
- \>250 collection, tên field chứa ký tự ngoài `[a-zA-Z0-9_]`, `quantized(step<=0)`, `str(maxBytes>4096)`.
- `state()` chỉ nhận `map()` và FieldType ở root; map trong entity → lỗi.

## 4. Collection id & singleton

- `collectionId` (u8) = thứ tự khai báo map trong `state()`: `players`=0, `bullets`=1...
- Root scalars gom thành **singleton entity ẩn**: `collectionId = 255`, `entityId = 0`, luôn tồn tại, không spawn/despawn. Leaf theo thứ tự khai báo root scalar.

## 5. Entity id

- Cấp phát per-room, varint, bắt đầu **1**, tăng đơn điệu, **không tái sử dụng** (id 0 dành cho singleton).
- Id là duy nhất trong cả room (xuyên mọi collection) → removed-list trong delta chỉ cần id.
- API runtime (thuộc design 005): `spawn(collectionName, init)` trả object có `id` (property non-enumerable, readonly). `despawn(collectionName, id)`.

## 6. Schema hash

FNV-1a 32-bit trên chuỗi canonical:

```
canonical := join(';',
  cho mỗi collection theo thứ tự: `${collectionId}:${collectionName}:${entityName}` +
    join(',', mỗi leaf: `${leafIndex}:${path}:${kind}:${param}`)
) + '|root:' + (tương tự cho singleton leaves)
```

- Interp hint **không** vào hash (không ảnh hưởng wire format — client cũ/mới vẫn decode được).
- `maxEntities`, `maxBytes` của str **có** vào hash (`param`).
- Hash gửi trong HELLO; NetServer/NetClient Phase 1 đã có sẵn tham số `schemaHash` — chỉ cần nối vào.

## 7. Full encode một entity

Ghi tuần tự mọi leaf theo thứ tự, không mask, không length prefix (độ dài tự mô tả theo kind):

```
fullEntity := entityId(varint) collectionId(u8) leafValue{leaves.length}
```

Encode leaf: theo bảng kind → phương thức ByteWriter tương ứng. `quantized`: `svarint(Math.round(v/step))`, decode `n*step`. `bool`: u8 0/1. `str`: varint len + utf8, **encode phải throw nếu len > maxBytes** (server không được gửi bừa), decode throw nếu len > maxBytes (chống packet độc).

## 8. Delta encode (change mask)

```
changedEntity := entityId(varint) mask(maskBytes) changedLeafValues
```

- Bit i của mask = leaf thứ i có mặt trong payload. **Bit order: leaf i → byte `i >> 3`, bit `i & 7`** (LSB-first trong mỗi byte).
- `changedLeafValues`: chỉ các leaf có bit bật, theo thứ tự leaf index tăng dần.
- Mask toàn 0 hợp lệ về format nhưng server **không được gửi** entity không đổi (lãng phí) — encoder bỏ qua entity có mask 0.

## 9. Thuật toán diff per-tick (server)

Server giữ cho mỗi entity một **bảng leaf bytes** của tick trước:

```ts
interface EntitySnapshot {
  collectionId: number
  buf: Uint8Array        // toàn bộ leaf values nối tiếp (đúng thứ tự full encode, không id/collectionId)
  offsets: Uint16Array   // offsets.length = leaves.length + 1; leaf i = buf[offsets[i]..offsets[i+1])
}
type TickSnapshot = Map<number /*entityId*/, EntitySnapshot>  // gồm cả singleton id 0
```

Mỗi tick:
1. Encode mọi entity hiện tại thành `EntitySnapshot` mới (scratch ByteWriter tái sử dụng, `finish()` copy).
   - Tối ưu cho phép: nếu bytes mới === bytes cũ (so sánh), **tái sử dụng object EntitySnapshot cũ** (structural sharing) để ring buffer rẻ.
2. So với TickSnapshot của tick trước: so từng leaf bằng so sánh byte range. Khác → bit mask.
3. Kết quả tick: `{ tick, snapshot: TickSnapshot }` đẩy vào ring buffer (design 005).

Diff giữa 2 TickSnapshot bất kỳ (current vs baseline của từng client):
- `removed` = id ∈ baseline ∖ current (trừ id 0)
- `added` = id ∈ current ∖ baseline → full encode
- `changed` = id ∈ cả hai, có leaf khác bytes → mask encode
- Nếu cả 3 rỗng → **vẫn gửi DELTA header** (client cần tick để đo nhịp + ack).

Budget hiệu năng (gate bằng test, xem §11): 64 entities × 8 leaf, encode+diff **< 0.5ms** trung bình trên Node.

## 10. Interp hint lúc decode

`EntityMeta.leaves[i].interp` là dữ liệu cho client view (design 005 §5). Quy tắc mặc định gán khi build descriptor: `f32/f64/quantized` (và vec của chúng) → `lerp`; còn lại → `step`. `.lerpAngle()` chỉ hợp lệ trên kind số — gọi trên str/bool → SchemaError.

## 11. Test bắt buộc (checklist cho người triển khai)

`packages/core/test/schema.test.ts`:
- [ ] Roundtrip full encode/decode mọi kind, gồm giá trị biên (0, âm, NaN cấm → throw khi encode f32? — **không**: NaN đi qua f32 bình thường, đó là việc của game logic).
- [ ] `quantized(0.01)`: roundtrip sai số ≤ step/2; giá trị âm.
- [ ] Leaf flattening đúng thứ tự khai báo; đổi thứ tự khai báo → hash đổi.
- [ ] 65 leaf → SchemaError có chữ 'nested'; map trong entity → SchemaError.
- [ ] Hash: ổn định giữa 2 lần chạy; đổi step/maxBytes/tên → đổi; đổi interp hint → **không** đổi.
- [ ] Delta: đổi 1 leaf → mask đúng 1 bit, payload chỉ chứa leaf đó; mask bit order đúng đặc tả §8 (test với entity 9+ leaf để phủ byte thứ 2).
- [ ] Diff: entity không đổi không xuất hiện; add/remove đúng; str đổi độ dài.
- [ ] Perf gate: benchmark encode+diff 64×8 leaf < 0.5ms (dùng `it` thường, chạy 100 vòng lấy trung bình, threshold nới 3× để CI không flaky: assert < 1.5ms).
- [ ] **Type-level test** (vùng rủi ro TS cao nhất — dùng `expectTypeOf` của vitest): `Infer<typeof Player>` cho đúng `{pos: {x: number, y: number}, angle: number, hp: number, name: string, ownerId: string}`; `Infer<typeof GameState>` cho `players: Map<number, ...>` và root scalar `matchTimer: number`; field sai kiểu khi gán → lỗi compile.
