// src/constants/qualityMenu.ts
//
// Single source of truth for the Quality Control navigation entries.
//
// These are EXACTLY the destinations that used to be rendered as cards on
// the Quality Control Dashboard (DashboardScreen's QUALITY_OPTIONS list).
// The Quality main dashboard is now a digital quality overview
// (QualityOverviewScreen), so the cards moved into the hamburger drawer
// (src/components/AppDrawer.tsx). No screen was added or removed — only
// where the entry point lives.
//
// Shares the AdminMenuItem shape (src/constants/adminMenu.ts) so one drawer
// component renders every role.

import { AdminMenuItem } from './adminMenu';

export const QUALITY_MENU_ITEMS: AdminMenuItem[] = [
  {
    key: 'record-rejection',
    title: 'Record Rejection',
    subtitle: 'Log rejected parts for a line',
    icon: 'close-circle',
    accent: '#D64545',
    route: 'RecordRejection',
  },
  {
    key: 'quality-analysis',
    title: 'Quality Analysis',
    subtitle: 'Full quality report: filters, records, charts, Excel export',
    icon: 'shield-checkmark',
    accent: '#4C9A6A',
    route: 'QualityAnalysis',
  },
];
