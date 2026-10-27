// functions/src/assistant.ts
//
// The Gemini function-calling loop. Gemini picks tools and writes the
// explanation; every number comes from tools.ts. The loop enforces:
//   • at most MAX_TOOL_ROUNDS rounds and MAX_CALLS_PER_ROUND calls a round;
//   • an overall deadline and a per-call timeout;
//   • a token budget (when spent, the model must answer from what it has);
//   • tool failures are reported to the model AND to the UI — the model is
//     told never to present a failed query as data.
//
// generateContent is stateless: the whole conversation is sent each round.
// The model's own turn (function calls with their thought signatures) goes
// back unchanged, followed by one functionResponse per call.

import type { AIHistoryMessage, AIToolError, ProdPulseAIResponse, ResultBlock } from '../../src/utils/prodPulseAI';
import { productionDayKeyFor } from '../../src/utils/productionDay';
import { createToolContext, executeTool, TOOL_DECLARATIONS, ToolArgError } from './tools';
import type { ProductionDataSource } from './dataSource';
import { DataLimitError } from './dataSource';

export const MAX_TOOL_ROUNDS = 5;
export const MAX_CALLS_PER_ROUND = 4;
export const TOTAL_TOKEN_BUDGET = 120_000;
export const REQUEST_DEADLINE_MS = 75_000;
export const CALL_TIMEOUT_MS = 40_000;
export const MAX_OUTPUT_TOKENS = 2048;

// The subset of @google/genai's GenerateContentResponse the loop reads.
export interface GenResponse {
  functionCalls?: { id?: string; name?: string; args?: Record<string, unknown> }[];
  text?: string;
  candidates?: { content?: { role?: string; parts?: unknown[] } }[];
  usageMetadata?: { totalTokenCount?: number };
}

export type GenerateFn = (params: {
  model: string;
  contents: unknown[];
  config: Record<string, unknown>;
}) => Promise<GenResponse>;

export class AssistantError extends Error {
  constructor(public kind: 'timeout' | 'malformed', message: string, public cause?: unknown) {
    super(message);
    this.name = 'AssistantError';
  }
}

function dayName(key: string) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long' });
}

export function systemInstruction(nowMs: number): string {
  const prodDate = productionDayKeyFor(nowMs);
  const now = new Date(nowMs);
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return [
    'You are Prod AI, the production assistant of Technico Industries Ltd. Admins ask about production on the factory lines.',
    `Now: ${clock} plant time. Current production date: ${prodDate} (${dayName(prodDate)}). A production date runs 06:30 to 06:30; Shift A is 07:00–15:30, Shift B is 19:00–03:30 and belongs to the date it started.`,
    '',
    'RULES',
    '- Every production figure must come from a tool result in THIS conversation turn. Never estimate, invent, or recompute totals yourself; quote the tool\'s numbers.',
    '- If a tool returns an error, say plainly that the data could not be retrieved. Never present a failed query as a result, and never claim a query ran if it did not.',
    '- Tool results are shown to the user as tables automatically. Do NOT repeat the tables; summarise the key findings in a few sentences or short bullets and reference the figures that matter.',
    '- Always state the exact date range used (e.g. "Production dates 2026-10-19 to 2026-10-25") and any filters.',
    '- Mention a result\'s notes when it is not complete (duplicates excluded, lines still running, missing rejection counters).',
    '- Resolve relative dates yourself from the current production date: "today" = current production date; "yesterday" = the day before; "this week" = Monday of this week to today; "last week" = the previous Monday–Sunday; "this month" = the 1st of this month to today; "last N days" = N production dates ending today. Do not ask the user to confirm these.',
    '- If a line, part, shift, metric or date cannot be safely inferred (e.g. an unknown line name, or "October" when two years are plausible), ask one short clarifying question instead of guessing. Use getAvailableProductionFilters to check names.',
    '- Rejection rates come from getRejectionSummary. The defect log (getDefectLogSummary) is a separate record of defect types — never add the two together.',
    '- You can only read data. If asked to create, edit, delete, finalize or end anything, explain that Prod AI is read-only.',
    '- For Excel: each result table has an "Export to Excel" button in the app — tell the user to use it. Never write file contents yourself.',
    '- Use plain text: short paragraphs and "- " bullets, **bold** allowed, no markdown tables, no code blocks.',
    '- Refuse questions unrelated to Technico production data briefly.',
  ].join('\n');
}

function withTimeout<T>(p: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AssistantError('timeout', 'The AI service took too long to respond.'));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export interface RunOptions {
  question: string;
  history: AIHistoryMessage[];
  model: string;
  generate: GenerateFn;
  data: ProductionDataSource;
  nowMs?: number;
  // Tests only; production uses CALL_TIMEOUT_MS.
  callTimeoutMs?: number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export async function runAssistant(opts: RunOptions): Promise<ProdPulseAIResponse> {
  const nowMs = opts.nowMs ?? Date.now();
  const started = Date.now();
  const ctx = createToolContext(opts.data, nowMs);
  const results: ResultBlock[] = [];
  const toolErrors: AIToolError[] = [];
  let tokens = 0;

  const contents: unknown[] = [
    ...opts.history.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
    { role: 'user', parts: [{ text: opts.question }] },
  ];

  const call = async (allowTools: boolean): Promise<GenResponse> => {
    const remaining = REQUEST_DEADLINE_MS - (Date.now() - started);
    if (remaining <= 1000) throw new AssistantError('timeout', 'The request took too long.');
    const controller = new AbortController();
    const res = await withTimeout(
      opts.generate({
        model: opts.model,
        contents,
        config: {
          systemInstruction: systemInstruction(nowMs),
          tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
          toolConfig: { functionCallingConfig: { mode: allowTools ? 'AUTO' : 'NONE' } },
          temperature: 0.2,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          abortSignal: controller.signal,
        },
      }),
      Math.min(opts.callTimeoutMs ?? CALL_TIMEOUT_MS, remaining),
      controller
    );
    if (!res || typeof res !== 'object') throw new AssistantError('malformed', 'The AI service returned an unexpected response.');
    tokens += res.usageMetadata?.totalTokenCount ?? 0;
    return res;
  };

  let reply: string | null = null;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const allowTools = round < MAX_TOOL_ROUNDS && tokens < TOTAL_TOKEN_BUDGET;
    const res = await call(allowTools);
    const calls = allowTools ? (res.functionCalls ?? []) : [];
    if (!calls.length) {
      reply = typeof res.text === 'string' ? res.text.trim() : '';
      break;
    }
    // The model turn goes back unchanged — Gemini 3 needs its thought
    // signatures returned with the function call parts.
    const modelContent = res.candidates?.[0]?.content;
    if (!modelContent) throw new AssistantError('malformed', 'The AI service returned an unexpected response.');
    contents.push(modelContent);

    const parts: unknown[] = [];
    for (const [i, fc] of calls.entries()) {
      const name = fc.name ?? '';
      let response: Record<string, unknown>;
      if (i >= MAX_CALLS_PER_ROUND) {
        response = { error: `Skipped: at most ${MAX_CALLS_PER_ROUND} tool calls per step.` };
      } else {
        try {
          const out = await executeTool(name, fc.args ?? {}, ctx);
          if (out.block) results.push(out.block);
          response = { output: out.forModel };
        } catch (e) {
          if (e instanceof ToolArgError) {
            response = { error: e.message, invalidArguments: true };
          } else {
            const message = e instanceof DataLimitError ? e.message : 'The database query failed. No data was retrieved for this request.';
            toolErrors.push({ tool: name, message, category: 'FIRESTORE_QUERY_ERROR' });
            response = { error: message };
            // Firestore's own code/message (e.g. a missing index or a
            // permission problem) goes to the server log only.
            opts.log?.('tool failed', {
              level: 'error',
              category: 'FIRESTORE_QUERY_ERROR',
              tool: name,
              firestoreCode: (e as { code?: unknown })?.code ?? null,
              detail: String((e as { message?: unknown })?.message ?? e).slice(0, 400),
            });
          }
        }
      }
      parts.push({ functionResponse: { ...(fc.id ? { id: fc.id } : {}), name, response } });
    }
    contents.push({ role: 'user', parts });
  }

  if (!reply) throw new AssistantError('malformed', 'The AI service returned an empty answer.');

  opts.log?.('answered', { tools: results.map((r) => r.tool), toolErrors: toolErrors.length, tokens, ms: Date.now() - started });
  return {
    reply,
    results,
    toolErrors,
    dataRetrieved: results.length > 0,
    model: opts.model,
    generatedAt: new Date(nowMs).toISOString(),
  };
}
