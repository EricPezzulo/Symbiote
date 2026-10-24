import "server-only";
import { Snaptrade, SnaptradeAuth } from "snaptrade-typescript-sdk";

export function isSnaptradeConfigured(): boolean {
  return Boolean(process.env.SNAPTRADE_CLIENT_ID && process.env.SNAPTRADE_CONSUMER_KEY);
}

export function getSnaptrade() {
  const clientId = process.env.SNAPTRADE_CLIENT_ID;
  const consumerKey = process.env.SNAPTRADE_CONSUMER_KEY;
  if (!clientId || !consumerKey) throw new Error("SnapTrade is not configured");
  return new Snaptrade({ auth: SnaptradeAuth.commercialApiKey({ clientId, consumerKey }) });
}

/** Short, secret-free description of an SDK/axios error. */
export function describeSnaptradeError(e: unknown): string {
  const err = e as { responseBody?: { detail?: string; message?: string }; status?: number; message?: string };
  const detail = err?.responseBody?.detail ?? err?.responseBody?.message;
  return [err?.status ? `HTTP ${err.status}` : null, detail ?? err?.message ?? "unknown error"]
    .filter(Boolean)
    .join(": ")
    .slice(0, 300);
}
