// src/utils/prodAIPanelLayout.ts
//
// Where the Prod AI popup (components/ProdAIPanel) sits for a viewport.
// Pure, so the breakpoints are checked in scripts/testProdAIPanel.ts.
//   • desktop web (>= 640px wide): 400px floating panel, bottom-right, 24px
//     viewport margins, at most 680px tall;
//   • narrow / mobile web: fills the viewport minus an 8px margin (plus any
//     safe-area inset);
//   • React Native: full-screen sheet inside the safe area.

export const PROD_AI_PANEL_DESKTOP_MIN_WIDTH = 640;
export const PROD_AI_PANEL_WIDTH = 400;
export const PROD_AI_PANEL_MAX_HEIGHT = 680;

export type ProdAIPanelFrame = {
  left?: number;
  right: number;
  top: number;
  bottom: number;
  width?: number;
  layout: 'floating' | 'fill' | 'sheet';
};

export function prodAIPanelFrame(
  platformOS: string,
  viewport: { width: number; height: number },
  insets: { top: number; bottom: number; left: number; right: number }
): ProdAIPanelFrame {
  if (platformOS !== 'web') {
    return { left: insets.left, right: insets.right, top: insets.top, bottom: insets.bottom, layout: 'sheet' };
  }
  if (viewport.width >= PROD_AI_PANEL_DESKTOP_MIN_WIDTH) {
    const margin = 24;
    const height = Math.min(PROD_AI_PANEL_MAX_HEIGHT, viewport.height - margin * 2);
    return { right: margin, bottom: margin, top: Math.max(margin, viewport.height - margin - height), width: PROD_AI_PANEL_WIDTH, layout: 'floating' };
  }
  return { left: 8 + insets.left, right: 8 + insets.right, top: 8 + insets.top, bottom: 8 + insets.bottom, layout: 'fill' };
}
