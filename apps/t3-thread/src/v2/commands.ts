import type { ModelSelection } from "../types.js";
export function wireModel(selection: ModelSelection) {
  return {
    instanceId: selection.provider,
    model: selection.model,
    ...(selection.options
      ? { options: Object.entries(selection.options).map(([id, value]) => ({ id, value })) }
      : {}),
  };
}
