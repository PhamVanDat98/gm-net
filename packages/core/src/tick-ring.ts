/**
 * Ring buffer đánh chỉ mục theo tick ([docs/design/003-tech-stack.md] quyết định 5,
 * [004] §5): giữ `capacity` giá trị gần nhất, slot = `tick % capacity`. Dùng cho
 * (a) ring snapshot prediction phía client (restore + replay khi reconcile),
 * (b) history snapshot phía server (lag compensation M10). Đặt ở core vì cả hai
 * phía cần cùng một cấu trúc, không I/O.
 *
 * `get(tick)` chỉ trả giá trị khi slot thật sự chứa đúng tick đó — slot bị ghi
 * đè bởi tick mới hơn (cùng lớp modulo) trả `undefined`, không bao giờ trả nhầm
 * dữ liệu của tick khác.
 */
export class TickRing<T> {
  private readonly values: (T | undefined)[];
  private readonly ticks: number[];

  constructor(readonly capacity = 30) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`TickRing: capacity phải là số nguyên dương (nhận ${capacity})`);
    }
    this.values = new Array<T | undefined>(capacity).fill(undefined);
    this.ticks = new Array<number>(capacity).fill(-1);
  }

  /** Ghi giá trị cho `tick` (ghi đè giá trị cũ cùng slot modulo). Tick < 0 → ném. */
  set(tick: number, value: T): void {
    if (tick < 0) throw new RangeError(`TickRing: tick phải ≥ 0 (nhận ${tick})`);
    const i = tick % this.capacity;
    this.values[i] = value;
    this.ticks[i] = tick;
  }

  /** Giá trị đã ghi cho đúng `tick`, hoặc `undefined` (chưa ghi / đã bị ghi đè). */
  get(tick: number): T | undefined {
    if (tick < 0) return undefined;
    const i = tick % this.capacity;
    return this.ticks[i] === tick ? this.values[i] : undefined;
  }

  /** Có giá trị cho đúng `tick` không. */
  has(tick: number): boolean {
    return tick >= 0 && this.ticks[tick % this.capacity] === tick;
  }

  /** Xóa toàn bộ (khi rebase timeline). */
  clear(): void {
    this.values.fill(undefined);
    this.ticks.fill(-1);
  }
}
