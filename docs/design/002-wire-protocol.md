# Design 002 — Wire Protocol v1

Trạng thái: **Draft — cần review trước khi code Phase 1**

## Nguyên tắc chung

- **Data plane** (input, snapshot, delta, event): binary, thiết kế cho tần suất 20–60Hz.
- **Control plane** (handshake, join/leave, room listing): JSON trong envelope binary — tần suất thấp, ưu tiên debug được. Đổi sang binary sau nếu cần, không breaking (chỉ đổi payload của message type đó).
- Little-endian. Varint = unsigned LEB128; svarint = zigzag rồi LEB128.
- Protocol có version (u8), negotiate ở handshake. Client/server lệch **major** → từ chối.

## Framing

WebSocket đã có message boundary nên không cần length-prefix từng packet. Một WS frame = một **packet**, chứa nhiều **message** nối tiếp:

```
packet := message+
message := msgType(u8) payload(theo msgType)
```

Parser biết độ dài payload từ msgType + schema (các phần biến thiên đều có varint length prefix). Batching nhiều message/packet giảm overhead WS frame (~4 bytes/frame) và syscall.

## Bảng message type

| ID | Tên | Chiều | Plane | Payload |
|---|---|---|---|---|
| 0x01 | HELLO | C→S | control | JSON `{protocol, schemaHash, token?, resumeKey?}` |
| 0x02 | WELCOME | S→C | control | JSON `{clientId, serverTime, tickRate, resumeKey, resumed}` — `resumed=true` khi khôi phục session cũ qua resumeKey |
| 0x03 | ERROR | S→C | control | JSON `{code, message}` — codes: `PROTOCOL_MISMATCH`, `SCHEMA_MISMATCH`, `ROOM_FULL`, `ROOM_NOT_FOUND`, `ROOM_TYPE_UNKNOWN`, `ALREADY_IN_ROOM`, `NOT_IN_ROOM`, `RATE_LIMITED`, `BAD_REQUEST` |
| 0x04 | PING | C→S | data | `clientTime(f64)` |
| 0x05 | PONG | S→C | data | `clientTime(f64) serverTime(f64)` |
| 0x10 | ROOM_CREATE | C→S | control | JSON `{roomType, options, private?}` |
| 0x11 | ROOM_JOIN | C→S | control | JSON `{roomId}` hoặc `{roomType}` (quick-join) |
| 0x12 | ROOM_JOINED | S→C | control | JSON `{roomId, roomType, metadata}` |
| 0x13 | ROOM_LEAVE | C→S | control | JSON `{}` |
| 0x14 | ROOM_LIST_REQ | C→S | control | JSON `{roomType?}` |
| 0x15 | ROOM_LIST_RES | S→C | control | JSON `{rooms: [{id, type, players, maxPlayers, metadata}]}` |
| 0x16 | ROOM_LEFT | S→C | control | JSON `{reason}` — `left` (tự rời), `kicked`, `room_closed`, `session_lost` (hết grace, không resume được) |
| 0x20 | INPUT | C→S | data | xem [INPUT](#input) |
| 0x21 | SNAPSHOT | S→C | data | xem [SNAPSHOT](#snapshot--delta) |
| 0x22 | DELTA | S→C | data | xem [SNAPSHOT](#snapshot--delta) |
| 0x23 | EVENT | 2 chiều | data | `channel(varint) len(varint) bytes` — reliable message/RPC tùy người dùng |

`0x00` cấm dùng (bắt lỗi buffer rác). `0xF0–0xFF` dành cho extension/debug.

## Handshake & resume

```
C→S  HELLO {protocol: 1, schemaHash}
S→C  WELCOME {clientId, serverTime, tickRate, resumeKey}   // hoặc ERROR
```

- `resumeKey`: chuỗi ngẫu nhiên server cấp. Khi rớt mạng, client reconnect gửi HELLO kèm `resumeKey` → server khôi phục session (vẫn trong room, giữ clientId) nếu trong thời hạn grace (mặc định 30s).
- `schemaHash` lệch → ERROR `SCHEMA_MISMATCH` kèm hướng dẫn trong message (thường do client build cũ).

## Clock sync

- Client gửi PING mỗi 500ms (nhiều hơn trong 2s đầu để hội tụ nhanh: 5 ping × 100ms).
- Từ PONG: `rtt = now - clientTime`, `offset = serverTime + rtt/2 - now`.
- Ước lượng offset bằng cách giữ min-RTT sample trong cửa sổ trượt (mẫu RTT nhỏ nhất là mẫu ít nhiễu queue nhất) + EWMA để mượt.
- Mọi timestamp trong data plane là **server time** suy ra từ offset này.

## INPUT

```
INPUT := seq(varint) ackTick(varint) count(u8) inputFrame{count}
inputFrame := theo input schema người dùng định nghĩa (entity('Input', {...}))
```

- `seq`: số thứ tự input tăng dần — server dùng để reconciliation, client dùng để replay khi predict lệch.
- `ackTick`: tick snapshot/delta mới nhất client đã nhận — **ack piggyback trên input**, không cần message ACK riêng. Server dùng làm baseline cho DELTA.
- Gửi kèm `count` frame gần nhất chưa ack (input redundancy) — mất 1 packet không mất input, đổi vài byte lấy độ bền. Mặc định count=3.

## SNAPSHOT & DELTA

```
SNAPSHOT := tick(varint) entityCount(varint) fullEntity{entityCount}
fullEntity := entityId(varint) entityType(u8) allFields

DELTA := tick(varint) baselineTick(varint)
         removedCount(varint) entityId{removedCount}
         addedCount(varint) fullEntity{addedCount}
         changedCount(varint) changedEntity{changedCount}
changedEntity := entityId(varint) changeMask(ceil(nFields/8) bytes) changedFieldsOnly
```

- Server giữ ring buffer ~64 tick snapshot đã encode. DELTA được diff so với `baselineTick` = ackTick của **từng client** (mỗi client một baseline riêng).
- Client chưa ack gì / baseline rớt khỏi ring buffer / vừa join → gửi SNAPSHOT đầy đủ.
- Client nhận DELTA mà không có baseline tương ứng (hiếm, do bug/race) → bỏ qua, chờ; server thấy ack không tiến sẽ tự gửi SNAPSHOT. Cơ chế tự phục hồi, không cần message xin snapshot.
- changeMask: bit i = field thứ i (theo thứ tự khai báo schema) có mặt trong payload.

Băng thông dự kiến (16 players × ~6 field đổi/tick × 20Hz): ~8–15 KB/s/client — thoải mái.

## EVENT (reliable messaging)

- `channel` do người dùng đăng ký (`net.channel('chat', ChatSchema)`), payload encode theo schema của channel.
- Trên WebSocket đã reliable+ordered nên v1 không cần ARQ. **Lưu ý thiết kế**: API không được hứa ordering giữa EVENT và SNAPSHOT khi sau này chạy trên WebRTC (2 kênh khác nhau) — docs ghi rõ từ v1 để không ai phụ thuộc.

## Rate limiting & validation (server, Phase 1)

- Mọi message có budget: mặc định 60 msg/s/client, control plane 5 msg/s. Quá → ERROR `RATE_LIMITED` rồi đóng kết nối.
- Mọi độ dài (str, list, count) validate trước khi cấp phát. Packet lỗi parse → đóng kết nối (không cố phục hồi giữa packet).

## Tương thích transport tương lai (WebRTC/WebTransport)

Transport interface chỉ cần: gửi/nhận `Uint8Array`, thông báo open/close. Yêu cầu v1: reliable + ordered. Khi thêm kênh unreliable (phase 5): SNAPSHOT/DELTA/INPUT/PING chuyển sang kênh unreliable — protocol đã sẵn (tick/seq cho phép drop + reorder), chỉ transport đổi. Đây là lý do mọi data-plane message đều tự mô tả (self-contained), không dựa vào "message trước đó".
