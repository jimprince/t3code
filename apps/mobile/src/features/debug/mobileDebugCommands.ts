export type MobileDebugCommand =
  | {
      readonly type: "pair";
      readonly pairingUrl: string;
      readonly replaceExisting: boolean;
    }
  | { readonly type: "clear-connections" }
  | { readonly type: "dump" }
  | {
      readonly type: "disconnect";
      readonly all: boolean;
      readonly environmentId: string | null;
    };

function normalizeCommandName(url: URL): string {
  const host = url.hostname.trim();
  const path = url.pathname.replace(/^\/+/, "").trim();
  return [host, path].filter(Boolean).join("/");
}

export function parseMobileDebugCommand(rawUrl: string): MobileDebugCommand | null {
  const url = new URL(rawUrl);
  const command = normalizeCommandName(url);

  switch (command) {
    case "debug/pair": {
      const pairingUrl = url.searchParams.get("pairingUrl")?.trim() ?? "";
      if (!pairingUrl) {
        throw new Error("Debug pair command is missing pairingUrl.");
      }
      return {
        type: "pair",
        pairingUrl,
        replaceExisting: url.searchParams.get("replace") === "1",
      };
    }
    case "debug/clear-connections":
      return { type: "clear-connections" };
    case "debug/dump":
      return { type: "dump" };
    case "debug/disconnect":
      return {
        type: "disconnect",
        all: url.searchParams.get("all") === "1",
        environmentId: url.searchParams.get("environmentId")?.trim() || null,
      };
    default:
      return null;
  }
}
