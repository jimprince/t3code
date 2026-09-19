import { expect, it, vi } from "vite-plus/test";

import { modelRenderSlotStateForTest, requestModelRenderSlot } from "./modelRenderSlots";

it("allows at most two live model contexts and grants the next after disposal", () => {
  const grants = [vi.fn(), vi.fn(), vi.fn()];
  const releases = grants.map((grant) => requestModelRenderSlot(grant));
  expect(grants.map((grant) => grant.mock.calls.length)).toEqual([1, 1, 0]);
  expect(modelRenderSlotStateForTest()).toEqual({ active: 2, waiting: 1 });
  releases[0]!();
  expect(grants[2]).toHaveBeenCalledOnce();
  releases[1]!();
  releases[2]!();
  expect(modelRenderSlotStateForTest()).toEqual({ active: 0, waiting: 0 });
});
