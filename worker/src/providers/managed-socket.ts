import WebSocket from "ws";
import type { Logger } from "../types.js";

export type SocketFactory = (url: string) => WebSocket;

export type BackoffOpts = { baseMs: number; maxMs: number };

/** Equal-jitter exponential backoff: half deterministic, half random. */
export function backoffDelay(attempt: number, { baseMs, maxMs }: BackoffOpts, random: () => number = Math.random): number {
  const ceil = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30));
  return Math.floor(ceil / 2 + random() * (ceil / 2));
}

export type ManagedSocketOpts = {
  name: string;
  url: () => string;
  log: Logger;
  /** Called on every (re)connect once the TCP/TLS+WS handshake is complete. */
  onOpen: (s: ManagedSocket) => void;
  /** Called with each text frame. */
  onMessage: (raw: string, s: ManagedSocket) => void;
  onClose?: (code: number, s: ManagedSocket) => void;
  onError?: (err: Error, s: ManagedSocket) => void;
  backoff: BackoffOpts;
  /** Ping interval. A connection with no inbound traffic (data, ping or pong) for 2.5x this is dropped. */
  heartbeatMs: number;
  factory?: SocketFactory;
  random?: () => number;
};

export type SocketState = "idle" | "connecting" | "open" | "waiting" | "stopped";

/**
 * A websocket that reconnects forever with exponential backoff + jitter, pings to
 * detect half-open connections, and can be told to stop reconnecting (fatal errors).
 */
export class ManagedSocket {
  state: SocketState = "idle";
  attempts = 0;
  reconnects = 0;
  lastMessageAt = 0;
  private ws: WebSocket | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private hbTimer: NodeJS.Timeout | null = null;
  private lastActivity = 0;
  private minDelayMs = 0;
  private stopped = false;

  constructor(private readonly o: ManagedSocketOpts) {}

  start() {
    this.stopped = false;
    this.connect();
  }

  isOpen() {
    return this.state === "open" && this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: unknown): boolean {
    if (!this.isOpen() || !this.ws) return false;
    try {
      this.ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
      return true;
    } catch (err) {
      this.o.log.warn("send failed", { error: errMsg(err) });
      return false;
    }
  }

  /** Drop the connection and reconnect after at least `minDelayMs` (e.g. connection-limit errors). */
  reconnect(minDelayMs = 0) {
    this.minDelayMs = Math.max(this.minDelayMs, minDelayMs);
    if (this.ws) this.ws.terminate();
    else if (!this.stopped) this.scheduleRetry();
  }

  /** Stop permanently without reconnecting (bad credentials, etc). */
  halt() {
    this.stopped = true;
    this.clearTimers();
    this.state = "stopped";
    try {
      this.ws?.terminate();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  async stop(graceMs = 500) {
    const ws = this.ws;
    this.stopped = true;
    this.clearTimers();
    this.state = "stopped";
    this.ws = null;
    if (!ws) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        ws.terminate();
        resolve();
      }, graceMs);
      ws.once("close", () => {
        clearTimeout(t);
        resolve();
      });
      try {
        ws.close(1000, "shutdown");
      } catch {
        ws.terminate();
      }
    });
  }

  private connect() {
    if (this.stopped) return;
    this.state = "connecting";
    let ws: WebSocket;
    try {
      ws = (this.o.factory ?? ((u) => new WebSocket(u)))(this.o.url());
    } catch (err) {
      this.o.log.error("socket construction failed", { error: errMsg(err) });
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.state = "open";
      this.lastActivity = Date.now();
      this.startHeartbeat();
      this.o.log.info("connected", { attempt: this.attempts });
      this.o.onOpen(this);
    });
    ws.on("message", (data) => {
      if (this.ws !== ws) return;
      this.lastActivity = Date.now();
      this.lastMessageAt = this.lastActivity;
      this.attempts = 0; // healthy: reset backoff
      this.o.onMessage(data.toString(), this);
    });
    ws.on("ping", () => (this.lastActivity = Date.now()));
    ws.on("pong", () => (this.lastActivity = Date.now()));
    ws.on("error", (err) => {
      // 'close' always follows; just record it.
      this.o.log.warn("socket error", { error: errMsg(err) });
      this.o.onError?.(err, this);
    });
    ws.on("close", (code) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopHeartbeat();
      this.o.onClose?.(code, this);
      if (!this.stopped) this.scheduleRetry();
    });
  }

  private scheduleRetry() {
    if (this.stopped || this.retryTimer) return;
    const delay = Math.max(this.minDelayMs, backoffDelay(this.attempts, this.o.backoff, this.o.random));
    this.minDelayMs = 0;
    this.attempts++;
    this.reconnects++;
    this.state = "waiting";
    this.o.log.warn("reconnecting", { inMs: delay, attempt: this.attempts });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.hbTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws) return;
      if (Date.now() - this.lastActivity > this.o.heartbeatMs * 2.5) {
        this.o.log.warn("stale connection, terminating", { silentMs: Date.now() - this.lastActivity });
        ws.terminate();
        return;
      }
      try {
        ws.ping();
      } catch {
        /* close handler will follow */
      }
    }, this.o.heartbeatMs);
    this.hbTimer.unref?.();
  }

  private stopHeartbeat() {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = null;
  }

  private clearTimers() {
    this.stopHeartbeat();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
