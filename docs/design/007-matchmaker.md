# 007 — Matchmaker (Phase 3)

Căn cứ: BRAINSTORM.md §1 (sơ đồ), §3 (Node + Redis), §4 Phase 3, §5 (quyết định 3).

Tài liệu này ngắn có chủ đích: matchmaker là Phase 3 và **tách rời core** — chỉ ghi lại
những gì đã chốt + phác thảo đủ để các phase trước không xây thứ gì cản đường nó.

## 1. Đã chốt

**[CHỐT]**
- Service riêng, **stateless**, scale ngang độc lập với game server (quyết định 3).
- Node.js + Redis: queue, pub/sub, server registry. REST/WS endpoint riêng.
- Optional tuyệt đối: framework dùng được không cần matchmaker (client connect thẳng
  game server). Không API nào ở `core`/`server`/`client` được giả định matchmaker tồn tại.
- Phase 3 gồm: queue, skill-based (optional), server allocation.

## 2. Phác thảo hoạt động [ĐỀ XUẤT]

```
Game server (mỗi process):
  - đăng ký vào Redis: { serverId, endpoint, rooms: [{roomId, mode, playerCount, max}] }
    dưới dạng key TTL ngắn (heartbeat ~5s); chết → key hết hạn → tự rời registry.

Matchmaker (N instance sau load balancer):
  POST /queue { mode, partySize, [skill] }
    → đẩy vào Redis queue theo mode
    → worker gom đủ người / hết timeout:
        chọn server còn chỗ (từ registry, ưu tiên gần đầy để dồn room)
        gọi game server tạo room / dùng room chờ → seat reservation (Colyseus)
    → trả client { endpoint, reservationToken } (qua WS push hoặc polling)
  Client cầm token connect thẳng game server — matchmaker rời khỏi vòng đời từ đây.
```

- Seat reservation chính là primitive Colyseus đã có — lý do nữa để giữ Colyseus ở [003](003-tech-stack.md).
- Skill-based: chỉ là chiến lược gom trong worker (bucket theo rating, nới dần theo thời
  gian chờ) — không đụng kiến trúc.

## 3. Ràng buộc lên các phase trước

- Game server Phase 1–2 cần một đường tạo room + join có reservation hoạt động **không
  qua** matchmaker (dev/demo dùng trực tiếp) — giữ API Colyseus chuẩn là đủ.
- Registry heartbeat (§2) cần counter `playerCount` per room — có sẵn từ Colyseus.
