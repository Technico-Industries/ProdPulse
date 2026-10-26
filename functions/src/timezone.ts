// functions/src/timezone.ts
//
// The app computes production dates in the device's local time (the 6:30 AM
// cutover in utils/productionDay, Shift B's after-midnight frame). Cloud
// Functions run in UTC, so the backend pins the plants' timezone before any
// date is computed — otherwise "today" and every legacy createdAt window
// would be 5½ hours off. Override with PRODUCTION_TIMEZONE in functions/.env.

export const DEFAULT_PRODUCTION_TIMEZONE = 'Asia/Kolkata';

export function applyProductionTimezone(env: Record<string, string | undefined> = process.env): string {
  const tz = env.PRODUCTION_TIMEZONE?.trim() || DEFAULT_PRODUCTION_TIMEZONE;
  process.env.TZ = tz;
  return tz;
}

applyProductionTimezone();
