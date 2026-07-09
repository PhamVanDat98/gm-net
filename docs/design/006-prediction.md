# Design 006 — Client Prediction & Server Reconciliation (đặc tả Phase 3)

Trạng thái: **Đặc tả mức kiến trúc — chi tiết hóa thêm khi Phase 2 xong.** Phụ thuộc: 004, 005.

## 1. Vấn đề

Với snapshot interpolation thuần (Phase 2), nhân vật của CHÍNH người chơi trễ `interpDelay + RTT/2` so với phím bấm — cảm giác "bơi". Phase 3: client mô phỏng ngay input của mình (prediction), server vẫn là chân lý (reconciliation khi lệch).

## 2. Input pipeline

### Input schema — user định nghĩa bằng chính `entity()`:

```ts
const PlayerInput = entity('PlayerInput', {
  dx: quantized(0.01), dy: quantized(0.01),   // hướng di chuyển chuẩn hóa
  fire: bool,
})
```

`stateDef` mở rộng: `state({...}, { input: PlayerInput })` — input def vào schema hash.

### Wire (đã chốt format INPUT trong 005 §1):

- Client sample input mỗi **client tick** (mặc định = tickRate server, chạy timer riêng phía client), gán `seq` tăng dần từ 1.
- `inputFrame` = full encode PlayerInput (không mask — input nhỏ).
- **Redundancy**: mỗi packet INPUT chứa `count` frame cuối cùng (mặc định 3): frames của seq `[seq-count+1 .. seq]`. Mất 1-2 packet liên tiếp không mất input.
- Server rate limit: INPUT thuộc data bucket; với client tick 30Hz + redundancy, vẫn ≤ 30 msg/s.

### Server nhận:

- Per-client `InputBuffer`: map seq→frame, bỏ seq đã xử lý (≤ lastProcessedSeq), bỏ seq quá tương lai (> lastProcessedSeq + 64 → đá RATE_LIMITED? không — chỉ drop, log).
- Mỗi server tick: lấy frame `lastProcessedSeq+1` nếu có → gọi hook `onInput(client, input, seq)` → `lastProcessedSeq++`. Không có (packet chưa tới) → **input repeat**: dùng lại frame trước đó tối đa 3 tick, sau đó coi như input rỗng (throw về game: hook `onInputGap(client)` optional).
- `lastProcessedSeq` per-client ghi vào header SNAPSHOT/DELTA của client đó (005 §1 đã chừa chỗ).

## 3. Ownership & predicted entity

Không thêm cơ chế protocol. Pattern chuẩn (docs phải dạy): entity của người chơi có field `ownerId: str` = clientId. Client tìm entity của mình bằng `ownerId === client.clientId`.

```ts
const predictor = new Predictor(view, {
  entityOf: (state) => [...state.players.values()].find(p => p.ownerId === client.clientId),
  simulate: (entity, input, dtMs) => { /* CÙNG code với server onInput+onTick cho entity này */ },
})
```

**Ràng buộc thiết kế quan trọng**: hàm `simulate` phải được viết chung (shared module) giữa client và server — docs hướng dẫn cấu trúc project: `shared/simulation.js` import từ cả 2 phía. Thư viện không ép được điều này, chỉ enforce bằng tài liệu + example.

## 4. Vòng prediction (client, mỗi render frame)

1. Sample input → gửi INPUT (kèm ack như cũ) → push `{seq, input}` vào `pendingInputs`.
2. Áp `simulate(myEntity, input, dt)` lên **bản predicted cục bộ** (tách khỏi state interpolation — entity của mình KHÔNG render bằng interpolation).
3. Khi nhận state mới có `lastProcessedSeq = N`:
   - Xóa pendingInputs seq ≤ N.
   - `authoritative = giá trị entity của mình trong tick đó`.
   - **Replay**: từ authoritative, áp lại lần lượt pendingInputs còn lại → predicted mới.
   - `error = predicted_cũ - predicted_mới`. Nếu |error| nhỏ (< 0.001 sau quantize) → bỏ qua. Ngược lại: **error smoothing** — không snap: giữ `correctionOffset = error` và decay về 0 theo `exp(-dt/80ms)`, render tại `predicted - correctionOffset`.
4. Các entity khác vẫn render bằng `view.sample()` (interpolation) như Phase 2.

## 5. API dự kiến

```ts
// @gm-net/client
export class Predictor<E> {
  constructor(view: StateView, opts: { entityOf, simulate, maxPending?: 120 })
  frame(input: Infer<InputDef>, dtMs: number): E   // gọi mỗi rAF, trả entity để render
  stats(): { pendingCount, lastError, corrections }
}
```

Server: `SyncRoom` thêm `static inputDef`, hook `onInput(client, input, seq)`, `onInputGap?(client)`.

## 6. Test & milestone

- Unit: InputBuffer (out-of-order, duplicate, gap, repeat-limit); replay logic với simulate tuyến tính — predicted hội tụ đúng authoritative khi không mất gói.
- E2E netsim latency 150ms + jitter 30ms (WS nên loss thể hiện qua jitter): di chuyển thẳng 2s — sai lệch render vs server cuối cùng < 2 step quantize; không có correction snap > ngưỡng khi mạng ổn.
- Milestone (BRAINSTORM Phase 3): demo `phaser-2d` game bắn nhau nhỏ, chơi được ở 150ms ping.

## 7. Ngoài scope Phase 3 (→ Phase 5 backlog)

Lag compensation (server rewind hit detection), extrapolation/dead-reckoning, input trên kênh unreliable.
