// src/constants/supervisorMenu.ts
//
// Single source of truth for the Supervisor navigation entries.
//
// These are EXACTLY the destinations that used to be rendered as cards on
// the Supervisor Dashboard (DashboardScreen's SUPERVISOR_OPTIONS list). The
// Supervisor main dashboard is now a digital active-session overview, so
// the cards moved into the hamburger drawer (src/components/AppDrawer.tsx).
// No screen was added or removed — only where the entry point lives.
//
// Shares the AdminMenuItem shape (src/constants/adminMenu.ts) so one drawer
// component renders both roles.

import { AdminMenuItem } from './adminMenu';

export const SUPERVISOR_MENU_ITEMS: AdminMenuItem[] = [
  {
    key: 'record-production',
    title: 'Record Production',
    subtitle: 'Log output for this shift',
    icon: 'construct',
    accent: '#F2A93B',
    route: 'RecordProduction',
  },
  {
    key: 'material-order',
    title: 'Material Order',
    subtitle: 'Request materials for a line',
    icon: 'cube',
    accent: '#3E7CB1',
    route: 'MaterialOrder',
  },
  {
    key: 'kpi-report',
    title: 'KPI Report',
    subtitle: 'Your production performance at a glance',
    icon: 'speedometer',
    accent: '#4C9A6A',
    route: 'KPIReport',
  },
  {
    key: 'manage-manpower',
    title: 'Manage Manpower',
    subtitle: 'Register new operators, Delete operator ',
    icon: 'people-circle',
    accent: '#8A5CF5',
    route: 'ManageManpower',
  },
];
