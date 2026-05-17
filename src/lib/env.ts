export function isPublicFlagEnabled(value: unknown): boolean {
  return String(value ?? "").toLowerCase() === "true";
}

export const ENABLE_YAHOO_AFFILIATE = isPublicFlagEnabled(
  import.meta.env.PUBLIC_ENABLE_YAHOO_AFFILIATE
);

export const FORCE_NOINDEX = isPublicFlagEnabled(import.meta.env.PUBLIC_NOINDEX);
