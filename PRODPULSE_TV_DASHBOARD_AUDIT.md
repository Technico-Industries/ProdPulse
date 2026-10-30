# ProdPulse — TV Dashboard Architecture Audit

| | |
|---|---|
| **Audit date** | 2026-10-30 |
| **Repository** | `technico-management` (branch `main`, HEAD `5c458d0`, with uncommitted working-tree changes listed in §11) |
| **Scope** | Read-only inspection of the ProdPulse Expo / React Native + Firebase app, to prepare a separate **ProdPulse TV Dashboard** (React + Vite + JS) |
| **Method** | Source reading, plus running the project's own pure test scripts (no Firebase access, no file writes) |
| **Changes made** | None. This file is the only file created. |

Secrets policy: API keys, app IDs, sender IDs, credentials, `.secret.local` and environment-variable *values* were not read into this document. Firestore data was not queried; every schema below comes from the code that **writes** each document.

---

## Contents

1. [Existing project architecture](#1-existing-project-architecture)
2. [Firestore collections and field mapping](#2-firestore-collections-and-field-mapping)
3. [Production calculation reference](#3-production-calculation-reference)
4. [Shift and downtime business rules](#4-shift-and-downtime-business-rules)
5. [Admin Overview and Generate Report data flow](#5-admin-overview-and-generate-report-data-flow)
6. [Cloud Functions inventory](#6-cloud-functions-inventory)
7. [Security findings](#7-security-findings)
8. [Recommended TV dashboard architecture](#8-recommended-tv-dashboard-architecture)
9. [Proposed dashboard analytics schema (new, separate)](#9-proposed-dashboard-analytics-schema-new--separate-from-existing-schema)
10. [Reusable files and functions](#10-reusable-files-and-functions)
11. [Missing information and implementation risks](#11-missing-information-and-implementation-risks)

---

## 1. Existing project architecture

### 1.1 Stack

| Item | Value | Evidence |
|---|---|---|
| Framework | Expo SDK ~57, React Native 0.86.3, React 19.2.3, react-native-web | `package.json` |
| Firebase SDK | `firebase` ^12.16.0 (modular API) | `package.json` |
| State | `zustand` (auth + Prod AI stores) | `src/stores/` |
| Navigation | `@react-navigation/native-stack` with explicit web linking | `App.tsx` |
| Charts (app) | `react-native-gifted-charts` | `package.json` |
| Web hosting | Vercel, `expo export --platform web` → `dist/` | `vercel.json` |
| Backend | Firebase Cloud Functions v2, Node 22, esbuild bundle | `firebase.json`, `functions/` |
| Tests | Plain `tsx` scripts under `scripts/test*.ts` (pure logic, no Firebase) | `package.json` scripts |

### 1.2 Entry points

| File | Purpose |
|---|---|
| `index.ts` | `registerRootComponent(App)` |
| `App.tsx` | Root. Shows `AuthSplash` while auth initialises, then mounts `AuthNavigator` (login only) or `AppNavigator` (every screen). Holds the web URL map (`linking`). |
| `src/screens/DashboardScreen.tsx` | The `Home` route. Routes by role: admin → `AdminDashboardPager`; `assign` Technician / Restocker / Quality Control → their dashboards; plain supervisor → `SupervisorDashboardPager`. |
| `src/components/AdminDashboardPager.tsx` | Swipe pager. Admin pages: **Production** (`AdminOverviewScreen`) → **Quality** (`QualityOverviewScreen`) → **Lines** (`LineEfficiencyOverviewScreen`) → **QC Lines** (`LiveQualityLinesScreen`). Supervisor pages: **My Lines** (`SupervisorOverviewScreen`) → **Running Lines** (`RunningLinesScreen`). |
| `functions/src/index.ts` | Cloud Functions entry. Exports one function, `prodPulseAI`. |

### 1.3 Firebase initialisation and configuration

`src/services/firebase.ts`:

```ts
const firebaseConfig = {
  apiKey: /* redacted */,
  authDomain: "technico-industries-ltd.firebaseapp.com",
  projectId: "technico-industries-ltd",
  storageBucket: "technico-industries-ltd.firebasestorage.app",
  messagingSenderId: /* redacted */,
  appId: /* redacted */,
  measurementId: /* redacted */
};
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
auth = initializeAuth(app, { persistence: getReactNativePersistence(AsyncStorage) });
const db = getFirestore(app);
const functions = getFunctions(app);
export { app, auth, db, functions, firebaseConfig };
```

- **Firebase project ID: `technico-industries-ltd`** (also the default in `.firebaserc`).
- One web-app config is used by Android, iOS and web.
- The Functions emulator is used only when `EXPO_PUBLIC_USE_FUNCTIONS_EMULATOR=1` in dev.
- `src/services/firebaseAdmin.ts` creates a **secondary** Firebase app (`'Secondary'`) so an admin can create supervisor accounts without being signed out (client SDK, not the Admin SDK).

### 1.4 Authentication

| File | Responsibility |
|---|---|
| `src/stores/authStore.ts` | Email/password sign-in. `resolveProfile(uid)` reads `users/{uid}`. Role is `'admin'` only if `role === 'admin'`; anything else is `'supervisor'`. **A missing profile doc means an active supervisor** (backward compatibility). `active === false` signs the user out. |
| `src/services/firebaseAdmin.ts` | `createSupervisorAccount()` writes `users/{uid}` with `role: 'supervisor'`. `sendSupervisorPasswordReset()`. |
| `src/screens/LoginScreen.tsx` | Login UI. |
| `src/screens/RegisterInchargeScreen.tsx`, `ManageInchargeScreen.tsx`, `EditInchargeScreen.tsx` | Admin user management (`users` collection). |

The roles are `role` (`admin` or `supervisor`) and `assign` (`Supervisor`, `Technician`, `Restocker`, `Quality Control`; see `src/constants/lineOptions.ts` `ASSIGN_ROLES`).

### 1.5 Functional areas → files

| Area | Files | Notes |
|---|---|---|
| **Production recording** | `src/screens/RecordProductionScreen.tsx` (5,070 lines) | Start Production, slot cards, Save Slot, changeovers, stops/resume, rejections counter, loss reasons, Finalize & End. Writes `activeSessions`, `productionRecords`, `shiftSummaries`, `lineBreakdowns`, and `endedSessions.recoveredDrafts`. |
| Production session sync and drafts | `src/utils/productionDraft.ts` | Record IDs (`productionRecordId`), three-way merge for multi-device sync, local drafts, restore. |
| Slot schedule | `src/utils/productionSchedule.ts` | **Single source of truth** for shifts, breaks, slots, productive minutes, changeover splitting and the cycle-time target. |
| Production day | `src/utils/productionDay.ts` | 06:30 cutover, `productionDate` pinning, legacy record selection. |
| Slot recovery | `src/utils/slotRecovery.ts` | Delete/restore hourly cards (`deletedSlotBackups`). |
| Slot save button | `src/utils/slotSaveButton.ts` *(untracked new file)* | Save/Update button state. |
| Finalize guard | `src/utils/finalizeGuard.ts` | Prevents a double finalize. |
| **Line registration and management** | `src/screens/RegisterLineScreen.tsx`, `src/screens/ManageLinesScreen.tsx`, `src/constants/lineOptions.ts` | `productionLines` collection; parts and cycle times live inside the line doc. |
| **Model and cycle time** | `productionLines/{id}.parts[]` (`{ name, cycleTimeSeconds }`) | No separate model collection (§2.3). |
| **Shift management** | `src/utils/productionSchedule.ts` (constants) | Shifts are code constants, not Firestore data (§2.9). |
| **Session management** | `RecordProductionScreen.tsx`, `src/utils/supervisorHandover.ts` *(untracked)*, `src/screens/RunningLinesScreen.tsx` *(untracked)*, `src/utils/endProduction.ts`, `src/services/endProductionSession.ts` | `activeSessions/{lineId}`; admin End Production archives to `endedSessions`. |
| **Rejection recording** | Slot counter → `productionRecords.rejections` (used by every KPI). Separate QC log → `src/screens/RecordRejectionScreen.tsx` → `rejectionRecords`. | See §2.6. |
| Rejection helpers | `src/utils/rejectionCount.ts`, `src/utils/rejectionDate.ts`, `src/constants/rejectionTypes.ts` | |
| **Downtime tracking** | `src/utils/downtime.ts`, `src/services/downtimeSources.ts`, stop/resume code in `RecordProductionScreen.tsx` | Stops live in `activeSessions.stopsBySlot`, are archived to `shiftSummaries.downtimeIntervals` or `endedSessions`, and are shared out into `productionRecords.stopEvents`. |
| Maintenance breakdowns | `RecordProductionScreen.tsx` (writes), `DashboardScreen.tsx` (Technician view) | `lineBreakdowns`. |
| **Admin Overview** | `src/screens/AdminOverviewScreen.tsx` | One day, KPI tiles, chart-free. |
| **Line Efficiency (live)** | `src/screens/LineEfficiencyOverviewScreen.tsx`, `src/utils/lineEfficiency.ts` | **Realtime** per-line status and efficiency. Closest existing analogue to the TV dashboard. |
| **Live Quality** | `src/screens/LiveQualityLinesScreen.tsx`, `src/utils/liveQuality.ts`, `src/utils/qualityMetrics.ts` | Realtime per-line quality %. |
| Quality Overview | `src/screens/QualityOverviewScreen.tsx` | Reads `rejectionRecords` (the QC log). |
| Supervisor overview | `src/screens/SupervisorOverviewScreen.tsx` | Realtime own sessions. |
| **Generate Report** | `src/screens/GenerateReportScreen.tsx`, `src/utils/reportExcelExport.ts` | Date range, filters, charts, Excel export. |
| KPI Analysis | `src/screens/KPIAnalysisScreen.tsx`, `src/utils/kpiExcelExport.ts` | Ten KPI collections plus production. |
| Model / Part Production | `src/screens/ModelPartProductionScreen.tsx`, `src/utils/modelPartProduction.ts`, `src/services/modelPartProductionQueries.ts` | De-duplicated per-part totals. |
| Prod AI | `src/screens/AIAssistantScreen.tsx`, `src/services/prodPulseAI.ts`, `src/utils/prodPulseAI.ts`, `functions/src/*` | Admin-only Gemini assistant (callable function). |
| Shared queries | `src/services/productionRecordQueries.ts` | `fetchProductionRecordsForDateRange()`, the canonical range read. |

---

## 2. Firestore collections and field mapping

### 2.0 Collection inventory (from code references)

| Collection | Doc ID | Written by | Relevant to TV |
|---|---|---|---|
| `productionLines` | auto ID | `RegisterLineScreen` | **Yes** (master list, parts, cycle times) |
| `activeSessions` | **= lineId** | `RecordProductionScreen` | **Yes** (live status, stops, plan) |
| `productionRecords` | deterministic `pr\|date\|line\|shift\|slot\|segment` (legacy: auto ID) | `RecordProductionScreen` | **Yes** (actual, target, rejections) |
| `shiftSummaries` | `${lineId}_${productionDate}_${shift}` | `RecordProductionScreen` Finalize | **Yes** (finished-session downtime) |
| `endedSessions` | `es\|lineId\|sessionInstance` | `utils/endProduction` (admin End Production) | **Yes** (admin-ended session downtime) |
| `lineBreakdowns` | auto ID (one per maintenance stop) | `RecordProductionScreen` | Optional (maintenance alerts) |
| `rejectionRecords` | auto ID | `RecordRejectionScreen` | Optional (defect Pareto; **not** in KPI rejection totals) |
| `users` | = Auth uid | `firebaseAdmin.ts`, `EditInchargeScreen` | No (never public) |
| `operators` | auto ID | `ManageManpowerScreen` | No |
| `materialOrders` | auto ID | `MaterialOrderScreen`, `DashboardScreen` | No |
| `attendanceRecords`, `manDaysRecords`, `nearMissReports`, `pokaYokeRecords`, `planVsActualRecords`, `reworkRecords`, `kaizenRecords`, `pcsManHourRecords` | auto ID | their own screens | No (KPI Analysis only) |

There are **no** separate collections for production slots, models, cycle times, shifts, production sessions (other than `activeSessions` and `endedSessions`), downtime events or rejections-per-slot. §2.9 shows where that data lives.

### 2.1 `productionLines`: line master and model and cycle-time configuration

**Writer:** `src/screens/RegisterLineScreen.tsx` `handleSubmit()` (`addDoc` on create, `updateDoc` on edit). **Deleter:** `ManageLinesScreen.tsx` (`deleteDoc`).

| Field | Type | Notes |
|---|---|---|
| `plant` | string | One of `PLANTS` = `'Bawal 1' \| 'Bawal 2'` |
| `workshop` | string | One of `WORKSHOPS` = `'Assembly Shop' \| 'Welding Shop' \| 'Plating Shop' \| 'Press Shop'` |
| `division` | string | One of `DIVISIONS` (`'Side Door'`, `'S. Jack'`, `'RR Center'`, `'Break Pedal'`, `'Hood Hinge'`, `'Back Door'`, `'Non-MSIL'`, `'Count Cable'`). Division only applies under Assembly (`isAssemblyWorkshop`, a substring match on `"assembly"`). |
| `lineName` | string | |
| `parts` | array of `{ name: string, cycleTimeSeconds: number }` | **The model list.** Validated so that cycle time > 0. |
| `createdBy` / `updatedBy` | string (uid) or null | |
| `createdAt` / `updatedAt` | Timestamp (server) | |

Readers accept legacy aliases (`RecordProductionScreen.tsx` ~line 1535): `parts \| models \| partsList`, `cycleTimeSeconds \| cycleTime \| cycle`, `lineName \| lineNumber \| name`, `plant \| location`, `workshop \| shop`, `division \| unit`.

```json
// productionLines/aB3xK9...
{
  "plant": "Bawal 1",
  "workshop": "Assembly Shop",
  "division": "Side Door",
  "lineName": "SD-Line 3",
  "parts": [
    { "name": "Hinge RH", "cycleTimeSeconds": 42 },
    { "name": "Hinge LH", "cycleTimeSeconds": 45 }
  ],
  "createdBy": "<adminUid>",
  "createdAt": "<Timestamp>"
}
```

### 2.2 `activeSessions`: the live production session (one per line)

**Doc ID = `lineId`.** Exactly one live session per line. **Writers:** `RecordProductionScreen.tsx` `beginSession()` (create, ~line 2530), `writeSessionNow()` (sync, transactional with `revision`), stop/resume. **Deleted** at Finalize (transaction, `revision` check) or archived and deleted by admin End Production.

Interface: `ActiveSessionDoc` in `RecordProductionScreen.tsx` (~line 190). Sync payload: `sessionPayload()` (~line 2005).

| Field | Type | Notes |
|---|---|---|
| `lineId`, `lineName`, `plant`, `workshop`, `division` | string or null | Copied from the line |
| `shift` | `'A' \| 'B'` | |
| `otHours` | number | Overtime hours; extends the shift window |
| `productionDate` | string `YYYY-MM-DD` | **Pinned once at start, never rewritten by sync** (§4.1) |
| `productionStartMinutesAbs` | number | Actual start, in the shift's absolute-minute frame |
| `productionStartedAt` | Timestamp | That instant |
| `startedAt` / `updatedAt` | Timestamp (server) | |
| `sessionInstanceId` | string | Identifies one run of a line's session; legacy fallback `startedAt:<ms>` |
| `revision` | number | Incremented on every sync (optimistic concurrency) |
| `selectedPartIndex` | number | Starting part (index into `productionLines.parts`) |
| `supervisorName`, `supervisorCode`, `supervisorUid` | string or null | **The session starter.** Never rewritten by sync. |
| `updatedBy` | `{ uid, deviceId, name }` | Who made the last synced change |
| `contributorUids` | string[] | `arrayUnion` of every supervisor who synced |
| `operators` | `[{ id, name, code }]` | Operator roster (personal data) |
| `producedBySlot` | `{ [slotIndex]: number \| null }` | Entered good output per slot (not yet saved) |
| `producedSegment` | `{ "idx:before" \| "idx:after": number \| null }` | Changeover halves |
| `rejectionsBySlot` | `{ [slotKey]: number }` | Counter values |
| `stopsBySlot` | `{ [slotIndex]: StopEvent[] }` | **The authoritative live downtime** (see below) |
| `changeovers` | `{ [slotIndex]: ChangeoverInfo \| null }` | |
| `lossReasonBySlot` | `{ [slotKey]: { code, label, note } }` | |
| `deletedSlotIndices` / `savedSlotIndices` | number[] | `savedSlotIndices` = record write **and** sync succeeded |
| `deletedSlotBackups` | object | Restore data |
| `lineStopped` | boolean | `true` if any stop is `running` |
| `plannedProductionTotal` | number | Whole-shift plan (§3.4, see caveat) |
| `totalDowntimeMinutes` | number | **Integer, computed at sync time, not stop-ID de-duplicated, stale while stopped. Do not use for display.** |
| `totalRejections` | number | Σ `rejectionsBySlot` (includes unsaved slots) |
| `stopsSummaryBySlot` | `{ [slot]: { totalDowntimeMinutes, stopCount } }` | Same caveat |
| `syncConflicts`, `clientUpdatedAtMs` | | Sync metadata |

`StopEvent` (`RecordProductionScreen.tsx` ~line 172 and `utils/downtime.ts` `DowntimeStop`). Note that **`startAbs` and `endAbs` are epoch milliseconds, despite the name:**

```json
{ "id": "stop-1761800400000", "reason": "material shortage",
  "startAbs": 1761800400000, "endAbs": 1761801300000,
  "durationMinutes": 15, "running": false,
  "breakdownDocId": "<lineBreakdowns id, maintenance only>" }
```

Stop reasons (`STOP_REASONS`, `RecordProductionScreen.tsx` ~line 383): `maintenance`, `changeover`, `quality`, `material shortage`, `no operator`, `storage issue`, `training`, `5s`, `meeting`, `pokayoke checktime`, `gauge/fixture maintenance`, `no production plan`, `power cut`, `machine pm`.

`ChangeoverInfo` (~line 152): `{ slotIndex, atAbs, startAbs?, endAbs?, durationMinutes?, oldPartIndex, newPartIndex, beforeMinutes, afterMinutes, expectedBefore, expectedAfter }`. Times are **shift absolute minutes** (not epoch).

### 2.3 `productionRecords`: one doc per saved slot or changeover segment

**Writers:** `RecordProductionScreen.tsx` Save Slot (~line 3800) and `submitUnsavedSlots()` at Finalize (~line 2790), both through `upsertProductionRecord()` (~line 340).

**Doc ID:** `productionRecordId()` in `src/utils/productionDraft.ts`:

```ts
['pr', productionDate, lineId, shift, String(slotIndex), segment]  // segment: 'full' | 'before' | 'after'
  .map(encodeURIComponent).join('|')
// e.g. "pr|2026-10-29|aB3xK9|B|6|full"
```

Older records were created with `addDoc` and have **random IDs**. `resolveProductionRecordRef()` updates the legacy doc rather than create a duplicate, but historical duplicates can exist (§11).

| Field | Type | Notes |
|---|---|---|
| `productionDate` | string `YYYY-MM-DD` | **The session's pinned date.** Missing on very old records → derived (§4.1). |
| `shift` | `'A' \| 'B'` | |
| `lineId`, `lineName`, `plant`, `workshop`, `division` | string or null | Location fields can be wrong on old records. Readers **re-resolve from `productionLines` by `lineId`.** |
| `partName` | string | Part in effect for this slot or segment |
| `cycleTimeSeconds` | number | Snapshot at save time |
| `slotIndex` | number | **Full-shift index** (stable when start time is clipped) |
| `slotLabel` | string | e.g. `"07:00 PM - 08:00 PM"` |
| `slotStartMinutesAbs`, `slotEndMinutesAbs`, `hourStartMinutesAbs` | number | Absolute shift minutes (Shift B after midnight = +1440) |
| `slotDurationMinutes` | number | Wall-clock window |
| `productiveMinutes` | number | Scheduled productive minutes **minus downtime inside the window** |
| `expectedParts` | number | **Slot target** = `floor(scheduledProductiveMinutes × 60 / cycleTime)`, **not** reduced by downtime |
| `producedThisSlot` | number | **Good output** (rejections are *not* subtracted) |
| `lossParts` | number | `max(0, expected − produced)` |
| `lossTimeMinutes` | number | `lossParts × cycleTime / 60` |
| `lossReasonCode`, `lossReasonLabel`, `lossReasonNote` | string or null | |
| `rejections` | number | Slot rejection counter. **Missing on legacy records.** |
| `stopEvents` | `RecordStopEvent[]` | `{ stopId, reason, startAbs(ms), endAbs(ms)\|null, durationMinutes (share inside this window), intervalDurationMinutes }` |
| `partSegment` | `'before' \| 'after'` | Only on changeover halves (absent = full) |
| `changeoverInfo` | `ChangeoverInfo` | Only on changeover halves |
| `operators` | `[{ name, code }]` | Personal data |
| `supervisor` | `{ name, code, uid }` | **The person who saved it** (handover-aware) |
| `sessionSupervisor` | `{ name, code, uid }` | Session starter |
| `createdBy` | `{ name, uid }` | First creator (create-only) |
| `createdAt` | Timestamp | Create-only |
| `updatedAt` | Timestamp | Every save |

```json
// productionRecords/pr|2026-10-29|aB3xK9|B|6|full
{
  "productionDate": "2026-10-29", "shift": "B",
  "lineId": "aB3xK9", "lineName": "SD-Line 3",
  "plant": "Bawal 1", "workshop": "Assembly Shop", "division": "Side Door",
  "partName": "Hinge RH", "cycleTimeSeconds": 42,
  "slotIndex": 6, "slotLabel": "01:00 AM - 02:00 AM",
  "slotStartMinutesAbs": 1500, "slotEndMinutesAbs": 1560, "hourStartMinutesAbs": 1500,
  "slotDurationMinutes": 60, "productiveMinutes": 48.5,
  "expectedParts": 85, "producedThisSlot": 70,
  "lossParts": 15, "lossTimeMinutes": 10.5,
  "lossReasonCode": "material", "lossReasonLabel": "Material shortage", "lossReasonNote": null,
  "rejections": 2,
  "stopEvents": [{ "stopId": "stop-1761766200000", "reason": "material shortage",
                   "startAbs": 1761766200000, "endAbs": 1761766890000,
                   "durationMinutes": 11.5, "intervalDurationMinutes": 11.5 }],
  "operators": [{ "name": "<name>", "code": "<code>" }],
  "supervisor": { "name": "<name>", "code": "<code>", "uid": "<uid>" },
  "sessionSupervisor": { "name": "<name>", "code": "<code>", "uid": "<uid>" },
  "createdBy": { "name": "<name>", "uid": "<uid>" },
  "createdAt": "<Timestamp>", "updatedAt": "<Timestamp>"
}
```

When a changeover is added to or removed from an already-saved slot, `removeSupersededProductionRecords()` **deletes** the superseded shape (`full` ↔ `before` + `after`).

### 2.4 `shiftSummaries`: written once at Finalize & End

**Writer:** `saveShiftSummary()` in `RecordProductionScreen.tsx` (~line 2722), `setDoc(..., { merge: true })`.
**Doc ID:** `` `${lineId}_${productionDate}_${shift}` ``. A second session of the same line, date and shift **overwrites** it (handled by downtime record fallback, §4.2).

| Field | Type | Notes |
|---|---|---|
| `lineId`, `lineName`, `plant`, `workshop`, `division`, `shift`, `productionDate` | | |
| `plannedProductionTotal` | number | **Σ expected of slots with entered data** (`computeShiftTotals`). This is different from `activeSessions.plannedProductionTotal`, despite the same name (§3.4). |
| `actualProductionTotal` | number | Σ produced of those slots |
| `partPlannedTotals` | `{ [partName]: number }` | Shift plan redistributed by part (`partTargetSummary`) |
| `downtimeIntervals` | `[{ stopId, slotIndex, reason, startAbs(ms), endAbs(ms)\|null, durationMinutes }]` | **Every stop of the session, whole** |
| `totalDowntimeMinutes` | number | Σ above (2 dp) |
| `supervisor`, `sessionSupervisor` | `{ name, code, uid }` | |
| `finalizedAt` | Timestamp | |

### 2.5 `endedSessions`: admin "End Production" archive

**Writer:** `endProductionSession()` in `src/utils/endProduction.ts` through `src/services/endProductionSession.ts` (transaction). **Doc ID:** `endedSessionId(lineId, instance)` = `es|<lineId>|<sessionInstance>` (URI-encoded parts).
**Contents:** a full copy of the `activeSessions` doc, plus `sessionInstance`, `sessionStatus: 'ended'`, `endReason: 'admin_end'`, `archivedFrom`, `endedAt`, `endedAtClientMs`, `endedBy { uid, name, email, role: 'admin' }`, and optionally `recoveredDrafts.{deviceId}`.
Ending **does not** write `productionRecords` or `shiftSummaries`. Unsaved slots stay only in the archive.

### 2.6 `rejectionRecords`: QC rejection log (separate from the slot counter)

**Writer:** `RecordRejectionScreen.tsx` (one `writeBatch`, one doc per defect type with qty > 0).

| Field | Type |
|---|---|
| `date` | string `YYYY-MM-DD`, **local calendar date** (not production day, `utils/rejectionDate.ts`) |
| `shift`, `plant`, `workshop`, `division`, `lineId`, `lineName`, `partName` | |
| `stage` | string (category from `constants/rejectionTypes.ts`) |
| `defect` | string (type name) |
| `rejectionQty` | number |
| `remarks` | string or null |
| `reportedBy` | `{ uid, name }` |
| `createdAt` | Timestamp |

**Business rule** (`src/utils/qualityMetrics.ts` header): production KPIs use **only** `productionRecords.rejections`. `rejectionRecords` are **never added** to them because they may log the same parts. `rejectionRecords` feeds Quality Overview, Quality Analysis and the AI's "rejection log".

### 2.7 `lineBreakdowns`: one doc per maintenance stop

**Writer:** `RecordProductionScreen.tsx` stop handler (~line 3294). The ID is generated up front and stored on the stop as `breakdownDocId`.
Fields: `lineId`, `lineName`, `plant`, `workshop`, `division`, `slotLabel`, `active` (bool), `reportedBy { uid, name }`, `startedAt`, `resolvedAt`, `fixedBy`, and on resume `resolvedBy { uid, name }`.
Read live by the Technician dashboard (`DashboardScreen.tsx`, `where('active','==',true)`).

### 2.8 `users`

`users/{uid}`: `name`, `employeeCode`, `email`, `plant`, `assign`, `role` (`'admin' | 'supervisor'`), `active` (bool), `createdBy`, `createdAt`. **Must never be exposed to a public dashboard.**

### 2.9 Requested entities with no dedicated collection

| Requested entity | Where it actually lives |
|---|---|
| Production slots | Computed by `buildSlots()` (`productionSchedule.ts`). Persisted only as `productionRecords` (saved slots) and in the `activeSessions` per-slot maps (`producedBySlot`, `savedSlotIndices`, …). |
| Model configuration | `productionLines.parts[].name` |
| Cycle-time configuration | `productionLines.parts[].cycleTimeSeconds`, snapshotted onto each record as `cycleTimeSeconds` |
| Shift configuration | **Hard-coded constants** in `productionSchedule.ts` (§3.6). Not in Firestore. |
| Production sessions | `activeSessions/{lineId}` (live), `endedSessions` (admin-ended), `shiftSummaries` (finalized result) |
| Downtime events | `activeSessions.stopsBySlot` (live), `shiftSummaries.downtimeIntervals`, `endedSessions.stopsBySlot`, shares in `productionRecords.stopEvents`. Maintenance stops also appear in `lineBreakdowns`. |
| Rejections | `productionRecords.rejections` (KPI source) and `rejectionRecords` (QC log) |
| Supervisor/operator attribution | `activeSessions.supervisorUid/Name/Code` (starter), `updatedBy`, `contributorUids`; `productionRecords.supervisor` (saver), `sessionSupervisor` (starter), `createdBy` (first creator), `operators[]` |

### 2.10 Relationships

```
productionLines/{lineId}
   │ (doc id)
   ├── activeSessions/{lineId}                   1 : 0..1   live session
   │      └─ sessionInstanceId ─┐
   ├── endedSessions/es|lineId|instance          1 : N      admin-ended archives
   ├── shiftSummaries/{lineId}_{date}_{shift}    1 : N      one per line/date/shift
   ├── productionRecords (lineId, productionDate, shift, slotIndex, partSegment)
   │                                             1 : N      one per saved slot/segment
   ├── lineBreakdowns (lineId)                   1 : N
   └── rejectionRecords (lineId)                 1 : N
users/{uid} ◄── supervisorUid / supervisor.uid / sessionSupervisor.uid / contributorUids
```

The logical session key used everywhere is **`lineId + productionDate + shift`** (`downtimeSessionKey()`, `recordsForSession()`, record IDs, summary IDs). There are no Firestore `DocumentReference` fields; every relation is by string ID.

---

## 3. Production calculation reference

Every formula below is quoted from the code. **The TV must not change any of them.**

### 3.1 Total and good production

| | |
|---|---|
| **Rule** | `producedThisSlot` **is** the good output. Nothing subtracts rejections from it. |
| **Formula** | `Σ producedThisSlot` |
| **Functions** | `efficiencyOf(records).actual` in `src/utils/lineEfficiency.ts`; `counterQuality(records).goodParts` in `src/utils/qualityMetrics.ts` |
| **Inline duplicates** | `AdminOverviewScreen.tsx` `metrics` useMemo; `GenerateReportScreen.tsx` `summary`; `KPIAnalysisScreen.tsx`; `SupervisorOverviewScreen.tsx` |

### 3.2 Rejected production and quality

`computeQuality(goodParts, rejectedParts)` and `counterQuality(records)` in `src/utils/qualityMetrics.ts`:

```
goodParts      = Σ producedThisSlot          (records that carry `rejections` only)
rejectedParts  = Σ rejections
inspectedParts = goodParts + rejectedParts
rejectionPct   = round1(rejected / inspected × 100)
qualityPct     = round1(100 − rejectionPct)
```

- Legacy records without a numeric `rejections` are **excluded from all four** and counted in `legacyRecords`. Records that are *all* legacy give `null` ("—"), never 100%.
- Inspected = 0 gives a `null` percentage.
- Thresholds (`src/utils/liveQuality.ts` `QUALITY_THRESHOLDS`): good ≥ 98, warning ≥ 95, otherwise critical.

### 3.3 Slot target (cycle-time hourly target)

```ts
// src/utils/productionSchedule.ts
export function expectedPartsFor(cycleTimeSeconds: number, minutes: number) {
  if (!cycleTimeSeconds || minutes <= 0) return 0;
  return Math.floor((minutes * 60) / cycleTimeSeconds);
}
```

- **Inputs:** the part's `cycleTimeSeconds` and the slot's **scheduled** `productiveMinutes` from `buildSlots()`.
- **Rule** (`RecordProductionScreen.tsx` `frozenExpected` / `expectedParts` comments): the target uses the slot's **full scheduled productive time and is never reduced by downtime.** Only actual output reflects stops.
- Changeover slots: `before` gets `expectedPartsFor(oldCycle, co.beforeMinutes)`, `after` gets `expectedPartsFor(newCycle, co.afterMinutes)`. The minutes come from `changeoverSegmentMinutes()`.
- Stored per record as `expectedParts`.

### 3.4 Production target: three distinct "plan" figures

| Figure | Definition | Where |
|---|---|---|
| **Plan to date** (efficiency denominator) | `Σ expectedParts` of saved records | `efficiencyOf().planned`; Admin Overview `plannedTotal`; Generate Report `totalExpected`; Running Lines `planToDate` |
| **Shift plan** (whole shift) | `activeSessions.plannedProductionTotal` = `plannedTotalFor(visibleSlots, line, selectedPartIndex)` = Σ `expectedPartsFor(startingPartCycle, slot.productiveMinutes)` over **all** non-deleted slots | `RecordProductionScreen.tsx` `plannedTotalFor()` (~line 751), `shiftPlannedTotal` (~line 1263); shown by `SupervisorOverviewScreen` and `RunningLinesScreen` (`shiftPlan`) |
| **Finalized plan** | `shiftSummaries.plannedProductionTotal` = Σ expected over slots with entered data, part-aware (`computeShiftTotals()`) | Written at Finalize |

**Caveat:** *shift plan* uses the **starting part's cycle time for every slot**, even after a changeover. Changeover minutes are deducted, but the new part's cycle time is not applied. Per-part shares of it are `partTargetSummary` / `shiftSummaries.partPlannedTotals` (largest-remainder redistribution). Reuse the figure as stored; do not recompute it differently.

### 3.5 Target achievement and efficiency

| Name | Formula | Function | Null handling |
|---|---|---|---|
| Efficiency (live lines) | `round1(Σproduced / Σexpected × 100)` | `efficiencyOf()`, `lineEfficiency.ts` | `planned = 0` gives **`null`** ("—") |
| Efficiency (Admin Overview) | same | inline `metrics` | `planned = 0` gives **`0`** |
| Efficiency (Generate Report) | `Math.round(×1000)/10` (same value) | inline `summary` | gives `0` |
| Achievement % (KPI Analysis) | `round1(actual / plan × 100)` | inline, `KPIAnalysisScreen.tsx` ~line 1896 | gives `0` |
| Variance (Running Lines) | `actual − planToDate` | `buildRunningLineCards()`, `supervisorHandover.ts` | |

Efficiency and achievement are **the same formula**. The code comment in Admin Overview: *"achievementPct = actual / plan * 100 (KPIAnalysisScreen totals — same figure)"*.

Colour bands differ by screen:
- `lineEfficiency.ts` `efficiencyBand`: > 90 excellent, ≥ 75 warning, ≥ 50 poor, else critical.
- Admin Overview / Generate Report: ≥ 85 green, ≥ 60 amber, else red.
- KPI Analysis achievement: ≥ 95, ≥ 85, ≥ 70.

### 3.6 Shift schedule, breaks and productive minutes

All constants are in `src/utils/productionSchedule.ts`. Times are **absolute minutes from midnight of the shift's start day.** Shift B after midnight is +1440. All intervals are half-open `[start, end)`.

| Constant | Value |
|---|---|
| `SHIFT_A_START` / `SHIFT_A_END` | 07:00 / 15:30 |
| `SHIFT_B_START` / `SHIFT_B_END_ABS` | 19:00 / 03:30 (+1440 = 1650) |
| Overtime | `shiftWindow()` adds `otHours × 60` to the end |
| Shift A `BREAKS` | 09:30–09:40, **lunch 12:15–12:45** (`LUNCH_BREAK`), 14:00–14:10 |
| Shift B breaks | dinner 21:45–22:15, tea 01:30–01:40; **without OT** rejection clearance 03:20–03:30; **with OT** OT tea 04:30–04:40 |
| `STARTUP_RESERVE_MINUTES` | 10 (first 10 minutes of the shift) |
| `FIXED_PRODUCTIVE_MINUTES_BY_HOUR` | 07–08, 09–10, 14–15 and 17–18 are **capped at 50** productive minutes |
| `PRODUCTION_DAY_CUTOVER_MINUTES` (`productionDay.ts`) | 06:30 |

`buildSlots(shift, otHours, changeoverIntervals, productionStartAbs)` returns `ScheduleSlot[]` (`index`, `hourStartAbs`, `startMinutesAbs`, `endMinutesAbs`, `durationMinutes`, `productiveMinutes`, `isBreak`, `startAdjusted`, `label`).
- One slot per clock hour. The lunch hour becomes an `isBreak` slot (12:15–12:45), and the neighbouring slots are bent around it (11:00–12:15, 12:45–14:00).
- `productiveMinutes = min(fixedCap, window − coveredMinutes(breaks ∪ startup ∪ changeovers))`, using `coveredMinutes()`, `productiveMinutesIn()` and `slotProductiveMinutes()`.
- A late `productionStartAbs` **drops** earlier slots and clips the slot it falls in, but **keeps the full-shift slot indices**.

### 3.7 Model changeovers

| Function | Purpose |
|---|---|
| `placeChangeoverTime(atAbs, slots, others)` | Single-time changeover entry. At a slot start it switches the whole slot (`atSlotStart`). |
| `validateChangeoverInterval()` | Not during lunch, inside production slots, no overlap |
| `changeoverSegmentWindows(slot, co)` | BEFORE `[slot.start, co.start)` and AFTER `[co.end, slot.end)` |
| `changeoverSegmentMinutes(slot, co, nonProductive)` | BEFORE and AFTER productive minutes. If a fixed cap applies, the excess is removed proportionally so that **BEFORE + AFTER = the slot's productiveMinutes** |
| `isChangeoverAtSlotStart()` | |

Changeover intervals are also non-productive time inside `buildSlots`.

### 3.8 Shift-wise, daily and weekly production

| Aggregation | Existing implementation |
|---|---|
| Per session (line + date + shift) | `recordsForSession()` → `dedupeSlotRecords()` → `efficiencyOf()` in `lineEfficiency.ts`; `buildRunningLineCards()`; `GenerateReportScreen` `byLine` (key `lineId__productionDate__shift`) |
| Daily | `fetchProductionRecordsForDateRange(d, d)` then Σ (Admin Overview) |
| Per-day trend | `GenerateReportScreen.tsx` `productionTrend`: group by `recordProductionDayKey(r)`, Σ `producedThisSlot` |
| **Weekly** | **Not implemented as a dedicated aggregation.** Generate Report's "Last 7 days" preset (`dateStrDaysAgo(6)` to `todayStr`, calendar dates) feeds the per-day trend line. Admin Overview has **no charts**. KPI Analysis has `byDate` charts for its other KPIs. |
| Per part | `modelPartProduction.ts` `summarize()`, `breakdownByPart()`, `partDetail()` |

### 3.9 Downtime duration and cumulative downtime

All in `src/utils/downtime.ts`:

| Function | Input | Output | Rule |
|---|---|---|---|
| `stopDurationMinutes(startMs, endMs)` | epoch ms | minutes (2 dp, ≥ 0) | `(end − start) / 60000` |
| `stopIdOf(stop)` | stop | `stop.id ?? 'stop-' + startAbs` | Stable interval ID used for de-duplication |
| `stopMinutesInWindow(stop, wStart, wEnd, now)` | | minutes | Overlap; a running stop counts up to `now` |
| `stopEventsForWindow()` | `stopsBySlot`, window, now | `RecordStopEvent[]` | **Time-overlap attribution** across slots |
| `sessionDowntimeMinutes(stopsBySlot, now)` | | minutes | Each stop ID once, in full; running → `now − startAbs` |
| `lineDowntimeSummary(stopsBySlot, now)` | | `{ totalMinutes, currentStopMinutes, currentStopStartMs, stopCount }` | Live per-line figure |
| **`collectDowntimeIntervals(input, now)`** | records + active + ended + summaries | `DowntimeInterval[]` | **The report rule** (§4.2) |
| `totalDowntimeMinutes(intervals)` | | minutes | Σ |
| `downtimeBySession(intervals)` | | `Map<sessionKey, min>` | |
| `downtimeByReason(intervals)` | | `[{ reason, minutes }]`, largest first | |
| `combinedDowntimeMinutes(records, active, now)` | | minutes | Older variant (no ended/summary sources) |
| `formatDowntimeMinutes(m)` | | `"4.2 min"` / `"1h 5m"` | Display policy |
| `formatElapsedSince(startMs, now)` | | `MM:SS` / `H:MM:SS` | Live timer |
| `sessionSourceFromDoc()`, `summarySourceFromDoc()`, `inProductionRange()` | Firestore docs | sources | |

Loading: `fetchDowntimeSourcesForDateRange(from, to, { skipActive })` in `src/services/downtimeSources.ts` reads `activeSessions` (whole, filtered client-side), `endedSessions` and `shiftSummaries` by `productionDate` range, using `Promise.allSettled` and reporting `failed`.

Loss time (distinct from downtime): `lossTimeMinutes = round2(lossParts × cycleTime / 60)` (`RecordProductionScreen.tsx` `lossTimeMinutes()`).

### 3.10 Line efficiency and live line status

`src/utils/lineEfficiency.ts`:
- `buildLineCards(lines, sessions, records)` returns one card per registered line, plus orphan sessions. Status is `running`, `stopped` or `not_running`. Sorted stopped → running → not running.
- `currentStop(session)` returns the latest running stop `{ reason, label, sinceMs }`. `stoppedBadge(reason)` gives Maintenance, Quality Hold or Stopped.
- `dedupeSlotRecords(records)` keeps one record per slot and segment (canonical ID, else the earliest legacy). When both `full` and `before`/`after` exist, it keeps the most recently updated shape.
- `productionFigures()`, `summarize()`, `filterLineCards()` (plant/workshop, case-insensitive), `formatStopReason()`.

Other figures:
- Operator hours and pieces per man-hour (Admin Overview, KPI Analysis): `Σ operatorCount × productiveMinutes / 60` and `actual / operatorHours`.
- OEE: **Not found.** No OEE / availability / performance calculation exists.

### 3.11 Shared or duplicated

| Logic | Shared function | Inline duplicates |
|---|---|---|
| Actual / target / efficiency | `efficiencyOf` | Admin Overview, Generate Report, KPI Analysis, Supervisor Overview (same formula, different null/0 handling) |
| Quality / rejection % | `computeQuality`, `counterQuality` | KPI Analysis (`rejections / (produced + rejections)` inline, ~lines 1824, 1852, 1897, 3595); Generate Report sums `rejections ?? 0` |
| Downtime (reports) | `collectDowntimeIntervals` | **KPI Analysis** sums `record.stopEvents` (old rule, ~line 1743); **AI `tools.ts`** sums `stopEvents` plus running sessions |
| Record de-duplication | `dedupeSlotRecords`, `dedupeProductionRecords` | **Not applied** by Admin Overview, Generate Report or KPI Analysis |
| Production day | `productionDayKeyFor`, `recordProductionDayKey` | Admin Overview, Generate Report and KPI Analysis each define their own **calendar** `todayStr()` / `dateStrDaysAgo()` |
| Plant/workshop match, Assembly rule | `filterLineCards` (`sameValue`) | `sameValue` / `isAssemblyWorkshop` re-declared in many screens |
| Location re-resolution from `productionLines` | `resolveLineFields` (`modelPartProduction.ts`) | Inline in Admin Overview and Generate Report |

---

## 4. Shift and downtime business rules

### 4.1 Shift B overnight: **Implemented**

| Requirement | Status | Evidence |
|---|---|---|
| Production after midnight belongs to the shift-start production date | ✅ Implemented | `productionDayKeyFor()` (06:30 cutover). `productionDate` is pinned in `beginSession()` and `writeSessionNow()`, and is explicitly excluded from `sessionPayload()` (*"an update must never overwrite it"*). Finalize uses `resolveActiveSessionProductionDate()` → `resolveSessionProductionDate()` (stored → pinned → `startedAt`, **never `Date.now()`**). |
| Slot IDs and indices stay consistent | ✅ Implemented | Absolute-minute frame (+1440). `buildSlots()` keeps full-shift indices when the start is clipped. `productionRecordId()` keys on the pinned date + `slotIndex` + segment, so Save Slot and Finalize after the cutover hit the same doc (test 21). |
| Historical production is not assigned to the wrong date | ✅ Implemented, with one exception | Every report reads by `productionDate` (`fetchProductionRecordsForDateRange`). Legacy records without it fall back to `createdAt` with the 06:30 rule for Shift B (`recordProductionDayKey`, `legacyCreatedAtWindow`). Downtime sources are also matched by `productionDate`. **Exception:** see the risk below. |

Verified by `npm run test:shift-b-overnight` (**22 passed**) and `test:production-day` (**10 passed**).

**Risk for the TV:** Admin Overview, Generate Report and KPI Analysis default "Today" to the **calendar** date (`todayStr()`), not the production day. At 01:00 during Shift B, Admin Overview's "Today" is the *next* calendar date, so the running Shift B session (dated the previous day) is not on it. The TV must use `productionDayKeyFor(Date.now())`.

Also, `productionDayKeyFor` uses **device local time**. The backend pins `Asia/Kolkata` (`functions/src/timezone.ts`). A TV browser in another timezone would compute the wrong day if it computes the day client-side.

### 4.2 Downtime: **Implemented**

| Requirement | Status | Evidence |
|---|---|---|
| Multiple stop-start intervals accumulate | ✅ | Each stop is a separate `StopEvent` with stable `id = stop-<startAbs>` appended to `stopsBySlot[slot]`. `sessionDowntimeMinutes()` and `collectDowntimeIntervals()` sum every unique ID. |
| Restart does not reset earlier downtime | ✅ | `completeRunningStops()` closes only `running` stops and returns closed ones unchanged (idempotent). History stays in `stopsBySlot`. `freezeRunningStops()` at Finalize. |
| Active downtime from start timestamp | ✅ | `startAbs` (epoch ms) is persisted the moment Stop is pressed. Elapsed time is always `now − startAbs` (`stopMinutesInWindow`, `lineDowntimeSummary.currentStopMinutes`), so app-closed time counts. |
| Admin Overview = Generate Report | ✅ Same function, with caveats | Both call `collectDowntimeIntervals()` over the same three sources plus records (source priority: live session → ended archive → shift summary → record shares for stops no full source has). Caveats in §5.3. |

`collectDowntimeIntervals` rule (header comment, `downtime.ts` ~line 222): per session key `lineId|productionDate|shift`, each stop is counted **once, in full**, from the first full source that has it. Record `stopEvents` shares count only for stops no full source holds (e.g. an earlier session whose `shiftSummaries` doc a later Finalize overwrote). Shares are summed per stop across that session's records.

Verified by `test:downtime` (**24 passed**) and `test:report-downtime` (**11 passed**).

### 4.3 Supervisor handover: **Implemented** (in uncommitted files)

| Requirement | Status | Evidence |
|---|---|---|
| Another supervisor can continue a running session | ✅ | `RunningLinesScreen.tsx` (untracked) lists every `activeSessions` doc. Tap → `RecordProduction { lineId }` → `openSession()` opens **the same** `activeSessions/{lineId}` doc. *"there is no per-supervisor session"* (`supervisorHandover.ts`). |
| Original session ID, line, date, shift and start time preserved | ✅ | `sessionPayload()` omits `supervisorName/Code/Uid`, `productionDate`, `startedAt`, `sessionInstanceId` and `productionStartMinutesAbs`. Only `beginSession()` writes them. Sync runs in a transaction gated by `sessionWriteGate()` (instance check) with `revision`. |
| New records attach to the existing session | ✅ | Record ID = `pr\|pinnedDate\|lineId\|shift\|slot\|segment` (the same session identity). `recorderIdentity()` puts the **saver** in `supervisor`, the starter in `sessionSupervisor`. `splitCreateOnlyFields()` keeps the first `createdBy` and `createdAt`. `syncAttributionFields()` sets `updatedBy` and `arrayUnion` on `contributorUids`. |

Verified by `test:supervisor-handover` (**33 passed**). `src/utils/supervisorHandover.ts`, `src/screens/RunningLinesScreen.tsx` and `scripts/testSupervisorHandover.ts` are **untracked** (not committed), and `RecordProductionScreen.tsx` is modified. **Treat the handover feature as unreleased until it is committed and deployed.**

---

## 5. Admin Overview and Generate Report data flow

### 5.1 Admin Overview (`src/screens/AdminOverviewScreen.tsx`)

```
Mount ──► AsyncStorage 'prodpulse.adminOverview.selection.v1' (date + plant/workshop/division)
     ──► getDocs(productionLines)                           [once]
     ──► onSnapshot(activeSessions)                          [REALTIME, downtime only]
Date change ──► Promise.all([
                  fetchProductionRecordsForDateRange(date, date),         [one-shot]
                  fetchDowntimeSourcesForDateRange(date, date, {skipActive:true}) ])
             ──► map → resolve plant/workshop/division from productionLines by lineId
             ──► client-side filter (plant / workshop / division)
             ──► useMemo metrics (Σ produced, Σ expected, lossParts, operatorHours, efficiency, pcs/man-hour)
             ──► counterQuality(filteredRecords)  → good / rejected / quality% / rejection%
             ──► collectDowntimeIntervals({records, activeSessions(filtered, productionDate===date),
                                           endedSessions, shiftSummaries}, nowMs) → total
nowMs ticks every 30 s only while some filtered session has a running stop.
```

- **KPI source:** `productionRecords` (production, target, quality) and `activeSessions` + `endedSessions` + `shiftSummaries` (downtime).
- **Calculation location:** all **frontend**. No backend aggregation.
- **Filters:** single date (calendar-date `todayStr()` default, with Yesterday and 7-days-ago presets), plant, workshop, and division (Assembly only). **No shift filter.**
- **Realtime:** only downtime from live sessions. **Production totals are not realtime** (pull-to-refresh or web refresh button).
- **Weekly chart:** none. The screen is deliberately chart-free.

### 5.2 Generate Report (`src/screens/GenerateReportScreen.tsx`)

```
"Generate" ──► Promise.all([ fetchProductionRecordsForDateRange(from, to),
                             fetchDowntimeSourcesForDateRange(from, to) ])  [one-shot, includes activeSessions]
           ──► map → resolve location from productionLines → filter plant/workshop/division/line/part/shift
           ──► downtime sources filtered the same way (a part filter empties them)
           ──► collectDowntimeIntervals(records with productionDate = recordProductionDayKey(r), …, downtimeAtMs)
           ──► summary: Σ produced, Σ expected, lossParts, lossTimeMinutes, Σ rejections ?? 0,
                        downtime = Math.round(total), efficiency
           ──► byLine (lineId__productionDate__shift) + downtimeBySession rows
           ──► charts: Production vs Planned per line; Production Trend per productionDate
           ──► Excel export (utils/reportExcelExport.ts)
```

- **Date presets:** e.g. *Last 7 days* = `dateStrDaysAgo(6)` to `todayStr()` (calendar dates).
- **Calculation location:** all **frontend**.

### 5.3 Known inconsistencies (Admin Overview vs Generate Report vs others)

| # | Inconsistency | Effect on matching values |
|---|---|---|
| 1 | **No record de-duplication** in Admin Overview, Generate Report or KPI Analysis. Line Efficiency, Running Lines, Live Quality, Model/Part and the AI all use `dedupeSlotRecords`. | Where legacy duplicate slot docs exist, AO and GR totals **exceed** the live and Model/Part totals by exactly the duplicates. This is confirmed by `test:model-part` case 12: *"agrees with Generate Report where there are no duplicates; differs by exactly the duplicates"*. |
| 2 | Downtime **rounding**: GR `Math.round(minutes)`; AO shows one decimal under 60 min (`formatDowntimeMinutes`). | Display differences of up to ±0.5 min. |
| 3 | Downtime **freshness**: AO uses a live `activeSessions` listener with a 30 s tick; GR snapshots at generate time. | A running stop differs by the elapsed time since generation. |
| 4 | Records passed to `collectDowntimeIntervals`: GR uses `recordProductionDayKey(r)`; AO passes raw `r.productionDate` (null on legacy records). | Legacy (pre-`productionDate`) record shares get a different session key in AO. That only matters for very old data. |
| 5 | Quality: AO uses `counterQuality` (excludes legacy records from good and inspected); GR shows Σ `rejections ?? 0` and no quality %. | Rejected **count** is equal; quality % exists only in AO. |
| 6 | Efficiency with no plan: AO and GR give `0`; `efficiencyOf` gives `null` ("—"). | A display-only difference. |
| 7 | **"Today"** = calendar date (AO, GR, KPI) vs production day (recording, Line Efficiency via session `productionDate`). | Between 00:00 and 06:30 the views disagree on which day is current. |
| 8 | **KPI Analysis downtime** = Σ `record.stopEvents` (the pre-fix rule). **AI tools** = Σ `stopEvents` + running sessions. | Both differ from AO and GR whenever there are unsaved-slot stops, admin-ended sessions, or stops after a slot was saved. |
| 9 | GR part filter discards all downtime sources. | Downtime is records-only when filtering by part. |
| 10 | Stale comment in `saveShiftSummary()`: *"reports total downtime from productionRecords' stopEvents"*. Reports now use `collectDowntimeIntervals`. | Documentation only. |
| 11 | `activeSessions.totalDowntimeMinutes` is an integer, not ID de-duplicated, and frozen between syncs. | Must not be used by the TV. |

**For the TV to match Admin Overview for the same date and scope**, use the same sources and functions (`fetchProductionRecordsForDateRange` semantics, `collectDowntimeIntervals`, `counterQuality`, Σ `expectedParts` / `producedThisSlot`) **without de-duplication**. If it should instead match Line Efficiency / Model-Part, apply `dedupeProductionRecords`. **This is a product decision (§11, Q1).**

---

## 6. Cloud Functions inventory

| Item | Value |
|---|---|
| Codebase | `default`, source `functions/`, runtime `nodejs22` (`firebase.json`) |
| Build | `functions/build.mjs`: **esbuild bundles `functions/src/index.ts` together with `../src/utils` and `../src/constants`** into `lib/index.js` (npm packages external). *"so the backend runs exactly the production-date, de-duplication and metric code the app runs."* |
| Deploy script | `npm run deploy` = `firebase deploy --only functions:prodPulseAI` |
| Timezone | `functions/src/timezone.ts` sets `process.env.TZ = PRODUCTION_TIMEZONE \|\| 'Asia/Kolkata'` **before any date maths** (imported first in `index.ts`) |

### 6.1 Functions

| Name | Type | Responsibility |
|---|---|---|
| `prodPulseAI` | `onCall` (HTTPS callable v2), `timeoutSeconds 90`, `512MiB`, `maxInstances 3`, `concurrency 20`, CORS allow-list | Admin-only Gemini assistant that answers production questions through fixed read-only tools |

- **Firestore triggers:** none.
- **Scheduled functions:** none.
- **Existing aggregation:** only on demand, inside the AI tools (`functions/src/tools.ts` `productionTotals()`, `groupProduction()`, which reuse `efficiencyOf`, `counterQuality`, `dedupeProductionRecords`, `resolveSessionProductionDate`). **Nothing is persisted.**
- **Dashboard read model:** **does not exist.**

### 6.2 Authentication and authorisation (`functions/src/handler.ts`)

1. `request.auth.uid` is required (Firebase ID token verified by the callable runtime).
2. `users/{uid}` is re-read server-side; `isActiveAdmin(profile)` is required (`role === 'admin' && active !== false`). Any client-sent role is rejected.
3. Payload validation (`validateAIRequest`).
4. Per-user rate limit: 20 per 10 minutes per instance.
5. Errors are mapped to `HttpsError` with safe messages; provider text is masked in logs.

Data access (`functions/src/dataSource.ts`) uses fixed collections (`productionRecords`, `productionLines`, `activeSessions`, `rejectionRecords`, `users`), is **read-only**, and is capped at 20,000 docs per query. It uses the Admin SDK, which **bypasses security rules**.

### 6.3 Environment variables and secrets (names only)

| Name | Kind | Where |
|---|---|---|
| `GEMINI_API_KEY` | **Secret** (Secret Manager; `functions/.secret.local` for the emulator, *not read*) | `defineSecret` in `index.ts` |
| `GEMINI_MODEL` | Param string (default `DEFAULT_GEMINI_MODEL`) | `index.ts`, `.env.technico-industries-ltd` |
| `PRODPULSE_WEB_ORIGINS` | CORS allow-list | `cors.ts`, `.env.technico-industries-ltd` |
| `PRODUCTION_TIMEZONE` | Optional | `timezone.ts` |
| `EXPO_PUBLIC_USE_FUNCTIONS_EMULATOR` | Client dev flag | `src/services/firebase.ts` |

---

## 7. Security findings

### 7.1 Firestore security rules: **Not found / Needs confirmation**

- There is **no `firestore.rules` file** in the repository, and `firebase.json` has **no `firestore` section** (only `functions` and `emulators`).
- The rules are therefore managed directly in the Firebase console (or another repository), and **could not be inspected.**
- `functions/README.md`: *"The Admin SDK bypasses Firestore Security Rules … No security-rule changes are needed or made."*

### 7.2 Access the client code requires (inferred, not verified)

Because the rules are unknown, the table below lists what the **app's own code needs to work**. The real rules must allow at least this. Whether they allow more cannot be determined.

| Collection | Read by | Written by |
|---|---|---|
| `users` | own doc at login (any signed-in user); admin screens; End Production transaction | admin (create, edit); secondary-app signup |
| `productionLines` | **all signed-in roles** | admin |
| `activeSessions` | **all signed-in roles; the whole collection** (Running Lines, Admin, Line Efficiency, Supervisor) | supervisors (create, update, delete); admin (delete via End Production) |
| `productionRecords` | admin screens; supervisors (restore, Supervisor Overview, Running Lines) | supervisors (create, update, delete superseded) |
| `shiftSummaries` | admin (reports) | supervisors |
| `endedSessions` | admin; supervisors (`recoveredDrafts` update) | admin (create), supervisors (update) |
| `lineBreakdowns` | technicians, admin | supervisors |
| `rejectionRecords` | QC, admin | QC |

Admin-only enforcement **in client code** (`canViewModelPartProduction`, End Production's `isActiveAdmin` check inside the transaction) is **not** a security boundary unless the rules mirror it. **Needs confirmation.**

### 7.3 Can a public, read-only dashboard be implemented safely?

**Not by reading the existing collections publicly.** Making `productionRecords` or `activeSessions` publicly readable would expose:
- operator names and codes (`operators[]`) and supervisor names, codes and UIDs (`supervisor`, `sessionSupervisor`, `createdBy`, `supervisorUid`, `contributorUids`, `updatedBy`);
- device IDs, loss notes and sync conflicts;
- the entire history (no rule can limit a public reader to "today" and "Assembly" only, because rules are not filters).

**A safe approach is a dedicated, sanitised projection** (§9), written only by a Cloud Function with the Admin SDK, with a rule that allows public reads of **that collection only**:

```
// Proposed addition — requires first exporting the CURRENT console rules (see §11, R1)
match /tvDashboard/{docId}        { allow read: if true; allow write: if false; }
match /tvDashboard/{docId}/{sub=**} { allow read: if true; allow write: if false; }
```

Alternatives, if even aggregate production figures must not be public:
- (a) a dedicated TV Firebase Auth account (or a custom claim `tv: true`), with `allow read: if request.auth.token.tv == true` on `tvDashboard` only; or
- (b) Anonymous Auth plus App Check (Web reCAPTCHA Enterprise), restricting reads to registered TV origins.

Both require rule changes, which this audit did not make.

---

## 8. Recommended TV dashboard architecture

### 8.1 Summary

```
┌──────────────────── Firebase project: technico-industries-ltd ────────────────────┐
│                                                                                    │
│  EXISTING (unchanged)                         NEW (proposed)                       │
│  productionLines ─┐                                                                │
│  activeSessions ──┤  Firestore triggers   ┌──────────────────────────────┐         │
│  productionRecords┼─────────────────────► │ tvDashboard Cloud Function(s) │         │
│  shiftSummaries ──┤  (+ 1-min schedule    │ esbuild-bundled with          │         │
│  endedSessions ───┘   as safety net)      │ ../src/utils (shared logic)   │         │
│                                           │ TZ = Asia/Kolkata             │         │
│                                           └──────────────┬───────────────┘         │
│                                                          │ Admin SDK write         │
│                                                          ▼                         │
│                                   tvDashboard/{scope}            (public read)     │
│                                   tvDashboard/{scope}/days/{date} (public read)    │
└──────────────────────────────────────────────────────────┬─────────────────────────┘
                                                           │ onSnapshot (2 listeners)
                                                           ▼
                        ProdPulse TV Dashboard — React + Vite + JS + Tailwind + Recharts + Lucide
                        (render only; live clock ticks stop timers from stored start timestamps)
```

### 8.2 Which collections to read

The **Cloud Function** (not the TV) reads the same sources Admin Overview and Line Efficiency already use:

| Purpose | Source | Existing reader to mirror |
|---|---|---|
| Line master and Assembly scope | `productionLines` (filter `isAssemblyWorkshop(workshop)`) | `LineEfficiencyOverviewScreen` |
| Live status, current stop, shift plan, current model | `activeSessions` | `buildLineCards`, `buildRunningLineCards` |
| Actual / target / rejections | `productionRecords` by `productionDate` (+ legacy `createdAt` window) | `fetchProductionRecordsForDateRange` / `dataSource.getProductionRecords` |
| Finished-session downtime | `shiftSummaries`, `endedSessions` by `productionDate` | `fetchDowntimeSourcesForDateRange` |

The **TV browser reads only `tvDashboard`.** It never touches the production collections.

### 8.3 Reusing calculation functions without duplication

The TV is **JavaScript-only**, and the business logic is TypeScript inside the Expo repo. Copying formulas into the TV would duplicate them. Instead:

1. **Compute every KPI in a Cloud Function** inside this repo's `functions/` codebase, which **already bundles `../src/utils` with esbuild** (`functions/build.mjs`) and already sets the plant timezone. This is the existing, proven pattern (`functions/src/tools.ts` imports `efficiencyOf`, `counterQuality`, `dedupeProductionRecords`, `resolveSessionProductionDate`).
2. The TV renders pre-computed numbers. The only client-side arithmetic is the live elapsed time of a running stop, `(now − startMs) / 60000`. That is exactly `stopDurationMinutes`, and the stored `closedMinutes + Σ running` reproduces `collectDowntimeIntervals`' total between writes.

Shared functions the aggregator should call (none modified):
`productionDayKeyFor`, `resolveSessionProductionDate`, `legacyCreatedAtWindow`, `selectRecordsInProductionRange`, `recordProductionDayKey` (`productionDay.ts`); `buildLineCards`, `recordsForSession`, `dedupeSlotRecords`, `efficiencyOf`, `efficiencyBand`, `currentStop`, `stoppedBadge`, `formatStopReason` (`lineEfficiency.ts`); `counterQuality`, `computeQuality` (`qualityMetrics.ts`); `collectDowntimeIntervals`, `totalDowntimeMinutes`, `downtimeBySession`, `downtimeByReason`, `lineDowntimeSummary`, `sessionSourceFromDoc`, `summarySourceFromDoc` (`downtime.ts`); `parseRunningSession`, `slotEntryStatuses`, `sessionNowAbs`, `currentModel` (`supervisorHandover.ts`); `buildSlots`, `shiftWindow` (`productionSchedule.ts`); `isAssemblyWorkshop` logic (substring `"assembly"`, as in `RecordProductionScreen` and `AdminOverviewScreen`); `mapProductionRecord`, `resolveLineFields`, `dedupeProductionRecords` (`modelPartProduction.ts`).

### 8.4 Is a separate analytics collection necessary?

**Yes**, for three reasons:
1. **Security.** Public TV access is only safe against a sanitised projection (§7.3).
2. **No duplication.** The JS TV cannot import the TS business logic; a server-computed read model keeps one implementation.
3. **Cost and load.** One TV doing realtime listeners on raw `productionRecords` + `activeSessions` + `shiftSummaries` + `endedSessions` multiplies reads for every TV, all day. A read model costs one document read per change per TV.

### 8.5 Cloud Functions to create (none exist today; none to extend)

| Proposed function | Trigger | Job |
|---|---|---|
| `tvDashboardOnSession` | `onDocumentWritten('activeSessions/{lineId}')` | Recompute the scope snapshot for the session's `productionDate` (also on delete = Finalize or End) |
| `tvDashboardOnRecord` | `onDocumentWritten('productionRecords/{id}')` | Recompute for the record's `productionDate` |
| `tvDashboardOnSummary` | `onDocumentWritten('shiftSummaries/{id}')` and `('endedSessions/{id}')` | Recompute (downtime sources) |
| `tvDashboardOnLine` | `onDocumentWritten('productionLines/{id}')` | Line roster or scope changes |
| `tvDashboardTick` | `onSchedule('every 1 minutes', timeZone 'Asia/Kolkata')` | Safety net: rolls the production day over at 06:30, closes the shift view, and repairs missed triggers |
| `tvDashboardDaily` (optional) | `onSchedule('35 6 * * *')` | Freezes the previous production day into `days/{date}` for the weekly chart |

Implementation notes:
- `activeSessions` is written on every sync (1.2 s after typing pauses). **Debounce or coalesce**: compare `before` and `after` on the KPI-relevant fields (`lineStopped`, `stopsBySlot`, `savedSlotIndices`, `plannedProductionTotal`, `changeovers`, `selectedPartIndex`) and skip the rest. Alternatively, write a `tvDashboardQueue/{scope}` "dirty" marker and let the 1-minute tick do the recompute. The second option is cheaper and bounded at about 1,440 recomputes a day.
- Put the new code in a **new file** (`functions/src/tvDashboard.ts`) and export it from `functions/src/index.ts`. Deploy with an explicit `--only functions:tvDashboardOnSession,…`, because the existing `npm run deploy` deploys only `prodPulseAI`.
- Keep `import './timezone'` as the first import (it already is in `index.ts`).

### 8.6 Realtime updates in the TV

```js
// TV (JS) — Firebase Web SDK v12 modular, same project config as src/services/firebase.ts
const scopeRef = doc(db, 'tvDashboard', 'assembly');
onSnapshot(scopeRef, (s) => setLive(s.data()));                                  // KPIs + line tiles
onSnapshot(query(collection(scopeRef, 'days'), orderBy('productionDate', 'desc'), limit(7)),
           (s) => setWeek(s.docs.map((d) => d.data())));                       // weekly chart
// 1-second clock for running-stop timers and "last updated"; no Firestore reads on tick.
```

- Show a "stale data" banner if `generatedAtMs` is older than about 3 minutes (function failure or network loss).
- Use `enableIndexedDbPersistence` / `persistentLocalCache` so a reboot shows the last snapshot immediately.

### 8.7 Files that should remain untouched

| File / area | Reason |
|---|---|
| `src/screens/RecordProductionScreen.tsx` | The only writer of production data. Highest risk. |
| `src/utils/productionSchedule.ts`, `productionDay.ts`, `downtime.ts`, `lineEfficiency.ts`, `qualityMetrics.ts`, `liveQuality.ts`, `productionDraft.ts`, `supervisorHandover.ts`, `endProduction.ts`, `modelPartProduction.ts` | Canonical business logic, imported read-only by the new function |
| `src/services/*` | App Firestore access |
| `src/screens/AdminOverviewScreen.tsx`, `GenerateReportScreen.tsx`, `KPIAnalysisScreen.tsx`, `LineEfficiencyOverviewScreen.tsx` | Reference behaviour the TV must match |
| `functions/src/handler.ts`, `assistant.ts`, `tools.ts`, `gemini.ts`, `dataSource.ts`, `cors.ts`, `options.ts` | Existing `prodPulseAI` |
| `src/services/firebase.ts`, `.firebaserc` | Project config |
| Firestore data and existing rules | Out of scope; rules changes need the export first (§11, R1) |

The only expected edits to existing files are **additive**: one `export` line in `functions/src/index.ts`, and a **reviewed** rules change for `tvDashboard`.

---

## 9. Proposed dashboard analytics schema (NEW — separate from existing schema)

> ⚠️ **Proposal only. None of these collections exist.** They are written exclusively by the new Cloud Functions (Admin SDK) and contain **no personal data** (no operator or supervisor names, codes, UIDs or device IDs).

### 9.1 `tvDashboard/{scope}`: live snapshot (doc ID e.g. `assembly`, or later `assembly__bawal-1`)

```json
{
  "schemaVersion": 1,
  "scope": { "workshop": "Assembly", "plant": null, "division": null },
  "productionDate": "2026-10-29",
  "currentShift": "B",
  "shiftWindow": { "startMs": 1761744600000, "endMs": 1761775200000 },
  "generatedAtMs": 1761766950000,

  "kpis": {
    "actual": 4210,
    "planToDate": 4680,
    "shiftPlan": 6120,
    "efficiencyPct": 90.0,
    "rejected": 37,
    "inspected": 4247,
    "qualityPct": 99.1,
    "rejectionPct": 0.9,
    "legacyRecords": 0,
    "downtime": {
      "closedMinutes": 84.5,
      "runningStops": [{ "lineId": "aB3xK9", "startMs": 1761766200000 }]
    },
    "linesTotal": 12, "linesRunning": 8, "linesStopped": 1, "linesNotRunning": 3
  },

  "lines": [
    {
      "lineId": "aB3xK9", "lineName": "SD-Line 3", "division": "Side Door", "plant": "Bawal 1",
      "status": "stopped", "badge": "Stopped",
      "shift": "B", "currentModel": "Hinge RH",
      "actual": 410, "planToDate": 455, "shiftPlan": 612, "efficiencyPct": 90.1, "band": "warning",
      "rejected": 3, "qualityPct": 99.3,
      "downtimeClosedMinutes": 12.5,
      "currentStop": { "reasonLabel": "Material Shortage", "startMs": 1761766200000 },
      "slotsAwaiting": 1
    }
  ],

  "downtimeByReason": [{ "reason": "Material Shortage", "minutes": 42.0 }],
  "hourly": [{ "slotIndex": 0, "label": "07:00 PM - 08:00 PM", "actual": 520, "target": 560 }],

  "sources": { "failed": [] },
  "rules": { "dedupe": true, "productionDayCutover": "06:30", "timezone": "Asia/Kolkata" }
}
```

Field derivation (all through existing functions):

| Field | Derived from |
|---|---|
| `productionDate` | `productionDayKeyFor(now)` (server TZ = Asia/Kolkata) |
| `actual`, `planToDate`, `efficiencyPct` | `efficiencyOf(records)` |
| `shiftPlan` | Σ `activeSessions.plannedProductionTotal` (running), or `shiftSummaries.plannedProductionTotal` (finished). **Confirm which, §11 Q3.** |
| `rejected`, `inspected`, `qualityPct`, `rejectionPct`, `legacyRecords` | `counterQuality(records)` |
| `downtime.closedMinutes` | `totalDowntimeMinutes(collectDowntimeIntervals(…, now))` minus running-interval minutes at `now` |
| `downtime.runningStops[].startMs` | the running intervals' `startAbs`; TV total = `closed + Σ(now − startMs)/60000` |
| `lines[]` | `buildLineCards()` (status, badge, band, efficiency) + `currentStop()` + `buildRunningLineCards()` (`model`, `shiftPlan`, `slots.awaiting`) |
| `downtimeByReason` | `downtimeByReason(intervals)` (labels via `formatStopReason`) |
| `hourly` | records grouped by `slotIndex` (Σ `producedThisSlot` / `expectedParts`) + `buildSlots()` labels |

### 9.2 `tvDashboard/{scope}/days/{productionDate}`: daily totals for the weekly chart

```json
{
  "productionDate": "2026-10-29",
  "final": true,
  "byShift": {
    "A": { "actual": 5100, "planToDate": 5600, "rejected": 40, "downtimeMinutes": 95.0 },
    "B": { "actual": 4800, "planToDate": 5350, "rejected": 37, "downtimeMinutes": 84.5 }
  },
  "total": { "actual": 9900, "planToDate": 10950, "efficiencyPct": 90.4,
             "rejected": 77, "qualityPct": 99.2, "downtimeMinutes": 179.5 },
  "updatedAtMs": 1761788100000
}
```

The current day's doc is updated by the same recompute (`final: false`); `tvDashboardDaily` sets `final: true` after 06:30. This gives a **production-day** week (not calendar days), which is consistent with §4.1.

---

## 10. Reusable files and functions

| File | Functions / exports to reuse | Used by today |
|---|---|---|
| `src/utils/productionDay.ts` | `PRODUCTION_DAY_CUTOVER_MINUTES`, `productionDayKeyFor`, `productionDayMinuteToMillis`, `millisToProductionDayMinute`, `isProductionDayKey`, `timestampToMillis`, `addDaysToKey`, `recordProductionDayKey`, `legacyCreatedAtWindow`, `selectRecordsInProductionRange`, `resolveSessionProductionDate` | App + functions |
| `src/utils/productionSchedule.ts` | `buildSlots`, `shiftWindow`, `scheduledNonProductive`, `expectedPartsFor`, `changeoverSegmentMinutes`, `formatAbsMinutesToAmPm`, shift and break constants | App |
| `src/utils/lineEfficiency.ts` | `efficiencyOf`, `efficiencyBand`, `BAND_COLORS`, `dedupeSlotRecords`, `recordsForSession`, `buildLineCards`, `currentStop`, `stoppedBadge`, `formatStopReason`, `summarize`, `filterLineCards` | App + functions |
| `src/utils/qualityMetrics.ts` | `computeQuality`, `counterQuality` | App + functions |
| `src/utils/liveQuality.ts` | `QUALITY_THRESHOLDS`, `qualityStatus`, `buildQualityCards`, `summarizeQuality` | App |
| `src/utils/downtime.ts` | `collectDowntimeIntervals`, `totalDowntimeMinutes`, `downtimeBySession`, `downtimeByReason`, `lineDowntimeSummary`, `sessionDowntimeMinutes`, `stopDurationMinutes`, `stopIdOf`, `sessionSourceFromDoc`, `summarySourceFromDoc`, `inProductionRange`, `formatDowntimeMinutes`, `formatElapsedSince` | App + functions |
| `src/utils/supervisorHandover.ts` *(untracked)* | `parseRunningSession`, `slotEntryStatuses`, `sessionNowAbs`, `currentModel`, `buildRunningLineCards` | App |
| `src/utils/modelPartProduction.ts` | `mapProductionRecord`, `resolveLineFields`, `dedupeProductionRecords`, `summarize`, `breakdownByPart` | App + functions |
| `src/utils/endProduction.ts` | `sessionInstanceOf`, `ENDED_SESSIONS_COLLECTION`, `isActiveAdmin` | App + functions |
| `src/constants/lineOptions.ts` | `PLANTS`, `WORKSHOPS`, `DIVISIONS` | App + functions |
| `functions/src/dataSource.ts` | `getProductionRecords` pattern (Admin-SDK equivalent of `fetchProductionRecordsForDateRange`) | Functions |
| `functions/src/timezone.ts` | `applyProductionTimezone` | Functions |
| `functions/build.mjs` | Bundling of shared utils | Functions |
| `src/services/downtimeSources.ts` | Query shape to port to the Admin SDK (`productionDate` range on `endedSessions` and `shiftSummaries`; whole `activeSessions`) | App |

Every module listed under `src/utils` is free of React and Firebase, so it is bundle-safe for Node. `liveQuality.ts`, `lineEfficiency.ts`, `downtime.ts`, `qualityMetrics.ts`, `productionDay.ts`, `productionSchedule.ts` and `supervisorHandover.ts` were checked: they import only other `utils` modules.

---

## 11. Missing information and implementation risks

### 11.1 Not found / needs confirmation

| # | Item | Status |
|---|---|---|
| N1 | **Firestore security rules** | **Not found** in the repo; `firebase.json` has no `firestore` section. Export them from the console before any change. |
| N2 | Firestore composite indexes (`firestore.indexes.json`) | **Not found.** The code deliberately uses only single-field ranges (comments in `GenerateReportScreen`, `functions/README.md`). |
| N3 | Real Firestore data shape and volume | **Not inspected** (code-only audit). Field lists come from writers; legacy docs may differ (aliases in §2.1). |
| N4 | Production timezone of plant devices | Assumed IST (backend default `Asia/Kolkata`). **Needs confirmation.** |
| N5 | OEE, availability, performance | **Not implemented** anywhere. |
| N6 | Weekly aggregation | **Not implemented**; only Generate Report's date-range trend. |
| N7 | Shift configuration in Firestore | **Does not exist**; shifts and breaks are code constants. |
| N8 | Whether legacy duplicate `productionRecords` exist in production data | **Unknown.** The code warns and keeps them (`resolveProductionRecordRef`); the size of AO/GR vs de-duplicated differences depends on this. |
| N9 | `sampleProductionRecords` (seed collection) | Mentioned in comments and `scripts/seedHHProduction.ts`; the app never reads it. The TV must not either. |

### 11.2 Decisions needed before building

| Q | Question |
|---|---|
| Q1 | Should TV totals **match Admin Overview exactly** (no de-duplication) or match **Line Efficiency / Model-Part** (de-duplicated)? They are identical only when no duplicate slot docs exist. |
| Q2 | Should "today" on the TV be the **production day** (06:30 cutover, recommended) or the calendar date (as Admin Overview's default)? |
| Q3 | Which "target" should be the headline: **plan to date** (Σ `expectedParts` of saved slots, the efficiency denominator), or **shift plan** (`plannedProductionTotal`, whole shift, starting part's cycle time)? |
| Q4 | Is aggregate production data acceptable as **fully public** (unauthenticated read of `tvDashboard`), or must the TV authenticate (TV account, custom claim, or App Check)? |
| Q5 | Scope of "Assembly": all plants, or one plant per TV? (`scope` doc IDs.) |
| Q6 | Should `rejectionRecords` (QC defect log) appear on the TV as a separate Pareto chart? It must **not** be added to the rejection KPI. |

### 11.3 Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Overwriting the live security rules** by deploying a new `firestore.rules` from the repo (rules are console-managed today). | Pull the current rules first (`firebase firestore:rules:get` or a copy from the console), commit them unchanged, review the diff that adds only `tvDashboard`, then deploy. |
| R2 | Uncommitted, undeployed handover work (`supervisorHandover.ts`, `RunningLinesScreen.tsx`, `slotSaveButton.ts`, plus modifications to 17 files including `RecordProductionScreen.tsx`). | Commit and release before building on `supervisorHandover.ts` exports in the aggregator. |
| R3 | Trigger storm: `activeSessions` is written on every sync, so per-write recompute is expensive. | Use a field-diff filter or the dirty-flag + 1-minute tick (§8.5). Set `maxInstances: 1` per scope to avoid out-of-order writes, or write with a `generatedAtMs` guard in a transaction. |
| R4 | Calendar vs production day mismatch (§4.1, §5.3 #7). | Compute the day server-side with the pinned TZ; never in the TV browser. |
| R5 | `shiftSummaries` doc ID collides for two sessions of the same line, date and shift (overwrite). | Already handled by `collectDowntimeIntervals`' record-share fallback; the aggregator must use that function and not read `shiftSummaries.totalDowntimeMinutes`. |
| R6 | `activeSessions.totalDowntimeMinutes` and `stopsSummaryBySlot` are misleading (integer, stale, not de-duplicated). | Never use them; use `stopsBySlot` through `downtime.ts`. |
| R7 | Location fields on old records can be null or wrong. | Always resolve plant, workshop and division from `productionLines` by `lineId` (`resolveLineFields`), as AO and GR do. |
| R8 | Workshop label matching ("Assembly Shop"). | Use the existing substring rule (`includes('assembly')`, case-insensitive), not equality. |
| R9 | Weekly chart for days before the aggregator existed. | Backfill `days/{date}` once by running the same aggregation over past production dates (read-only on source data). |
| R10 | A public read of `tvDashboard` is a data-scraping surface. | Keep only aggregates; consider App Check; no personal data (§9). |
| R11 | `prodPulseAI`'s `npm run deploy` targets only `prodPulseAI`; a full `firebase deploy --only functions` would also redeploy it. | Deploy the new functions by name. |
| R12 | KPI Analysis and Prod AI downtime use older rules (§5.3 #8). | Not a TV blocker, but their downtime will differ from the TV and Admin Overview. Flag to users or fix separately. |

### 11.4 Verification performed

All are pure logic scripts. None touch Firebase or write files.

| Command | Result |
|---|---|
| `npm run test:shift-b-overnight` | 22 passed |
| `npm run test:production-day` | 10 passed |
| `npm run test:downtime` | 24 passed |
| `npm run test:report-downtime` | 11 passed |
| `npm run test:supervisor-handover` | 33 passed |
| `npm run test:line-efficiency` | 25 passed |
| `npm run test:quality` | 14 passed |
| `npm run test:live-quality` | 21 passed |
| `npm run test:end-production` | 15 passed |
| `npm run test:schedule` | 66 checks passed |
| `npm run test:model-part` | 12 passed |

### 11.5 Working-tree state at audit time

Modified (uncommitted): `App.tsx`, `app.json`, `functions/test/prodPulseAI.test.ts`, `package.json`, `src/components/AdminDashboardPager.tsx`, `ProdAIButton.tsx`, `ProdAIPanel.tsx`, `src/screens/AIAssistantScreen.tsx`, `AdminOverviewScreen.tsx`, `DashboardScreen.tsx`, `LineEfficiencyOverviewScreen.tsx`, `LiveQualityLinesScreen.tsx`, `QualityOverviewScreen.tsx`, `RecordProductionScreen.tsx`, `SupervisorOverviewScreen.tsx`, `src/utils/prodAIPanelLayout.ts`, `prodPulseAI.ts`, `prodPulseAIExcelExport.ts`.
Untracked: `scripts/testSlotSaveButton.ts`, `scripts/testSupervisorHandover.ts`, `src/screens/RunningLinesScreen.tsx`, `src/utils/slotSaveButton.ts`, `src/utils/supervisorHandover.ts`.
This audit describes the **working tree**, not only the last commit.

Housekeeping observed (not acted on): Android keystores (`*.jks`), `upload_certificate.pem`, `functions/.secret.local` and `functions/.env.technico-industries-ltd` are in the working tree but **are git-ignored** (verified with `git check-ignore`). `tatus --short` (an accidental file) and `prod-draft-review.diff` are tracked in git.
