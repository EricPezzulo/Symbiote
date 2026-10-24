import { z } from "zod";

const optionalPositive = (label: string) =>
  z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : Number(v.replace(/[$,]/g, ""))))
    .refine((v) => v === null || (Number.isFinite(v) && v > 0 && v < 1e12), `${label} must be a positive number`);

const STOCK_RE = /^[A-Z0-9][A-Z0-9.\-]{0,9}$/;
const CRYPTO_RE = /^[A-Z0-9]{1,15}$/;

export const watchFields = {
  notes: z
    .string()
    .trim()
    .max(280, "Note is too long (280 max)")
    .transform((v) => v || null),
  alert_above: optionalPositive("Alert above"),
  alert_below: optionalPositive("Alert below"),
};

const targetsOrdered = (v: { alert_above: number | null; alert_below: number | null }) =>
  v.alert_above === null || v.alert_below === null || v.alert_below < v.alert_above;

export const watchAddSchema = z
  .object({
    symbol: z.string().trim().toUpperCase().min(1, "Symbol is required"),
    asset_type: z.enum(["stock", "crypto"]),
    ...watchFields,
  })
  .transform((v) => (v.asset_type === "crypto" ? { ...v, symbol: v.symbol.replace(/[-/_](USD|USDT)$/, "") } : v))
  .refine((v) => (v.asset_type === "stock" ? STOCK_RE : CRYPTO_RE).test(v.symbol), {
    message: "Invalid symbol (stocks: AAPL, BRK.B; crypto: BTC, ETH)",
    path: ["symbol"],
  })
  .refine(targetsOrdered, { message: "Alert below must be lower than alert above", path: ["alert_below"] });

export const watchUpdateSchema = z
  .object({ id: z.uuid(), ...watchFields })
  .refine(targetsOrdered, { message: "Alert below must be lower than alert above", path: ["alert_below"] });
