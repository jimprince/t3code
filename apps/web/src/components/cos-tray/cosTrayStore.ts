/**
 * Where the Chief of Staff tray stands on this device: its mode and width survive a reload, like
 * the sidebar's. The conversation draft lives with the thread's own composer draft, so a closed
 * tray keeps it.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";
import { toggleCosTray, type CosTrayMode } from "./cosTray.logic";

const COS_TRAY_STORAGE_KEY = "t3code:cos-tray";

interface CosTrayState {
  readonly mode: CosTrayMode;
  readonly expanded: boolean;
  /** Phone only, never persisted: a reload must not pop the sheet open. */
  readonly phoneSheetOpen: boolean;
  /** Set by the mounted tray: whether it is rendering as the phone sheet. */
  readonly phone: boolean;
  readonly setPhone: (phone: boolean) => void;
  readonly setPhoneSheetOpen: (open: boolean) => void;
  readonly setMode: (mode: CosTrayMode) => void;
  readonly toggle: () => void;
  readonly toggleExpanded: () => void;
}

export const useCosTrayStore = create<CosTrayState>()(
  persist(
    (set, get) => ({
      mode: "minimized",
      expanded: false,
      phoneSheetOpen: false,
      phone: false,
      setPhone: (phone) => set({ phone }),
      setPhoneSheetOpen: (phoneSheetOpen) => set({ phoneSheetOpen }),
      setMode: (mode) => set({ mode, phoneSheetOpen: mode === "open" }),
      toggle: () => {
        const { mode: current, phone, phoneSheetOpen } = get();
        const mode = toggleCosTray(current, phone ? { sheetOpen: phoneSheetOpen } : undefined);
        set({ mode, phoneSheetOpen: mode === "open" });
      },
      toggleExpanded: () => set((state) => ({ expanded: !state.expanded })),
    }),
    {
      name: COS_TRAY_STORAGE_KEY,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ mode: state.mode, expanded: state.expanded }),
    },
  ),
);
