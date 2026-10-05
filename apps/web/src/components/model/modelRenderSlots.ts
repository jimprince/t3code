const MAX_LIVE_MODEL_CONTEXTS = 2;

type Request = { readonly grant: () => void };
let active = 0;
const waiting: Request[] = [];

function drain() {
  while (active < MAX_LIVE_MODEL_CONTEXTS) {
    const request = waiting.shift();
    if (!request) return;
    active += 1;
    request.grant();
  }
}

/** Visible viewers share a process-wide two-context budget. */
export function requestModelRenderSlot(grant: () => void): () => void {
  const request = { grant };
  waiting.push(request);
  drain();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const index = waiting.indexOf(request);
    if (index >= 0) waiting.splice(index, 1);
    else active = Math.max(0, active - 1);
    drain();
  };
}

export function modelRenderSlotStateForTest() {
  return { active, waiting: waiting.length };
}
