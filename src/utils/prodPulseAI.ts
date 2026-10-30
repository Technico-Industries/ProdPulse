// src/utils/prodPulseAI.ts
//
// Contract shared by the ProdPulse AI screen (src/screens/AIAssistantScreen)
// and the prodPulseAI Cloud Function (functions/src). Pure — no React, no
// Firebase — so the backend bundles it and the checks in
// functions/test/prodPulseAI.test.ts (npm run test:ai) can run it directly.
//
// RESULTS vs. TEXT — every figure the assistant shows comes from a
// ResultBlock built by the backend's deterministic aggregation code
// (functions/src/tools.ts). The model only writes the `reply` text around
// those blocks; it never produces, edits or exports a block's rows. The
// screen renders blocks as tables and the Excel export writes exactly the
// rows of the block, so what is exported is what the database returned.

// ─── Availability ────────────────────────────────────────────────────────────

// Platforms the assistant runs on: the web app and the Android/iOS app (it
// was web-only until the popup existed — the backend call, auth and admin
// checks are the same everywhere). Anything else gets the notice screen.
export function isProdPulseAIAvailable(platformOS: string): boolean {
  return platformOS === 'web' || platformOS === 'android' || platformOS === 'ios';
}

// Who gets the floating Prod AI button: an admin, on a platform where the
// assistant runs. A UI gate only — the backend re-checks the caller's admin
// profile on every request.
export function canOpenProdAI(role: string | null | undefined, platformOS: string): boolean {
  return role === 'admin' && isProdPulseAIAvailable(platformOS);
}

// ─── Request ─────────────────────────────────────────────────────────────────

export const AI_LIMITS = {
  maxQuestionChars: 1000,
  maxHistoryMessages: 12,
  maxHistoryMessageChars: 4000,
  maxHistoryTotalChars: 16000,
} as const;

export type AIHistoryRole = 'user' | 'model';

export interface AIHistoryMessage {
  role: AIHistoryRole;
  text: string;
}

export interface ProdPulseAIRequest {
  question: string;
  history: AIHistoryMessage[];
}

export type RequestCheck = { ok: true; value: ProdPulseAIRequest } | { ok: false; error: string };

// Validates the callable's payload. The backend runs this on every request
// (the client copy is only a convenience); anything else in the payload —
// a role, a uid, a collection name — is rejected rather than ignored, so a
// client can never smuggle authority in.
export function validateAIRequest(raw: unknown): RequestCheck {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Invalid request.' };
  const data = raw as Record<string, unknown>;
  const extra = Object.keys(data).filter((k) => k !== 'question' && k !== 'history');
  if (extra.length) return { ok: false, error: `Unexpected field(s): ${extra.join(', ')}.` };

  if (typeof data.question !== 'string') return { ok: false, error: 'Ask a question first.' };
  const question = data.question.trim();
  if (!question) return { ok: false, error: 'Ask a question first.' };
  if (question.length > AI_LIMITS.maxQuestionChars) {
    return { ok: false, error: `Keep the question under ${AI_LIMITS.maxQuestionChars} characters.` };
  }

  const rawHistory = data.history ?? [];
  if (!Array.isArray(rawHistory)) return { ok: false, error: 'Invalid conversation history.' };
  if (rawHistory.length > AI_LIMITS.maxHistoryMessages) {
    return { ok: false, error: 'The conversation is too long. Start a new conversation.' };
  }
  const history: AIHistoryMessage[] = [];
  let total = 0;
  for (const m of rawHistory) {
    if (!m || typeof m !== 'object') return { ok: false, error: 'Invalid conversation history.' };
    const { role, text } = m as Record<string, unknown>;
    if ((role !== 'user' && role !== 'model') || typeof text !== 'string') {
      return { ok: false, error: 'Invalid conversation history.' };
    }
    if (text.length > AI_LIMITS.maxHistoryMessageChars) return { ok: false, error: 'A previous message is too long. Start a new conversation.' };
    total += text.length;
    history.push({ role, text });
  }
  if (total > AI_LIMITS.maxHistoryTotalChars) return { ok: false, error: 'The conversation is too long. Start a new conversation.' };
  return { ok: true, value: { question, history } };
}

// ─── Response ────────────────────────────────────────────────────────────────

export type Cell = string | number | null;

export type ColumnKind = 'text' | 'number' | 'percent' | 'minutes';

export interface ResultColumn {
  key: string;
  label: string;
  kind: ColumnKind;
}

export interface ResultMetric {
  label: string;
  value: number | string | null;
  kind: ColumnKind;
}

export interface ResultBlock {
  id: string;
  tool: string;
  title: string;
  // The range actually queried, and which date convention it uses:
  // productionRecords use the production date (6:30 AM cutover, Shift B
  // stays on the night it started); rejectionRecords use the calendar date.
  dateRange: { from: string; to: string; convention: 'production-date' | 'calendar-date' } | null;
  filters: Record<string, string>;
  source: string;
  definitions: string[];
  metrics: ResultMetric[];
  columns: ResultColumn[];
  rows: Record<string, Cell>[];
  // Column pair worth a bar chart (label column, value column), if any.
  chart: { labelKey: string; valueKey: string } | null;
  // false when a known data limitation applies (see notes).
  complete: boolean;
  notes: string[];
  // Rows beyond the display limit were left out of `rows`.
  truncatedRows: number;
}

export interface AIToolError {
  tool: string;
  message: string;
  category: AIErrorCategory;
}

// Why a request failed. The backend sends it as the HttpsError's
// details.category; the client derives it for failures that never reached
// the backend. Shown with the error so a failure can be traced, and logged.
export type AIErrorCategory =
  | 'NETWORK_ERROR'
  | 'BACKEND_UNAVAILABLE'
  | 'AUTH_REQUIRED'
  | 'ADMIN_FORBIDDEN'
  | 'INVALID_REQUEST'
  | 'RATE_LIMITED'
  | 'AI_CONFIGURATION_ERROR'
  | 'AI_API_ERROR'
  | 'FIRESTORE_QUERY_ERROR'
  | 'INVALID_RESPONSE'
  | 'TIMEOUT';

// Finer cause within a category, for AI-provider and configuration failures
// (details.reason from the backend). Shown next to the error code.
export type AIErrorReason =
  | 'KEY_MISSING'
  | 'KEY_INVALID'
  | 'ACCESS_DENIED'
  | 'NO_CREDITS'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_MISCONFIGURED'
  | 'RATE_LIMITED'
  | 'BAD_REQUEST'
  | 'PROVIDER_UNAVAILABLE'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export const AI_ERROR_REASONS: AIErrorReason[] = [
  'KEY_MISSING', 'KEY_INVALID', 'ACCESS_DENIED', 'NO_CREDITS', 'MODEL_UNAVAILABLE', 'MODEL_MISCONFIGURED', 'RATE_LIMITED',
  'BAD_REQUEST', 'PROVIDER_UNAVAILABLE', 'NETWORK', 'TIMEOUT', 'INVALID_RESPONSE',
];

export const AI_ERROR_CATEGORIES: AIErrorCategory[] = [
  'NETWORK_ERROR', 'BACKEND_UNAVAILABLE', 'AUTH_REQUIRED', 'ADMIN_FORBIDDEN', 'INVALID_REQUEST', 'RATE_LIMITED',
  'AI_CONFIGURATION_ERROR', 'AI_API_ERROR', 'FIRESTORE_QUERY_ERROR', 'INVALID_RESPONSE', 'TIMEOUT',
];

export interface ProdPulseAIResponse {
  reply: string;
  results: ResultBlock[];
  toolErrors: AIToolError[];
  // True only when at least one database tool succeeded in this answer.
  dataRetrieved: boolean;
  model: string;
  generatedAt: string; // ISO
}

export interface ClassifiedError {
  category: AIErrorCategory;
  message: string;
  retryable: boolean;
  reason?: AIErrorReason;
}

const NOT_RETRYABLE = new Set<AIErrorCategory>(['AUTH_REQUIRED', 'ADMIN_FORBIDDEN', 'INVALID_REQUEST', 'AI_CONFIGURATION_ERROR']);
const classified = (category: AIErrorCategory, message: string): ClassifiedError => ({ category, message, retryable: !NOT_RETRYABLE.has(category) });

// Turns a failed prodPulseAI callable (a Firebase FunctionsError) into a
// categorised, user-safe error.
//
// The backend (functions/src/handler.ts) sends fixed, user-safe messages
// with details.category; those are shown as they are. Failures that never
// got a backend answer are classified here — notably the browser case where
// the function is missing or unreachable: the CORS preflight fails, fetch
// throws, and the Firebase SDK reports only `functions/internal` with the
// message "internal" (its status-0 path). That used to fall through to a
// generic "check your connection" message, hiding that the backend was not
// there at all.
//
// For that status-0 case the caller can say whether the function's host
// answered a plain no-cors request (`reachable`, see services/prodPulseAI
// probeFunctionHost): true → the server is there but refused the call (the
// function is not deployed, or CORS blocked it); false → no connection to
// it at all (network, DNS, firewall); null → not probed.
export function isStatusZeroError(err: unknown): boolean {
  return (err as { code?: string })?.code === 'functions/internal' && (err as { message?: string })?.message === 'internal';
}

export function classifyCallableError(err: unknown, offline: boolean, reachable: boolean | null = null): ClassifiedError {
  const code = (err as { code?: string })?.code ?? '';
  const message = (err as { message?: string })?.message ?? '';
  const serverCategory = (err as { details?: { category?: unknown } })?.details?.category;
  if (typeof serverCategory === 'string' && (AI_ERROR_CATEGORIES as string[]).includes(serverCategory) && message) {
    const reason = (err as { details?: { reason?: unknown } })?.details?.reason;
    const out = classified(serverCategory as AIErrorCategory, message);
    return typeof reason === 'string' && (AI_ERROR_REASONS as string[]).includes(reason) ? { ...out, reason: reason as AIErrorReason } : out;
  }
  const unreachable = offline
    ? classified('NETWORK_ERROR', 'You appear to be offline. Check your connection and try again.')
    : reachable === false
      ? classified('NETWORK_ERROR', "Couldn't connect to the Prod AI server. Check your network (or firewall) and try again.")
      : reachable === true
        ? classified('BACKEND_UNAVAILABLE', 'The Prod AI server responded but refused the request — the prodPulseAI function is most likely not deployed. Contact the developer.')
        : classified('BACKEND_UNAVAILABLE', "Couldn't reach the Prod AI service — it may not be deployed, or the request was blocked. If this keeps happening, contact the developer.");
  switch (code) {
    case 'functions/unauthenticated':
      return classified('AUTH_REQUIRED', 'Your session has expired. Sign in again to use Prod AI.');
    case 'functions/permission-denied':
      return classified('ADMIN_FORBIDDEN', 'Prod AI is available to active admin accounts only.');
    case 'functions/deadline-exceeded':
      return classified('TIMEOUT', 'Prod AI took too long to answer. Please try again.');
    case 'functions/not-found':
    case 'functions/unimplemented':
      return classified('BACKEND_UNAVAILABLE', 'The Prod AI service is not deployed. Ask the developer to deploy the prodPulseAI function.');
    case 'functions/unavailable':
      return classified('BACKEND_UNAVAILABLE', 'The Prod AI service is temporarily unavailable. Please try again.');
    case 'functions/internal':
      return message === 'internal' ? unreachable : classified('INVALID_RESPONSE', 'Prod AI returned an unexpected answer. Please try again.');
  }
  return unreachable;
}

// ─── Excel export ────────────────────────────────────────────────────────────
// Plain rows for one result block — the same rows the screen shows, plus the
// metadata needed to read them out of context.

export interface ResultExportTables {
  info: Cell[][];
  table: Cell[][];
}

export function buildResultExportTables(block: ResultBlock, generatedAt: string): ResultExportTables {
  const range = block.dateRange
    ? `${block.dateRange.from} to ${block.dateRange.to} (${block.dateRange.convention === 'production-date' ? 'production date' : 'calendar date'})`
    : '—';
  const filters = Object.entries(block.filters);
  const info: Cell[][] = [
    [block.title],
    ['Date range', range],
    ...(filters.length ? filters.map(([k, v]) => [k, v] as Cell[]) : [['Filters', 'None'] as Cell[]]),
    ['Source', block.source],
    ['Generated at', generatedAt],
    ['Complete', block.complete ? 'Yes' : 'No — see notes'],
    [],
    ...block.metrics.map((m) => [m.label, m.value] as Cell[]),
    ...(block.definitions.length ? [[] as Cell[], ['Definitions'] as Cell[], ...block.definitions.map((d) => [d] as Cell[])] : []),
    ...(block.notes.length ? [[] as Cell[], ['Notes'] as Cell[], ...block.notes.map((n) => [n] as Cell[])] : []),
  ];
  const table: Cell[][] = [
    block.columns.map((c) => c.label),
    ...block.rows.map((r) => block.columns.map((c) => r[c.key] ?? '')),
  ];
  return { info, table };
}
