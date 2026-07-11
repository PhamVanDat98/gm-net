/**
 * `GameClient` — runtime client transport-agnostic ([docs/design/004-netcode.md]
 * §2–4, §7). Điều phối clock sync, input pipeline (redundancy + adaptive lead),
 * snapshot receiver quanh một {@link ClientTransport}. Không import DOM, không
 * nhắc tên Colyseus — nhận `now()` để test bằng đồng hồ ảo.
 *
 * M3 dừng ở khung: gửi input "echo box", đo RTT/lead, nhận snapshot mới nhất.
 * Prediction/reconciliation (M4) và interpolation (M5) cắm vào qua `onSnapshot`
 * + `unackedInputs()` mà không phải sửa lớp này.
 */
import {
  MessageType,
  ProtocolError,
  type ProtocolCodec,
  type Snapshot,
} from '@gm-net/core';
import { SERVER_TICK_MS, type Handshake } from '@gm-net/shared';
import { ClockSync, type ClockSyncOptions } from './clock.js';
import { InputPipeline, InputLeadController, type InputPipelineOptions, type InputLeadOptions } from './input.js';
import { SnapshotReceiver, type SnapshotListener } from './snapshot.js';
import type { ClientTransport } from './transport.js';

export interface GameClientOptions<Input> {
  /** Codec wire (khớp cấu hình server: quantization + inputCodec + entityCodecs). */
  codec: ProtocolCodec<Input>;
  /** Đồng hồ (ms). Mặc định `Date.now`. Test tiêm đồng hồ ảo. */
  now?: () => number;
  /** Độ dài tick (ms). Mặc định `SERVER_TICK_MS`. */
  tickMs?: number;
  clock?: ClockSyncOptions;
  input?: InputPipelineOptions;
  lead?: InputLeadOptions;
  /** Nhận handshake JSON lúc join. */
  onHandshake?: (h: Handshake) => void;
  /** Nhận mỗi snapshot mới (đã bỏ bản cũ). */
  onSnapshot?: SnapshotListener;
}

export interface ClientMetrics {
  /** RTT ước lượng (ms) — `NaN` khi chưa sync. */
  rtt: number;
  jitter: number;
  inputLead: number;
  serverTickNow: number;
  pendingInputs: number;
  lastSnapshotTick: number;
}

export class GameClient<Input = unknown> {
  private readonly codec: ProtocolCodec<Input>;
  private readonly now: () => number;
  private readonly tickMs: number;

  private readonly clock: ClockSync;
  private readonly pipeline: InputPipeline<Input>;
  private readonly leadCtl: InputLeadController;
  private readonly snapshots: SnapshotReceiver<Input>;

  private readonly onHandshakeCb?: (h: Handshake) => void;

  private _handshake: Handshake | undefined;
  private _connected = false;

  constructor(
    private readonly transport: ClientTransport,
    opts: GameClientOptions<Input>,
  ) {
    this.codec = opts.codec;
    this.now = opts.now ?? (() => Date.now());
    this.tickMs = opts.tickMs ?? SERVER_TICK_MS;
    this.clock = new ClockSync({ tickMs: this.tickMs, ...opts.clock });
    this.pipeline = new InputPipeline<Input>(opts.input);
    this.leadCtl = new InputLeadController(opts.lead);
    this.snapshots = new SnapshotReceiver<Input>(this.codec);
    this.onHandshakeCb = opts.onHandshake;
    if (opts.onSnapshot) this.snapshots.onSnapshot(opts.onSnapshot);

    this.transport.onJson('handshake', (payload) => this.handleHandshake(payload));
    this.transport.onBytes((type, bytes) => this.handleBytes(type, bytes));
    this.transport.onLeave(() => {
      this._connected = false;
    });
  }

  /** Bắt đầu vòng đời client: neo mốc warmup ping. Gọi sau khi transport sẵn sàng. */
  start(): void {
    this._connected = true;
    this.clock.connect(this.now());
  }

  get connected(): boolean {
    return this._connected;
  }

  get handshake(): Handshake | undefined {
    return this._handshake;
  }

  /** Entity local player điều khiển (từ handshake); -1 khi chưa có. */
  get entityId(): number {
    return this._handshake ? this._handshake.entityId : -1;
  }

  get inputLead(): number {
    return this.leadCtl.lead;
  }

  get rtt(): number {
    return this.clock.rtt;
  }

  get latestSnapshot(): Snapshot | undefined {
    return this.snapshots.latest;
  }

  /** Đăng ký thêm listener snapshot (M4/M5 tiêu thụ). */
  onSnapshot(cb: SnapshotListener): () => void {
    return this.snapshots.onSnapshot(cb);
  }

  /** Input chưa ack (M4 replay reconciliation). */
  unackedInputs(): ReadonlyArray<{ seq: number; tick: number; payload: Input }> {
    return this.pipeline.unacked();
  }

  serverTickNow(now = this.now()): number {
    return this.clock.serverTickNow(now);
  }

  /** Tick server client nên nhắm input tới = `ceil(serverTickNow) + inputLead`. */
  targetTick(now = this.now()): number {
    const est = this.clock.serverTickNow(now);
    const base = Number.isFinite(est) ? Math.ceil(est) : Math.max(0, this.snapshots.latestTick);
    return base + this.leadCtl.lead;
  }

  metrics(now = this.now()): ClientMetrics {
    return {
      rtt: this.clock.rtt,
      jitter: this.clock.jitter,
      inputLead: this.leadCtl.lead,
      serverTickNow: this.clock.serverTickNow(now),
      pendingInputs: this.pipeline.pendingCount,
      lastSnapshotTick: this.snapshots.latestTick,
    };
  }

  /**
   * Nhịp định kỳ (host gọi mỗi frame/tick): gửi ping khi tới hạn. Tách khỏi
   * `sendInput` để host tự quyết cadence sim.
   */
  update(now = this.now()): void {
    if (this.clock.shouldPing(now)) {
      this.transport.sendBytes(MessageType.Ping, this.codec.encodePing({ clientTime: now }));
      this.clock.markPinged(now);
    }
  }

  /**
   * Lấy mẫu + gửi một input, nhắm `targetTick(now)`. Trả `seq`/`tick` đã gán
   * (M4 map seq→tick vào ring snapshot local). Kèm redundancy N input chưa ack.
   */
  sendInput(payload: Input, now = this.now()): { seq: number; tick: number } {
    const tick = this.targetTick(now);
    const ackTick = Math.max(0, this.snapshots.latestTick); // -1 (chưa có) → 0 trên wire (u32)
    const sampled = this.pipeline.sample(payload, tick, ackTick);
    this.transport.sendBytes(MessageType.Input, this.codec.encodeInput(sampled.packet));
    return { seq: sampled.seq, tick: sampled.tick };
  }

  leave(): void {
    this._connected = false;
    this.transport.leave();
  }

  private handleHandshake(payload: unknown): void {
    const h = payload as Handshake;
    this._handshake = h;
    this.onHandshakeCb?.(h);
  }

  private handleBytes(type: number, bytes: Uint8Array): void {
    try {
      if (type === MessageType.Snapshot) {
        const snap = this.snapshots.receive(bytes);
        if (snap) {
          this.pipeline.ack(snap.lastProcessedSeq);
          this.leadCtl.onSnapshot(snap.lateInputs); // đã là "late trong cửa sổ" (server consume-on-read)
        }
      } else if (type === MessageType.Pong) {
        const pong = this.codec.decodePong(bytes);
        this.clock.onPong(pong, this.now());
        this.leadCtl.applyBase(this.clock.baseInputLead());
      }
      // Type lạ: bỏ qua (forward-compat).
    } catch (err) {
      if (err instanceof ProtocolError) return; // byte hỏng từ mạng: nuốt
      throw err;
    }
  }
}
