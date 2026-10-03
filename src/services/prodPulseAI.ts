// src/services/prodPulseAI.ts
//
// Client-side call into the secure ProdPulse AI backend (functions/src/index.ts).
// This file contains NO API key and NO Firestore query logic — it only
// invokes the callable Cloud Function and returns its response.
//
// Not yet wired into AIAssistantScreen.tsx — that screen's chat UI stays
// exactly as it was in Part 1 until you ask for it to be connected.

import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';

export interface ProdPulseAIResponse {
  reply: string;
  operation: string | null;
}

const callProdPulseAI = httpsCallable<{ question: string }, ProdPulseAIResponse>(functions, 'prodPulseAI');

/**
 * Sends a question to the secure ProdPulse AI backend and returns its
 * natural-language reply. Throws on network/auth/backend errors — callers
 * should catch and show a friendly message (mirrors the try/catch pattern
 * used throughout the other screens in this app).
 */
export async function askProdPulseAI(question: string): Promise<ProdPulseAIResponse> {
  const trimmed = question.trim();
  if (!trimmed) {
    throw new Error('Ask a question first.');
  }
  const result = await callProdPulseAI({ question: trimmed });
  return result.data;
}