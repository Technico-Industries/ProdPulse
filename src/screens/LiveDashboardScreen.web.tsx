// src/screens/LiveDashboardScreen.web.tsx
//
// Web build of /live-dashboard (Metro picks this file over
// LiveDashboardScreen.tsx on web). Opened in a new tab by the admin
// overview's Live Dashboard button; same origin, so the admin is already
// signed in. Rendered with plain React DOM — see src/liveDashboard/.
// Admins only: other accounts never start the Firestore listeners.

import React from 'react';
import { useAuthStore } from '../stores/authStore';
import { useLiveWeekData } from '../liveDashboard/useLiveWeekData';
import LiveDashboardView from '../liveDashboard/LiveDashboardView';

function AdminLiveDashboard() {
  const data = useLiveWeekData();
  return <LiveDashboardView data={data} />;
}

export default function LiveDashboardScreen() {
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  if (!isAdmin) return <LiveDashboardView data={null} deniedMessage="The Live Dashboard is available to admin accounts." />;
  return <AdminLiveDashboard />;
}
