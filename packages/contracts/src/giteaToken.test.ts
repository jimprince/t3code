import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import { GiteaTokenSetInput } from "./giteaToken.ts";

const sentinel = "synthetic-token-never-use-in-production";
describe("Gitea token RPC payload", () => {
  it("round trips a whole redacted input through the actual JSON codec", () => {
    const codec = Schema.toCodecJson(GiteaTokenSetInput);
    const decoded = Schema.decodeUnknownSync(codec)({ instanceId: "home", token: sentinel });
    expect(Redacted.value(decoded)).toEqual({ instanceId: "home", token: sentinel });
    expect(String(decoded)).not.toContain(sentinel);
    expect(JSON.stringify(decoded)).not.toContain(sentinel);
    expect(Schema.encodeSync(codec)(decoded)).toEqual({ instanceId: "home", token: sentinel });
  });
  it.each([
    { token: sentinel },
    { instanceId: "home", token: sentinel + "\n" },
    { instanceId: 5, token: sentinel },
  ])("redacts malformed payloads before decoder errors", (input) => {
    try {
      Schema.decodeUnknownSync(Schema.toCodecJson(GiteaTokenSetInput))(input, {
        reportInput: true,
      });
      throw new Error("unexpected success");
    } catch (error) {
      expect(String(error)).not.toContain(sentinel);
      expect(JSON.stringify(error)).not.toContain(sentinel);
      expect(JSON.stringify((error as { issue: unknown }).issue)).not.toContain(sentinel);
      expect(String(error)).not.toContain("unexpected success");
    }
  });
});
