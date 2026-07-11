/**
 * Hooks & config để game cắm vào room framework ([docs/design/006-server-rooms.md]
 * §1–2). Framework lo vòng đời + tick loop + jitter buffer + serialization; game
 * chỉ cung cấp logic mô phỏng qua {@link GameLogic}.
 *
 * Phase 1 (M2): `simulate` mặc định là "echo" (state = vị trí cộng dồn từ
 * applyInput, chưa physics). Rapier world thay vào ở M4.
 */
import type { CustomCodec, SnapshotEntity, WorldBounds } from '@gm-net/core';
import type { Handshake } from '@gm-net/shared';

export type { Handshake };

/** Cấu hình một loại room (dữ liệu thuần, truyền vào `onCreate`). */
export interface GameConfig {
  /** Tần số mô phỏng (Hz). */
  tickRate: number;
  /** Biên thế giới để quantize position. */
  worldBounds: WorldBounds;
  /** Tốc độ tối đa mỗi trục để quantize velocity. */
  vMax: number;
  /** Ghi đè protocolVersion trong handshake (mặc định `PROTOCOL_VERSION` của core). */
  protocolVersion?: number;
  /** Thiếu input tại tick → lặp input cuối (mặc định true, [006] §2). */
  repeatLastInput?: boolean;
  /** Cửa sổ tick hợp lệ ±N tick (mặc định ≈ tickRate ≈ 1s, [006] §3). */
  maxTickSkewTicks?: number;
  /** Ngân sách input mới/tick/client chống flood (mặc định 2, [006] §3). */
  inputBudgetPerTick?: number;
  /**
   * Số tick giữ trong ring history snapshot ([003] quyết định 5, ~1s; mặc định 30).
   * Chỉ có tác dụng khi `GameLogic.takeSnapshot` được cung cấp. 0 → tắt.
   */
  snapshotHistoryTicks?: number;
}

/** Ngữ cảnh khi một player vào room. */
export interface PlayerJoinContext {
  sessionId: string;
  /** Tick server hiện tại lúc join. */
  tick: number;
}

/**
 * Logic mô phỏng do game cung cấp. `World` và `Input` là kiểu của game;
 * framework không hiểu nội dung, chỉ điều phối.
 */
export interface GameLogic<World = unknown, Input = unknown> {
  /** Tạo world mới cho một room. */
  createWorld(config: GameConfig): World;
  /** Cấp entity cho player mới; trả về entityId (u16). */
  onPlayerJoin(world: World, ctx: PlayerJoinContext): number;
  /** Player rời đi: despawn hoặc xử lý theo rule game. */
  onPlayerLeave(world: World, entityId: number): void;
  /** Áp một input đã validate cho entity của player tại tick T. */
  applyInput(world: World, entityId: number, input: Input, tick: number): void;
  /** Bước mô phỏng đúng một tick (echo: no-op; M4: world.step). */
  simulate(world: World, stepMs: number, tick: number): void;
  /** Đọc state hiện tại thành danh sách entity cho snapshot. */
  readEntities(world: World): SnapshotEntity[];
  /**
   * Chụp toàn bộ state world (M4). Có → engine tự đẩy vào ring history mỗi tick
   * (`RoomEngine.snapshotAt`), nền tảng cho lag compensation (M10) và debug.
   */
  takeSnapshot?(world: World): unknown;
}

/** Cặp codec serialization do game đăng ký, tách khỏi logic mô phỏng. */
export interface GameCodecs<Input = unknown> {
  /** Codec payload input của game (§5 [005]). */
  inputCodec?: CustomCodec<Input>;
  /** Custom state codec cho từng entityType. */
  entityCodecs?: Map<number, CustomCodec>;
}
