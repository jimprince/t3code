// @effect-diagnostics nodeBuiltinImport:off - canonical digest at the host routing boundary.
import * as NodeCrypto from "node:crypto";
import { HandoverHostReceipt } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
const encode = Schema.encodeSync(Schema.fromJsonString(HandoverHostReceipt));
/** Digest detects receipt corruption; authority still comes only from the authenticated admin session. */
export const hostReceiptDigest = (receipt: HandoverHostReceipt) =>
  NodeCrypto.createHash("sha256")
    .update(encode({ ...receipt, digest: "" }))
    .digest("hex");
