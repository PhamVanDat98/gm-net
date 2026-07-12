# 006 — Server & rooms

Căn cứ: BRAINSTORM.md §1 (game server stateful), §3 (Colyseus, uWebSockets.js), §4 Phase 1
(tick loop) + Phase 2 (lag compensation, AOI, reconnection), §5 (quyết định 4, 5).

## 1. Vai trò của Colyseus

**[CHỐT]** (quyết định 4): dùng Colyseus (`^0.17.10`) cho **room lifecycle + seat
reservation**, bypass hoàn toàn schema sync; dữ liệu game đi qua `sendBytes()`/broadcast bytes.

**[ĐỀ XUẤT]** ánh xạ cụ thể:

- `@gm-net/server` expose lớp `GameRoom extends colyseus.Room`:
  - `onCreate`: khởi tạo Rapier world (qua physics adapter), tick loop, đăng ký handler
    message binary.
  - `onJoin`: cấp entity cho player (gọi hook của game), gửi **full snapshot** đầu tiên
    + thông tin handshake (protocolVersion, tickRate, worldBounds, entityId của mình).
  - `onLeave`: despawn hoặc treo entity chờ reconnect (§5).
  - `state` Colyseus: **không dùng** (để trống) — toàn bộ state nằm trong Rapier world.
- Game kế thừa/cấu hình `GameRoom` bằng hooks: `onPlayerJoin/Leave`, `applyInput`,
  `simulate` (mặc định = world.step), `encodeCustomState`.
- Transport: `@colyseus/uwebsockets-transport` (uWebSockets.js — nhanh hơn `ws` nhiều lần,
  expose trực tiếp, không proxy qua Cloudflare). Đây là chỗ duy nhất đụng uWS; phần còn
  lại của server code không biết transport là gì.
  - **Trạng thái M2 [ĐỀ XUẤT]**: `createGameServer({ transport })` nhận transport
    injectable, **mặc định `WebSocketTransport`** (bundled trong `colyseus`, chạy mọi nơi
    kể cả Windows/CI). uWS là opt-in production (truyền vào) — đúng điểm thoát ở bảng rủi
    ro. Interface không đổi khi chuyển transport.

## 2. Tick loop phía server

**[CHỐT]** fixed-tick 30Hz. **[ĐỀ XUẤT]** hiện thực:

- Dùng timer drift-corrected: `setTimeout` tự căn lại theo `expectedNext - now` thay vì
  `setInterval` (setInterval trôi và dồn cục khi event loop nghẽn).
  - **Kết luận M2**: `Room.setSimulationInterval` chạy trên `ClockTimer` kiểu setInterval
    (bù delta chứ không căn thời điểm fire) → **tự quản timer** trong `TickScheduler`
    (`server/src/tick.ts`), timer injectable để unit-test bằng đồng hồ ảo (đo 100 tick,
    drift < 1 tick). Nghiệm thu "echo simulation, 2 client thấy nhau" test ở tầng
    `RoomEngine` (tách khỏi socket); e2e qua socket + proxy để dành M5.
  - **Tick loop phải sống sót lỗi game logic**: exception từ `onTick` được bắt và đưa
    qua `onError` (mặc định log) — nếu để thoát ra timer callback thì loop chết im lặng
    (không ai schedule tiếp) và uncaught exception có thể sập process. `GameRoom.step`
    cũng bỏ qua client chưa kịp có record trong engine (Colyseus thêm client vào
    `this.clients` trước khi gọi `onJoin`).
- Một tick T:
  1. Rút input `tick == T` từ jitter buffer per-client ([004](004-netcode.md) §4);
     client thiếu input → lặp input cuối (config).
  2. `applyInput` cho từng player (code trong `shared` của game).
  3. Step Rapier world đúng 1 bước.
  4. `takeSnapshot()` → đẩy ring buffer (30 slot ~1s — quyết định 5; phục vụ lag comp §4
     và làm baseline delta [005](005-serialization.md) §4).
  5. Đóng gói + gửi snapshot cho từng client (`lastProcessedSeq` riêng từng người;
     Phase 2: lọc AOI + delta).
- Đo `tickDuration` mỗi tick từ ngày đầu; cảnh báo khi p99 tiến gần 33ms.
- **Snapshot rate = tick rate (30Hz) ở Phase 1** — đơn giản trước; tách send rate thấp
  hơn (15–20Hz) là việc tối ưu sau nếu bandwidth thành vấn đề.

## 3. Kiểm soát input (chống gian lận mức giao thức)

**[ĐỀ XUẤT]** — hệ quả của server-authoritative ([001](001-architecture.md) §5):

- Clamp payload: trục analog vào [-1,1], độ dài vector ≤ 1.
- Cửa sổ tick hợp lệ: bỏ input có tick lệch quá ±1s so với tick hiện tại (bỏ **vĩnh
  viễn** — tick ngoài giờ là gian lận/lỗi, có đánh dấu seq đã thấy).
- Ngân sách: tối đa ~2 input mới/tick/client (đề phòng flood); vượt → **hoãn** phần còn
  lại của packet, *không* đánh dấu seq đã thấy — redundancy của packet sau mang lại khi
  budget đã reset. (Kết luận M2: nếu đánh dấu rồi drop, input hợp lệ dồn về sau burst mất
  gói sẽ mất vĩnh viễn vì resend bị coi là duplicate — redundancy bị vô hiệu đúng lúc cần.)
- Input muộn (tick đã qua, không bao giờ áp được): chỉ đếm cho adaptive lead, không tốn
  budget, không vào buffer. `lateInputs` trong snapshot là **delta kể từ snapshot trước**
  ([005](005-serialization.md) §3), không phải tổng tích lũy.
- Mọi input bị bỏ đều tăng counter có thể quan sát được ([004](004-netcode.md) §8).

## 4. Lag compensation (Phase 2)

**[CHỐT]** cơ chế: giữ position history ~1 giây; khi hit detection, rewind về thời điểm
người bắn *nhìn thấy* rồi kiểm tra trúng.

**[ĐỀ XUẤT]** chi tiết:

- Thời điểm rewind = tick mà người bắn đang render remote entities lúc bấm cò
  = `inputTick - interpolationDelayTicks(client)` (client báo delay hiện tại của nó trong
  packet input, server clamp ≤ 200ms — không cho client tự khai delay khổng lồ để "bắn
  vào quá khứ xa").
- Hai lựa chọn hiện thực, chọn khi code bằng benchmark:
  a. Rewind bằng `restoreSnapshot` từ ring buffer (chính xác tuyệt đối nhưng restore cả
     world); hoặc
  b. Giữ history riêng position/rotation per entity (mảng vòng 30 phần tử), raycast thủ
     công trên hình học tại thời điểm cũ — rẻ hơn nhiều, đủ cho hitscan.
  Thiên về (b) cho hitscan; (a) để dành khi cần rewind cả tương tác vật lý.

**Đã làm (M10) — chọn phương án (b)** (`server/src/lag-comp.ts`):

- `EntityHistory`: ring transform (pos/rot) ~1s, ghi cùng mốc tick với snapshot gửi đi —
  nên "tua về tick T" đúng bằng "cái client thấy trong snapshot tick T". Config
  `lagCompHistoryTicks` (mặc định ≈ tickRate; 0 → tắt).
- Client báo interp delay thật (adaptive) trong `INPUT` ([005](005-serialization.md) §6:
  `u16 interpDelayMs`); server **clamp** ≤ `lagCompMaxDelayMs` (mặc định 200ms) khi ingest.
- API: `RoomEngine.rewindTickFor(sessionId, inputTick)` và
  `RoomEngine.rewindHitscan(sessionId, query, inputTick)` (ray vs circle, bỏ qua người bắn,
  chọn mục tiêu gần nhất). Ngoài ring (delay quá lớn / lag comp tắt) → kiểm ở tick hiện tại.

**Nghiệm thu (M10):** mục tiêu chạy ngang, người bắn nhắm vào chỗ nó *nhìn thấy* (trễ 200ms
= 6 tick @30Hz): **có lag comp → trúng; tắt lag comp → trượt** (`packages/server/test/
lag-comp.test.ts`) — đúng bài "test chứng minh giá trị". Client khai delay 5 giây cũng chỉ
tua được 200ms.

**Bẫy đã sửa:** cache entity theo tick (tối ưu từ M7) phải **vô hiệu khi world đổi ngoài nhịp
tick** (join/leave). Không thì snapshot gửi ngay sau `removeClient` vẫn còn entity vừa despawn
— lag comp làm lộ ra vì `advance()` nay đọc entity sớm hơn để ghi history.

## 5. Reconnection + state resync (Phase 2 — **đã làm, M8**)

**[CHỐT]** grace period giữ session. **[ĐỀ XUẤT]** chi tiết:

- Rớt mạng (không phải chủ động thoát): `allowReconnection(client, grace)` của Colyseus,
  grace mặc định 30s (`reconnectGraceSeconds`). Entity của player: giữ nguyên trong world
  (hook `onPlayerDisconnected` để game quyết; mặc định đứng yên).
- Reconnect thành công: coi như join lại về mặt dữ liệu — handshake mới + **keyframe**
  (server reset `ackTick`/`firstSentTick` nên delta không thể dựa vào baseline cũ), client
  vứt snapshot + ring baseline + input chưa ack, interpolation/smoother reset, prediction
  rebase từ keyframe. Entity giữ nguyên `entityId`.
- Quá grace: despawn thật (`onPlayerLeave`), giải phóng seat.

**Ba bẫy API Colyseus 0.17 (đều làm e2e đỏ, nay có test khoá):**

1. **`onLeave(client, code)` truyền close code, KHÔNG phải boolean `consented`.** Coi nó là
   boolean thì `1006` (đứt mạng) là truthy → despawn ngay, `allowReconnection` không bao giờ
   chạy. Dùng `CloseCode.CONSENTED` (4000) / `SERVER_SHUTDOWN` (4001) để phân biệt. 0.17 còn
   có hook riêng **`onDrop(client, code)`** cho rớt mạng — dùng nó, giữ `onLeave` phòng thân.
2. **`client.reconnect()` của colyseus.js 0.16 vỡ với server 0.17** — cùng lệch shape
   reservation như `joinOrCreate` (xem [004] §7): phải tự gọi `POST /matchmake/reconnect/
   :roomId` rồi reshape phẳng → lồng.
3. **Server 0.17 không trả `reconnectionToken` trong response matchmake reconnect, nhưng đòi
   nó trên query WS lúc bắt tay** (thiếu → đóng với code 524 "bad reconnection token"). Phải
   tự gắn lại token gốc (`Room.reconnectionToken` = `"<roomId>:<token>"`) vào reservation.

**Công cụ test:** `netem-proxy.setOffline(true/false)` — cắt/nối dây (đóng mọi socket, từ chối
kết nối mới, hủy message đang chờ delay), đúng ngữ nghĩa "rớt mạng tạm thời" chứ không phải
"server chết". Nghiệm thu: `examples/demo-2d/test/reconnect.e2e.test.ts` — rớt 10s, quay lại,
chơi tiếp; player kia vẫn thấy entity của người rớt suốt grace.

## 6. Interest management / AOI (Phase 2 — **đã làm, M9**)

**[CHỐT]** grid hoặc quadtree. **[ĐỀ XUẤT]**: bắt đầu bằng **uniform grid** (đơn giản,
predictable, phù hợp top-down shooter); tập quan tâm của client = 3×3 cell quanh chính nó +
hysteresis (vào tập ở bán kính r, ra ở r×1.2) để tránh flapping spawn/despawn ở mép.
Quadtree chỉ khi mật độ entity chênh lệch lớn giữa các vùng map. AOI đổi tập → spawn/despawn
đi thẳng trong DELTA ([005](005-serialization.md) §4: entity mới = block FULL, entity mất =
despawn id — không cần message riêng).

**Đã làm (`server/src/aoi.ts` — `InterestGrid`):** bật bằng `GameConfig.aoi = {radius,
cellSize?, hysteresis?}`; bỏ trống → tắt AOI, gửi cả world (hành vi Phase 1 giữ nguyên).

**Sửa một con số [ĐỀ XUẤT]:** cell size mặc định = **bán kính RA** (`r × hysteresis`), không
phải `r/2`. Với `r/2`, khối 3×3 ô chỉ phủ 1.5r < 2r nên entity ở góc trong bán kính quan tâm
lọt lưới; lấy cell = bán kính ra thì AABB bán kính ra luôn nằm gọn trong **3×3 ô** — đúng
tinh thần "3×3 cell" mà không hụt vùng. Lưới chỉ là broad-phase; lọc chính xác vẫn bằng
khoảng cách.

**Bất biến bắt buộc:** entity **của chính client luôn nằm trong tập** (nếu không, người chơi
đứng một mình giữa map sẽ mất chính mình). Không tìm thấy entity của client (đã despawn /
spectator) → gửi cả world, để game tự quyết bằng `readEntities`.

**Hệ quả lên delta (M7):** mỗi client thấy một tập entity **khác nhau** → ring baseline phải
**per-client**, không dùng chung theo room. Đây là thay đổi cấu trúc bắt buộc, không phải tối
ưu: baseline dùng chung sẽ khiến server tính delta so với thứ client chưa từng nhận.

**Nghiệm thu (M9):** entity ngoài vùng không xuất hiện trong bytes gửi; đi qua ranh giới
không flapping — `packages/server/test/aoi.test.ts`.

## 7. Headless client (Phase 2 — **đã làm, M11**)

**[CHỐT]** bot fill room + load testing. Ghi chú thiết kế: `@gm-net/client` không được
import DOM ngay từ Phase 1 (điều kiện để chạy trên Node không sửa gì); headless mode chỉ
là "client không gọi getRenderState + input do script bơm". Load test = N headless client
+ netem/proxy delay, đo metrics server ([008](008-roadmap.md) §5).

**Đã làm:** `HeadlessBot` (`client/src/bot.ts`) — bọc `GameSession` trong một fixed-timestep
loop, input do script bơm (`input: ({tick, elapsedMs}) => Input`). Đúng như thiết kế đã
lường: **không có "chế độ headless" nào trong netcode** — client vốn không đụng DOM, bot chỉ
là "chạy `tick()`, không gọi `getRenderState()`".

**Metrics server** ([004] §8): `TickMetrics` (p50/p99/max của **trọn một tick**: mô phỏng +
encode + gửi — đo từng phần riêng sẽ bỏ sót cái đắt nhất khi đông, vì encode/gửi nhân theo
số client) + bandwidth/client. Phát định kỳ qua `GameConfig.onMetrics` (mặc định 1s/lần) —
load test và export production dùng chung một đường.

**Runner:** `pnpm --filter demo-2d loadtest [bots] [seconds] [--proxy] [--aoi=R]`.
Số liệu nghiệm thu: [008 §6](008-roadmap.md).
