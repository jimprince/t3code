import { Data, Effect, FileSystem, Path } from "effect";

export class ClientAssetValidationError extends Data.TaggedError("ClientAssetValidationError")<{
  readonly message: string;
}> {}

export function collectClientAssetReferences(indexHtml: string): ReadonlyArray<string> {
  return [...indexHtml.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined)
    .filter((value) => {
      const normalized = value.split("#")[0]?.split("?")[0] ?? "";
      if (!normalized) return false;
      if (normalized.startsWith("http://") || normalized.startsWith("https://")) return false;
      if (normalized.startsWith("data:") || normalized.startsWith("mailto:")) return false;
      return true;
    });
}

export function validateBundledClientAssets(clientDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const indexPath = path.join(clientDir, "index.html");
    const indexHtml = yield* fs.readFileString(indexPath);
    const missing: string[] = [];

    for (const ref of collectClientAssetReferences(indexHtml)) {
      const normalizedRef = ref.split("#")[0]?.split("?")[0] ?? "";
      const ext = path.extname(normalizedRef);
      if (!ext) continue;

      const relativePath = normalizedRef.replace(/^\/+/, "");
      const assetPath = path.join(clientDir, relativePath);
      if (!(yield* fs.exists(assetPath))) {
        missing.push(normalizedRef);
      }
    }

    if (missing.length > 0) {
      const preview = missing.slice(0, 6).join(", ");
      const suffix = missing.length > 6 ? ` (+${missing.length - 6} more)` : "";
      return yield* new ClientAssetValidationError({
        message: `Bundled client references missing files in ${indexPath}: ${preview}${suffix}. Rebuild web/server artifacts.`,
      });
    }
  });
}
