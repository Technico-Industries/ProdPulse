// src/utils/prodAIConversation.ts
//
// The Prod AI conversation — messages, the in-flight request, send / retry /
// new conversation — as a store that lives outside any screen. The popup
// (components/ProdAIPanel) and the /ai-assistant route both render it, so
// closing the popup mid-request neither cancels nor corrupts the request:
// the reply lands in the store and is there when the popup reopens.
//
// The logic is the assistant screen's original, moved here unchanged:
//   • one request at a time (a send or retry while one is in flight is
//     ignored — opening, closing or resizing the popup never sends);
//   • "New conversation" bumps the conversation id, so a reply still in
//     flight for the old conversation is dropped;
//   • history sent as context is text only, newest kept, within AI_LIMITS;
//   • a failed request becomes an error bubble with Retry when retryable.
// Pure — no React, no Firebase: the ask function is injected (the app
// passes services/prodPulseAI askProdPulseAI), so scripts/testProdAIPanel.ts
// can run it with a fake backend.

import { createStore, StoreApi } from 'zustand/vanilla';
import { AI_LIMITS, AIErrorCategory, AIHistoryMessage, ProdPulseAIResponse } from './prodPulseAI';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  response?: ProdPulseAIResponse;
  // Set only on a failed request — the bubble shows the error and, when the
  // failure is retryable, a Retry that re-sends `question`.
  error?: { message: string; retryable: boolean; category: AIErrorCategory; reason?: string; question: string };
}

// What a failed ask rejects with (services/prodPulseAI ProdPulseAIError has
// this shape). Anything else becomes a generic retryable error.
export interface AskErrorLike {
  message: string;
  retryable: boolean;
  category: AIErrorCategory;
  reason?: string;
}
export type AskFn = (question: string, history: AIHistoryMessage[]) => Promise<ProdPulseAIResponse>;

export interface ProdAIConversationState {
  ownerUid: string | null;
  messages: ChatMessage[];
  isSending: boolean;
  // The composer's unsent text, kept across close / reopen.
  draft: string;
  conversationId: number;
  setDraft(text: string): void;
  send(text: string): boolean;
  retry(messageId: string): boolean;
  newConversation(): void;
  // Clears everything when a different user signs in on this device.
  ensureOwner(uid: string | null): void;
}

let idSeq = 0;
const newId = () => `${Date.now()}-${++idSeq}`;

// Earlier turns sent as context (text only — never result rows), newest
// kept, within the backend's limits.
export function historyFor(messages: ChatMessage[]): AIHistoryMessage[] {
  const turns: AIHistoryMessage[] = messages
    .filter((m) => !m.error && m.text.trim())
    .map((m) => ({ role: m.role === 'user' ? 'user' : 'model', text: m.text.slice(0, AI_LIMITS.maxHistoryMessageChars) }));
  const out: AIHistoryMessage[] = [];
  let total = 0;
  for (let i = turns.length - 1; i >= 0 && out.length < AI_LIMITS.maxHistoryMessages; i--) {
    total += turns[i].text.length;
    if (total > AI_LIMITS.maxHistoryTotalChars) break;
    out.unshift(turns[i]);
  }
  // The conversation sent to the model opens with a user turn.
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

const isAskError = (e: unknown): e is AskErrorLike =>
  !!e && typeof e === 'object' && typeof (e as any).message === 'string' && typeof (e as any).retryable === 'boolean' && typeof (e as any).category === 'string';

export function createProdAIConversation(ask: AskFn): StoreApi<ProdAIConversationState> {
  return createStore<ProdAIConversationState>()((set, get) => {
    // `prior` is the conversation the question is asked in (without the
    // question itself).
    const sendQuestion = (text: string, prior: ChatMessage[], appendUserBubble: boolean): boolean => {
      if (get().isSending) return false;
      const conversation = get().conversationId;
      set({
        isSending: true,
        ...(appendUserBubble ? { messages: [...prior, { id: newId(), role: 'user' as const, text }] } : {}),
      });

      ask(text, historyFor(prior))
        .then((response) => {
          if (conversation !== get().conversationId) return;
          set((s) => ({ messages: [...s.messages, { id: newId(), role: 'assistant', text: response.reply.trim(), response }] }));
        })
        .catch((err) => {
          if (conversation !== get().conversationId) return;
          const e: AskErrorLike = isAskError(err)
            ? err
            : { message: "Sorry, I couldn't retrieve that information. Please try again.", retryable: true, category: 'INVALID_RESPONSE' };
          set((s) => ({
            messages: [
              ...s.messages,
              { id: newId(), role: 'assistant', text: '', error: { message: e.message, retryable: e.retryable, category: e.category, reason: e.reason, question: text } },
            ],
          }));
        })
        .finally(() => {
          if (conversation === get().conversationId) set({ isSending: false });
        });
      return true;
    };

    return {
      ownerUid: null,
      messages: [],
      isSending: false,
      draft: '',
      conversationId: 0,
      setDraft: (text) => set({ draft: text }),
      send: (raw) => {
        const text = raw.trim();
        if (!text || get().isSending) return false;
        set({ draft: '' });
        return sendQuestion(text, get().messages, true);
      },
      retry: (messageId) => {
        const { messages, isSending } = get();
        const idx = messages.findIndex((m) => m.id === messageId);
        const failed = idx >= 0 ? messages[idx] : null;
        if (isSending || !failed?.error?.retryable) return false;
        // Drop the failed bubble; the user's question stays above it.
        set({ messages: messages.filter((m) => m.id !== messageId) });
        // Context = everything before the question being retried.
        return sendQuestion(failed.error.question, messages.slice(0, Math.max(0, idx - 1)), false);
      },
      newConversation: () => set((s) => ({ conversationId: s.conversationId + 1, messages: [], draft: '', isSending: false })),
      ensureOwner: (uid) => {
        if (get().ownerUid === uid) return;
        set((s) => ({ ownerUid: uid, conversationId: s.conversationId + 1, messages: [], draft: '', isSending: false }));
      },
    };
  });
}
