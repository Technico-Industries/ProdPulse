// src/stores/prodAIStore.ts
//
// The app's one Prod AI conversation (utils/prodAIConversation), wired to
// the secure backend call. Shared by the popup and the /ai-assistant route,
// and kept for the app session — closing the popup does not clear it.

import { useStore } from 'zustand';
import { askProdPulseAI } from '../services/prodPulseAI';
import { createProdAIConversation, ProdAIConversationState } from '../utils/prodAIConversation';

export const prodAIConversation = createProdAIConversation(askProdPulseAI);

export function useProdAI<T>(selector: (s: ProdAIConversationState) => T): T {
  return useStore(prodAIConversation, selector);
}
