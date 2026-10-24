import { z } from "zod";

const optionalNumber = (label: string) =>
  z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : Number(v.replace(/[$,]/g, ""))))
    .refine((v) => v === null || (Number.isFinite(v) && v >= 0), `${label} must be a non-negative number`);

export const accountSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  type: z.enum(["brokerage", "exchange", "crypto_wallet", "manual"]),
  institution: z
    .string()
    .trim()
    .max(80)
    .transform((v) => v || null),
});

export const ASSET_TYPES = ["stock", "crypto"] as const;

export const holdingSchema = z.object({
  account_id: z.uuid("Choose an account"),
  symbol: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9.\-_]{0,23}$/, "Symbol must be 1-24 letters, numbers, . - or _"),
  asset_type: z.enum(ASSET_TYPES),
  quantity: z
    .string()
    .trim()
    .transform((v) => Number(v.replace(/,/g, "")))
    .refine((v) => Number.isFinite(v) && v > 0, "Quantity must be greater than 0")
    .refine((v) => v < 1e15, "Quantity is too large"),
  cost_basis: optionalNumber("Cost basis"),
});

export const holdingUpdateSchema = holdingSchema.omit({ account_id: true }).extend({ id: z.uuid() });

export function firstError(e: z.ZodError): string {
  return e.issues[0]?.message ?? "Invalid input";
}

export const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  brokerage: "Brokerage",
  exchange: "Crypto exchange",
  crypto_wallet: "Crypto wallet",
  manual: "Manual",
  bank: "Bank",
};
