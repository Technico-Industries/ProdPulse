// src/constants/adminMenu.ts
//
// Single source of truth for the Admin navigation entries.
//
// These are EXACTLY the destinations that used to be rendered as cards on
// the Admin Dashboard (see DashboardScreen's old ADMIN_OPTIONS list). The
// main dashboard is now a digital production overview, so the cards moved
// into the hamburger drawer (src/components/AppDrawer.tsx) instead. No
// screen was added or removed here — only where the entry point lives.

import { Ionicons } from '@expo/vector-icons';

export type IconName = keyof typeof Ionicons.glyphMap;

export interface AdminMenuItem {
  key: string;
  title: string;
  subtitle: string;
  icon: IconName;
  accent: string;
  route: string;
  // Shown on the web app only (hidden on Android/iOS).
  webOnly?: boolean;
}

// The entries to render on a platform (pass Platform.OS). Kept here, free of
// react-native, so the node checks in scripts/ can import this file.
export function visibleMenuItems<T extends { webOnly?: boolean }>(items: T[], platformOS: string): T[] {
  return items.filter((i) => !i.webOnly || platformOS === 'web');
}

export const ADMIN_MENU_ITEMS: AdminMenuItem[] = [
  {
    key: 'register-line',
    title: 'Register New Line',
    subtitle: 'Add a production line and its models',
    icon: 'add-circle',
    accent: '#3E7CB1',
    route: 'RegisterLine',
  },
  {
    key: 'manage-lines',
    title: 'Manage Lines',
    subtitle: 'Edit existing lines and models',
    icon: 'create',
    accent: '#4C9A6A',
    route: 'ManageLines',
  },
  {
    key: 'register-incharge',
    title: 'Register New Incharge',
    subtitle: 'Create a plant floor incharge account',
    icon: 'person-add',
    accent: '#F2A93B',
    route: 'RegisterIncharge',
  },
  {
    key: 'manage-incharge',
    title: 'Manage Incharge',
    subtitle: 'Edit accounts, status, and password resets',
    icon: 'people',
    accent: '#4C9A6A',
    route: 'ManageIncharge',
  },
  {
    key: 'generate-report',
    title: 'Generate Report',
    subtitle: 'Export production data for a line, shift, or date range',
    icon: 'bar-chart',
    accent: '#3E7CB1',
    route: 'GenerateReport',
  },
  {
    key: 'model-part-production',
    title: 'Model / Part Production',
    subtitle: 'Total production by model and part for a day or date range',
    icon: 'cube',
    accent: '#4C9A6A',
    route: 'ModelPartProduction',
  },
  {
    key: 'kpi-analysis',
    title: 'KPI Analysis',
    subtitle: 'Track efficiency, downtime, and rejection trends',
    icon: 'analytics',
    accent: '#F2A93B',
    route: 'KPIAnalysis',
  },
  {
    key: 'quality-analysis',
    title: 'Quality Analysis',
    subtitle: 'Rejections, near-miss, and poka-yoke trends across lines',
    icon: 'shield-checkmark',
    accent: '#4C9A6A',
    route: 'QualityAnalysis',
  },
  {
    key: 'prodpulse-ai',
    title: 'ProdPulse AI',
    subtitle: 'AI assistant for production insights and database queries',
    icon: 'sparkles',
    accent: '#8A5CF5',
    route: 'AIAssistant',
    webOnly: true,
  },
];
