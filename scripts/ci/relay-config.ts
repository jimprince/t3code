// @effect-diagnostics nodeBuiltinImport:off - CI helper writes GitHub step outputs synchronously.
// @effect-diagnostics globalConsole:off - CI helper reports to the workflow log.
import { appendFileSync } from "node:fs";

export const requiredRelayConfig = [
  "CLOUDFLARE_ACCOUNT_ID",
  "PLANETSCALE_ORGANIZATION",
  "AXIOM_ORG_ID",
  "RELAY_API_ZONE_NAME",
  "RELAY_TUNNEL_ZONE_NAME",
  "CLERK_PUBLISHABLE_KEY",
  "CLERK_JWT_AUDIENCE",
  "APNS_ENVIRONMENT",
  "APNS_TEAM_ID",
  "APNS_KEY_ID",
  "APNS_BUNDLE_ID",
  "CLOUDFLARE_API_TOKEN",
  "PLANETSCALE_API_TOKEN_ID",
  "PLANETSCALE_API_TOKEN",
  "AXIOM_TOKEN",
  "CLERK_SECRET_KEY",
  "APNS_PRIVATE_KEY",
] as const;

export function relayConfigured(env: Readonly<Record<string, string | undefined>>): boolean {
  const missing = requiredRelayConfig.filter((key) => !env[key]?.trim());
  if (missing.length === requiredRelayConfig.length) return false;
  if (missing.length > 0)
    throw new Error(`Incomplete relay config. Missing: ${missing.join(", ")}`);
  return true;
}

if (import.meta.main) {
  const configured = relayConfigured(process.env);
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  appendFileSync(process.env.GITHUB_OUTPUT, `configured=${configured}\n`);
  if (!configured) console.log("Relay deployment skipped: no production relay config.");
}
