# Design 005 — State Sync Runtime (đặc tả triển khai Phase 2, phần 2)

Trạng thái: **Đặc tả — code theo đúng tài liệu này.** Phụ thuộc: design 004 (schema) phải xong trước.

## 1. Wire format ba message data-plane (chốt, thay thế phác thảo trong 002)

```
SNAPSHOT (0x21, S→C) :=
  tick(varint) serverTime(f64) lastInputSeq(varint)
  entityCount(varint) fullEntity{entityCount}

DELTA (0x22, S→C) :=
  tick(varint) serverTime(f64) lastInputSeq(varint) baselineTick(varint)
  removedCount(varint) entityId(varint){removedCount}
  addedCount(varint) fullEntity{addedCount}
  changedCount(varint) changedEntity{changedCount}

INPUT (0x20, C→S) :=
  seq(varint) ackTick(varint) count(u8) inputFrame{count}
```

- `fullEntity`, `changedEntity`: theo design 004 §7–8.
- `serverTime`: `Date.now()` của server lúc gửi — client dùng để map tick→thời gian (bền với drift của tick loop).
- `lastInputSeq`: seq input lớn nhất của **client nhận packet này** mà server đã xử lý. Phase 2 luôn 0 (chưa có input frame). Phase 3 dùng cho reconciliation.
- `ackTick`: tick S→C mới nhất client đã áp dụng thành công; 0 = chưa có. Tick server bắt đầu từ **1**.
- Phase 2: client gửi INPUT với `count=0` (pure ack). `seq`=0. Phase 3 mới có inputFrame (design 006).
- Decode 3 message này thêm vào `core/src/protocol/messages.ts`, cần `StateDef` để biết format → **hàm decode nhận thêm tham số schema context**: mở rộng `DecodeLimits` thành `DecodeContext { limits?, stateDef? }`; gặp 0x20–0x22 mà không có stateDef → ProtocolError. Union `Message` thêm 3 nhánh: `{type:'input', seq, ackTick, frames: Uint8Array[]}` (Phase 2 frames luôn []), `{type:'snapshot', ...}`, `{type:'delta', ...}` — payload entity giữ dạng đã decode: `DecodedEntity { id, collectionId, values: unknown[] /*theo leaf index; delta: sparse, kèm mask*/ }`.

## 2. Server: `SyncRoom`

`packages/server/src/sync-room.ts`. Kế thừa `Room` Phase 1, **không sửa Room cũ**.

```ts
export abstract class SyncRoom<TState extends StateDef, Options = unknown> extends Room<Options> {
  static stateDef: StateDef                    // subclass BẮT BUỘC gán
  readonly state: Infer<TState>                // plain object user mutate tự do
  tickRate = 20                                // override được per-class; đưa vào WELCOME
  onTick?(dtMs: number): void                  // gọi mỗi tick TRƯỚC khi encode/gửi

  spawn<K extends keyof collections>(collection: K, init: EntityInit): EntityWithId
  despawn(collection: K, id: number): void     // idempotent, despawn id lạ = no-op

  // Nội bộ (không public): tickLoop, ring buffer, per-client ack
}
```

- **`state` là plain object**: `{ matchTimer: 0, players: Map<number, PlayerT>, bullets: Map<...> }`. `spawn` tạo object từ init + default (init thiếu field → throw), gắn `id` non-enumerable, put vào Map. User mutate `this.state.players.get(id).hp -= 10` trực tiếp.
- **Tick loop**: `setInterval` KHÔNG đủ chính xác lâu dài nhưng chấp nhận cho v1 với hiệu chỉnh: lưu `expectedNext`, mỗi lần chạy tính `dtMs` thật và đặt lại interval drift > 25%… **Đơn giản hóa cho v1: setInterval(1000/tickRate), dtMs = now - lastTickAt (thực đo), tick counter tăng 1 mỗi lần chạy.** Ghi chú trong code: nâng cấp thành drift-corrected loop khi có yêu cầu.
- Bắt đầu tick khi room được tạo, dừng khi dispose. `NetServer` không đổi — SyncRoom tự quản timer (nhớ clear trong onDispose path; NetServer gọi `onDispose`).

**Pipeline mỗi tick** (sau `onTick`):
1. Encode state → `TickSnapshot` (004 §9), diff với tick trước → đẩy `{tick, serverTime, snapshot}` vào **ring buffer 64 tick**.
2. Với từng client trong room:
   - `ack = ackTick client gửi lên gần nhất` (lưu per-client, cập nhật khi nhận INPUT).
   - Nếu `ack > 0` và tick `ack` còn trong ring buffer → gửi DELTA(baseline=ack).
   - Ngược lại (mới join / baseline rớt khỏi ring / ack=0) → gửi SNAPSHOT full.
   - Client disconnected (đang grace) → bỏ qua, không gửi.
3. Xử lý INPUT đến giữa các tick: chỉ cập nhật `ackTick` per-client (Phase 2), `lastInputSeq` để 0.

**Điểm nối vào NetServer**: `Room.onMessage` hiện nhận EVENT; SNAPSHOT/DELTA/INPUT là message type riêng. `NetServer.dispatch` thêm case `'input'`: nếu `session.room instanceof SyncRoom` → `room._onInput(session.client, m)`, ngược lại bỏ qua (không error — client có thể ack trễ sau khi rời room). INPUT thuộc **data-plane bucket** (đã đúng theo cách phân loại hiện tại: thêm `'input'` vào nhóm không-control cùng ping/event).

## 3. Server → decode phía client cần schema

`NetServer` và `NetClient` nhận `stateDef` option (thay cho `schemaHash` thô — hash tự tính từ stateDef; giữ tương thích: không có stateDef → hash 0, không sync). Truyền xuống decodePacket qua DecodeContext.

## 4. Client: lịch sử tick + áp dụng delta

`packages/client/src/state-sync.ts`:

```ts
type ClientTickState = Map<number /*entityId*/, EntitySnapshot>  // CÙNG representation với server (004 §9)
interface TickEntry { tick: number; serverTime: number; state: ClientTickState }
```

- Nhận SNAPSHOT: dựng ClientTickState từ đầu → push vào history (mảng, giữ ≤ 64 entry, sort theo tick — thực tế luôn tăng).
- Nhận DELTA: tìm entry `baselineTick` trong history. **Không có → bỏ qua packet, KHÔNG ack** (server thấy ack không tiến sẽ tự gửi SNAPSHOT — cơ chế tự phục hồi của design 002). Có → clone structural-sharing: entity không đổi giữ nguyên reference, entity changed tạo EntitySnapshot mới (copy buf, vá leaf), áp removed/added → entry mới.
- Sau khi áp dụng thành công tick T: gửi `INPUT{seq:0, ackTick:T, count:0}`. **Throttle: tối đa 1 ack / 33ms** (đủ cho 30Hz, không vượt rate limit).
- **Budget rate limit (bắt buộc kiểm tra)**: client sync tiêu tốn nền ack ≤30/s + ping 2/s = 32 msg/s, trong khi `dataRatePerSec` mặc định 60 → chỉ còn ~28/s cho EVENT gameplay. Khi room là SyncRoom, `NetServer` phải nâng data bucket của session lên `dataRatePerSec + 40` (hoặc thêm option `syncRateBonus`) — nếu không, game bắn nhanh sẽ bị đá RATE_LIMITED một cách bí ẩn. Thêm e2e test: client trong SyncRoom gửi 25 event/s trong 3s không bị đá.
- Delta/snapshot đến không theo thứ tự tick tăng (không xảy ra trên WS, sẽ xảy ra trên WebRTC): tick ≤ tick mới nhất đã có → bỏ qua.

## 5. Client: `StateView` (interpolation)

```ts
export class StateView<TState extends StateDef> {
  constructor(client: NetClient, stateDef: TState, opts?: { interpDelayMs?: number })
  sample(nowMs?: number): Infer<TState>     // state đã nội suy tại renderTime
  latest(): Infer<TState> | null            // tick mới nhất, không nội suy
  onAdd(collection, cb: (id: number, e: EntityPlain) => void): Unsub
  onRemove(collection, cb: (id: number) => void): Unsub
  stats(): { latestTick, ackTick, bufferedTicks, interpDelayMs }
}
```

- `renderTime = client.serverNow() - interpDelayMs`. Mặc định `interpDelayMs = max(100, 2.5 * 1000/tickRate)` (tickRate từ WELCOME).
- Tìm 2 entry kẹp renderTime theo `serverTime`; `t = (renderTime - e1.serverTime) / (e2.serverTime - e1.serverTime)` clamp [0,1].
- Per entity ∈ e1 ∩ e2: decode leaf (memoize per-entry per-entity — decode một lần, cache plain object), interp theo hint:
  - `lerp`: `a + (b-a)*t`
  - `step`: giá trị của e1
  - `lerpAngle`: `a + shortestAngleDiff(a,b)*t`, wrap về (-PI, PI]
- Entity chỉ ∈ e2 (mới spawn): xuất hiện khi renderTime ≥ e2.serverTime (tức khi e2 trở thành entry trái). Entity chỉ ∈ e1 (đã despawn): còn hiển thị đến khi renderTime vượt e1.
- `onAdd/onRemove` bắn theo **render timeline** (đúng lúc entity xuất hiện/biến mất trong sample), không phải lúc packet đến — sprite tạo/hủy đúng nhịp hình ảnh.
- Buffer starvation (renderTime vượt entry mới nhất — lag spike/tab throttle): giữ nguyên giá trị entry cuối (freeze), khi buffer hồi phục thì tiếp tục — KHÔNG extrapolate ở v1.

## 6. Sửa footgun Phase 1 (bắt buộc làm cùng Phase 2)

`ClientRoom`: buffer event đến khi channel chưa có handler nào — flush theo thứ tự khi handler đầu tiên của channel đó (hoặc `'*'`) đăng ký. Cap 128 event/room, tràn thì bỏ cũ nhất. Test: server gửi EVENT ngay trong `onJoin` → client vẫn nhận được dù gắn handler sau `await joinRoom()`.

## 7. Test bắt buộc

`packages/core/test/protocol-sync.test.ts`: roundtrip SNAPSHOT/DELTA/INPUT với GameState mẫu (004 §2); delta empty-change chỉ có header; decode thiếu stateDef → ProtocolError.

`packages/server/test/sync-e2e.test.ts` (memory pair + netsim, room di chuyển entity mỗi tick theo quỹ đạo biết trước, tickRate 50 cho test nhanh):
- [ ] Client join giữa chừng nhận SNAPSHOT full, sau đó chỉ DELTA (đo bằng đếm message type).
- [ ] `StateView.sample()` với chuyển động tuyến tính: sai số vị trí < 1 step quantize tại mọi thời điểm sample (chứng minh interpolation đúng).
- [ ] lerpAngle: góc đi 350°→10° qua 0°, sample không bao giờ nằm trong (20°, 340°).
- [ ] spawn/despawn giữa chừng: onAdd/onRemove bắn đúng 1 lần, đúng thứ tự.
- [ ] Đứt mạng 500ms (drop transport) → resume → state hội tụ lại đúng (so latest() với server state), server đã fallback SNAPSHOT khi ack cũ rớt ring buffer.
- [ ] Netsim latency 80ms + jitter 20ms: sample vẫn mượt (sai số như trên).
- [ ] Event trong onJoin đến trước khi gắn handler → vẫn nhận (§6).

## 8. Milestone demo: `examples/vanilla-2d`

- `server.js`: SyncRoom 'arena', state = GameState (§004), client join → spawn Player với `ownerId = client.id`, EVENT channel 1 = `{dx,dy}` chuẩn hóa → server set velocity, onTick tích phân vị trí, clamp trong map 800×600.
- `index.html + client.js`: canvas 800×600, WASD/phím mũi tên gửi EVENT (throttle 20/s), render bằng `view.sample()` mỗi rAF; vẽ tên + hp. Serve tĩnh bằng script `serve.js` (http tự viết ~20 dòng, không thêm dependency).
- Definition of done: mở 3 tab, di chuyển trong 1 tab — 2 tab kia thấy chuyển động **mượt** (không giật bậc thang theo tick), đóng tab → nhân vật biến mất ở tab khác trong < 35s (grace) hoặc ngay nếu leave chủ động.
