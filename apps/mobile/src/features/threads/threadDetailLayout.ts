export const IOS_NAV_BAR_HEIGHT = 44;
const PENDING_REQUEST_PANEL_MIN_HEIGHT = 180;

export function resolvePendingRequestPanelMaxHeight(input: {
  readonly viewportHeight: number;
  readonly topInset: number;
  readonly composerChrome: number;
  readonly composerBottomInset: number;
  readonly activeWorkIndicatorHeight: number;
}): number {
  const availableHeight = input.viewportHeight - input.topInset - IOS_NAV_BAR_HEIGHT - 16;
  const reservedOverlayHeight =
    input.composerChrome + input.composerBottomInset + input.activeWorkIndicatorHeight + 16;

  return Math.max(PENDING_REQUEST_PANEL_MIN_HEIGHT, availableHeight - reservedOverlayHeight);
}
