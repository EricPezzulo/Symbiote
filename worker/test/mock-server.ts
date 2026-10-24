import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";

export type MockServer = {
  url: string;
  wss: WebSocketServer;
  /** Parsed JSON messages received from clients (in order). */
  received: any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Request URLs of each connection (path + query). */
  connections: string[];
  clients(): WebSocket[];
  onConnection(fn: (ws: WebSocket, url: string) => void): void;
  close(): Promise<void>;
};

export async function startMockServer(): Promise<MockServer> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const port = (wss.address() as AddressInfo).port;
  const received: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const connections: string[] = [];
  let handler: (ws: WebSocket, url: string) => void = () => {};
  wss.on("connection", (ws, req) => {
    connections.push(req.url ?? "/");
    ws.on("message", (d) => {
      try {
        received.push(JSON.parse(d.toString()));
      } catch {
        received.push(d.toString());
      }
    });
    handler(ws, req.url ?? "/");
  });
  return {
    url: `ws://127.0.0.1:${port}`,
    wss,
    received,
    connections,
    clients: () => [...wss.clients],
    onConnection: (fn) => {
      handler = fn;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      }),
  };
}

export async function waitFor(pred: () => boolean, timeoutMs = 3000, what = "condition"): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
