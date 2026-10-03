import React from 'react';
import { NavigationContainer, LinkingOptions } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import ScreenContainer from './src/components/ScreenContainer';
import { useAuthStore } from './src/stores/authStore';

import LoginScreen from './src/screens/LoginScreen';
import DashboardScreen from './src/screens/DashboardScreen';
import RegisterLineScreen from './src/screens/RegisterLineScreen';
import ManageLinesScreen from './src/screens/ManageLinesScreen';
import RegisterInchargeScreen from './src/screens/RegisterInchargeScreen';
import ManageInchargeScreen from './src/screens/ManageInchargeScreen';
import EditInchargeScreen from './src/screens/EditInchargeScreen';
import RecordProductionScreen from './src/screens/RecordProductionScreen';
import RecordRejectionScreen from './src/screens/RecordRejectionScreen';
import MaterialOrderScreen from './src/screens/MaterialOrderScreen';
import KPIReportScreen from './src/screens/KPIReportScreen';
import ComingSoonReportScreen from './src/screens/ComingSoonReportScreen';
import NearMissReportScreen from './src/screens/NearMissReportScreen';
import GenerateReportScreen from './src/screens/GenerateReportScreen';
import KPIAnalysisScreen from './src/screens/KPIAnalysisScreen';
import ManDaysTrackerScreen from './src/screens/ManDaysTrackerScreen';
import PokaYokeRecordScreen from './src/screens/PokaYokeRecordScreen';
import PlanVsActualRecordScreen from './src/screens/PlanVsActualRecordScreen';
import ReworkDataRecordScreen from './src/screens/ReworkDataRecordScreen';
import KaizenTrackerScreen from './src/screens/KaizenTrackerScreen';
import ManageManpowerScreen from './src/screens/ManageManpowerScreen';
import AttendanceSheetScreen from './src/screens/AttendanceSheetScreen';
import PCSPerHourScreen from './src/screens/PCSPerHourScreen';
import QualityAnalysisScreen from './src/screens/QualityAnalysisScreen';
import AIAssistantScreen from './src/screens/AIAssistantScreen';


// Unchanged — every existing route name, kept in one place so both
// AuthNavigator and AppNavigator (and anything importing this type
// elsewhere) still resolve against the exact same contract as before.
export type RootStackParamList = {
  AdminLogin: undefined;
  Home: undefined;
  RegisterLine: { lineId?: string } | undefined;
  ManageLines: undefined;
  RegisterIncharge: undefined;
  ManageIncharge: undefined;
  EditIncharge: { uid: string };
  RecordProduction: undefined;
  RecordRejection: undefined;
  MaterialOrder: undefined;
  KPIReport: undefined;
  NearMissReport: undefined;
  ComingSoonReport: { title: string };
  GenerateReport: undefined;
  KPIAnalysis: undefined;
  ManDaysTracker: undefined;
  PokaYokeRecord: undefined;
  PlanVsActualRecords: undefined;
  ReworkDataRecord: undefined;
  KaizenTracker: undefined;
  ManageManpower: undefined;
  AttendanceSheet: undefined;
  PCSPerHour: undefined;
  QualityAnalysis: undefined;
  AIAssistant: undefined;
};

const AuthStack = createNativeStackNavigator<RootStackParamList>();
const AppStack = createNativeStackNavigator<RootStackParamList>();

// Wraps a screen component in ScreenContainer at the point it's registered
// below — every screen gets the same top/bottom safe-area handling from
// this ONE file, without editing any of the individual screen files. Props
// (including navigation/route) pass through untouched.
function withScreenContainer<P extends object>(ScreenComponent: React.ComponentType<P>) {
  return function ScreenWithContainer(props: P) {
    return (
      <ScreenContainer>
        <ScreenComponent {...props} />
      </ScreenContainer>
    );
  };
}

const screenOptions = {
  headerShown: false,
  contentStyle: { backgroundColor: '#14181C' },
} as const;

// ─── Auth stack — reachable only while signed out ──────────────────────────
function AuthNavigator() {
  return (
    <AuthStack.Navigator initialRouteName="AdminLogin" screenOptions={screenOptions}>
      <AuthStack.Screen name="AdminLogin" component={withScreenContainer(LoginScreen)} />
    </AuthStack.Navigator>
  );
}

// ─── App stack — every other existing route, same names, same order ───────
function AppNavigator() {
  return (
    <AppStack.Navigator initialRouteName="Home" screenOptions={screenOptions}>
      <AppStack.Screen name="Home" component={withScreenContainer(DashboardScreen)} />
      <AppStack.Screen name="RegisterLine" component={withScreenContainer(RegisterLineScreen)} />
      <AppStack.Screen name="ManageLines" component={withScreenContainer(ManageLinesScreen)} />
      <AppStack.Screen name="RegisterIncharge" component={withScreenContainer(RegisterInchargeScreen)} />
      <AppStack.Screen name="ManageIncharge" component={withScreenContainer(ManageInchargeScreen)} />
      <AppStack.Screen name="EditIncharge" component={withScreenContainer(EditInchargeScreen)} />
      <AppStack.Screen name="RecordProduction" component={withScreenContainer(RecordProductionScreen)} />
      <AppStack.Screen name="RecordRejection" component={withScreenContainer(RecordRejectionScreen)} />
      <AppStack.Screen name="MaterialOrder" component={withScreenContainer(MaterialOrderScreen)} />
      <AppStack.Screen name="KPIReport" component={withScreenContainer(KPIReportScreen)} />
      <AppStack.Screen name="ComingSoonReport" component={withScreenContainer(ComingSoonReportScreen)} />
      <AppStack.Screen name="NearMissReport" component={withScreenContainer(NearMissReportScreen)} />
      <AppStack.Screen name="GenerateReport" component={withScreenContainer(GenerateReportScreen)} />
      <AppStack.Screen name="KPIAnalysis" component={withScreenContainer(KPIAnalysisScreen)} />
      <AppStack.Screen name="ManDaysTracker" component={withScreenContainer(ManDaysTrackerScreen)} />
      <AppStack.Screen name="PokaYokeRecord" component={withScreenContainer(PokaYokeRecordScreen)} />
      <AppStack.Screen name="PlanVsActualRecords" component={withScreenContainer(PlanVsActualRecordScreen)} />
      <AppStack.Screen name="ReworkDataRecord" component={withScreenContainer(ReworkDataRecordScreen)} />
      <AppStack.Screen name="KaizenTracker" component={withScreenContainer(KaizenTrackerScreen)} />
      <AppStack.Screen name="ManageManpower" component={withScreenContainer(ManageManpowerScreen)} />
      <AppStack.Screen name="AttendanceSheet" component={withScreenContainer(AttendanceSheetScreen)} />
      <AppStack.Screen name="PCSPerHour" component={withScreenContainer(PCSPerHourScreen)} />
      <AppStack.Screen name="QualityAnalysis" component={withScreenContainer(QualityAnalysisScreen)} />
      <AppStack.Screen name="AIAssistant" component={withScreenContainer(AIAssistantScreen)} />
    </AppStack.Navigator>
  );
}

// ─── Root — swaps the whole navigator tree based on auth state ────────────
// This is what LoginScreen.tsx's handleLogin already relies on: it just
// calls login() and stops — no navigation.replace(). Once useAuthStore's
// `user` becomes non-null, THIS is what reacts to that and swaps AuthStack
// out for AppStack. Login isn't merely replaced within one shared stack, it
// unmounts entirely, which is what actually makes going back to it
// impossible — there's nothing left to go back to. The same logic covers
// sign-out symmetrically: once `user` goes back to null (wherever logout()
// is called), this swaps back to AuthNavigator on its own.
function RootNavigator() {
  const user = useAuthStore((s) => s.user);
  return user ? <AppNavigator /> : <AuthNavigator />;
}

// Explicit linking config — the original App.tsx had none, which is the
// main reason browser Back/Forward and Refresh didn't reliably track the
// current route on web: without it, React Navigation falls back to
// generating web paths automatically, which is less predictable and wasn't
// verified against every actual route name. Every existing route name is
// mapped to a path here (flat, not nested under Auth/App) since
// RootNavigator only ever mounts ONE of the two stacks at a time — from
// React Navigation's/the browser's perspective there's a single active
// screen tree either way, so a flat map is both correct and simpler than
// mirroring the Auth/App split into the linking config itself.
const linking: LinkingOptions<RootStackParamList> = {
  prefixes: ['prodpulse://'],
  config: {
    screens: {
      AdminLogin: 'login',
      Home: '',
      RegisterLine: 'register-line',
      ManageLines: 'manage-lines',
      RegisterIncharge: 'register-incharge',
      ManageIncharge: 'manage-incharge',
      EditIncharge: 'edit-incharge/:uid',
      RecordProduction: 'record-production',
      RecordRejection: 'record-rejection',
      MaterialOrder: 'material-order',
      KPIReport: 'kpi-report',
      NearMissReport: 'near-miss-report',
      ComingSoonReport: 'coming-soon-report',
      GenerateReport: 'generate-report',
      KPIAnalysis: 'kpi-analysis',
      ManDaysTracker: 'man-days-tracker',
      PokaYokeRecord: 'poka-yoke-record',
      PlanVsActualRecords: 'plan-vs-actual-records',
      ReworkDataRecord: 'rework-data-record',
      KaizenTracker: 'kaizen-tracker',
      ManageManpower: 'manage-manpower',
      AttendanceSheet: 'attendance-sheet',
      PCSPerHour: 'pcs-per-hour',
      QualityAnalysis: 'quality-analysis',
      AIAssistant: 'ai-assistant',
    },
  },
};

export default function App() {
  return (
    <SafeAreaProvider>
      <NavigationContainer linking={linking}>
        <StatusBar style="light" backgroundColor="#14181C" />
        <RootNavigator />
      </NavigationContainer>
    </SafeAreaProvider>
  );
}