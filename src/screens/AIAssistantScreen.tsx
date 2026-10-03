// src/screens/AIAssistantScreen.tsx
//
// ProdPulse AI — chat UI, wired to the real backend (Part 4). Sending a
// message calls src/services/prodPulseAI.ts's askProdPulseAI(), which
// invokes the secure prodPulseAI Cloud Function (Gemini + a controlled
// Firestore query layer live server-side only — nothing AI- or
// Firestore-related happens in this file, and no API key ever appears
// here). No fabricated assistant replies are ever generated in this file:
// every assistant bubble is either real text returned by the backend, or a
// generic error message with a Retry option on failure.

import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { askProdPulseAI } from '../services/prodPulseAI';

const EXAMPLE_PROMPTS = [
  "What is today's production?",
  "Show today's rejections.",
  'Which line has the highest production?',
  'Show top defects this week.',
  "Compare today's production with yesterday.",
  "Generate today's report.",
];

type ChatRole = 'user' | 'assistant';

interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  // Only ever set on an assistant message that represents a failed
  // request. Lets the bubble render a Retry action and lets retry re-send
  // the exact original question.
  isError?: boolean;
  retryQuestion?: string;
}

// User-facing message shown on any failure (network, auth, backend, AI, or
// Firestore error). Never surfaces the underlying error's text — that could
// leak internal Firebase error codes, stack traces, or other backend
// details into the chat.
const GENERIC_ERROR_MESSAGE = "Sorry, I couldn't retrieve that information. Please try again.";

export default function AIAssistantScreen() {
  const navigation = useNavigation<any>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  // Auto-scroll to the latest message (or the typing indicator) whenever
  // the conversation changes.
  useEffect(() => {
    if (messages.length === 0 && !isSending) return;
    const t = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
    return () => clearTimeout(t);
  }, [messages.length, isSending]);

  // Core send path, shared by both the input box and the Retry action.
  // `appendUserBubble` is false on retry, since the original user bubble
  // is still visible above the failed reply — retry only replaces the
  // assistant side of that exchange.
  const sendQuestion = (text: string, appendUserBubble: boolean) => {
    if (isSending) return; // a request is already in flight — prevent duplicates

    if (appendUserBubble) {
      const userMessage: ChatMessage = { id: `${Date.now()}-u`, role: 'user', text };
      setMessages((prev) => [...prev, userMessage]);
    }
    setIsSending(true);

    askProdPulseAI(text)
      .then((response) => {
        const replyText = response.reply?.trim() || GENERIC_ERROR_MESSAGE;
        setMessages((prev) => [...prev, { id: `${Date.now()}-a`, role: 'assistant', text: replyText }]);
      })
      .catch((err) => {
        // Log internally for debugging only — the chat bubble always shows
        // the generic message, never err.message/err.code/a stack trace.
        console.error('[AIAssistantScreen] askProdPulseAI failed:', err);
        setMessages((prev) => [
          ...prev,
          {
            id: `${Date.now()}-a`,
            role: 'assistant',
            text: GENERIC_ERROR_MESSAGE,
            isError: true,
            retryQuestion: text,
          },
        ]);
      })
      .finally(() => {
        setIsSending(false);
      });
  };

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    if (isSending) return;
    setInput('');
    sendQuestion(text, true);
  };

  const handleRetry = (messageId: string, question: string) => {
    if (isSending) return;
    // Drop the failed bubble — a fresh assistant reply (success or another
    // error) will be appended once the retry resolves.
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
    sendQuestion(question, false);
  };

  const handlePromptTap = (prompt: string) => {
    setInput(prompt);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
        <Pressable onPress={() => navigation.goBack()} style={styles.backButton} hitSlop={12}>
          <Ionicons name="arrow-back" size={22} color="#8A96A3" />
          <Text style={styles.backText}>Back</Text>
        </Pressable>

        <View style={styles.header}>
          <View style={styles.headerTitleRow}>
            <View style={styles.headerIconBadge}>
              <Ionicons name="sparkles" size={18} color="#8A5CF5" />
            </View>
            <Text style={styles.headerTitle}>ProdPulse AI</Text>
          </View>
          <Text style={styles.headerGreeting}>Ask me anything about your production data.</Text>
        </View>

        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.chatArea}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        >
          {messages.length === 0 ? (
            <View style={styles.chatEmpty}>
              <View style={styles.chatEmptyIconBadge}>
                <Ionicons name="chatbubble-ellipses-outline" size={30} color="#8A5CF5" />
              </View>
              <Text style={styles.chatEmptyTitle}>Your conversation will appear here</Text>
              <Text style={styles.chatEmptySubtitle}>Try one of the prompts below, or type your own question.</Text>

              <View style={styles.examplesList}>
                {EXAMPLE_PROMPTS.map((prompt) => (
                  <Pressable key={prompt} onPress={() => handlePromptTap(prompt)} style={styles.exampleChip}>
                    <Ionicons name="sparkles-outline" size={13} color="#8A5CF5" />
                    <Text style={styles.exampleChipText}>{prompt}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : (
            messages.map((m) => (
              <View key={m.id} style={[styles.messageRow, m.role === 'user' ? styles.messageRowUser : styles.messageRowAssistant]}>
                {m.role === 'assistant' && (
                  <View style={styles.avatarBadge}>
                    <Ionicons name="sparkles" size={13} color="#8A5CF5" />
                  </View>
                )}
                <View
                  style={[
                    styles.messageBubble,
                    m.role === 'user' ? styles.messageBubbleUser : styles.messageBubbleAssistant,
                    m.isError && styles.messageBubbleError,
                  ]}
                >
                  <Text style={[styles.messageText, m.role === 'user' && styles.messageTextUser]}>{m.text}</Text>
                  {m.isError && m.retryQuestion && (
                    <Pressable
                      onPress={() => handleRetry(m.id, m.retryQuestion as string)}
                      disabled={isSending}
                      style={({ pressed }) => [styles.retryButton, pressed && styles.retryButtonPressed]}
                      hitSlop={8}
                    >
                      <Ionicons name="refresh" size={13} color="#8A5CF5" />
                      <Text style={styles.retryButtonText}>Retry</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            ))
          )}

          {isSending && (
            <View style={[styles.messageRow, styles.messageRowAssistant]}>
              <View style={styles.avatarBadge}>
                <Ionicons name="sparkles" size={13} color="#8A5CF5" />
              </View>
              <View style={[styles.messageBubble, styles.messageBubbleAssistant, styles.typingBubble]}>
                <ActivityIndicator size="small" color="#8A5CF5" />
                <Text style={styles.typingText}>ProdPulse AI is thinking…</Text>
              </View>
            </View>
          )}
        </ScrollView>

        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder="Type your question…"
            placeholderTextColor="#5C6670"
            multiline
            editable={!isSending}
            onSubmitEditing={handleSend}
          />
          <Pressable
            onPress={handleSend}
            disabled={!input.trim() || isSending}
            style={[styles.sendButton, (!input.trim() || isSending) && styles.sendButtonDisabled]}
          >
            {isSending ? (
              <ActivityIndicator size="small" color="#14181C" />
            ) : (
              <Ionicons name="arrow-up" size={20} color="#14181C" />
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#14181C' },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 20, marginTop: 12 },
  backText: { color: '#8A96A3', fontSize: 15 },

  header: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 10 },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerIconBadge: {
    width: 32, height: 32, borderRadius: 10, backgroundColor: '#8A5CF522',
    borderWidth: 1, borderColor: '#8A5CF555', alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { color: '#ECEFF2', fontSize: 20, fontWeight: '800' },
  headerGreeting: { color: '#8A96A3', fontSize: 13, marginTop: 6, lineHeight: 18 },

  chatArea: { flexGrow: 1, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16 },

  chatEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 30, paddingHorizontal: 10 },
  chatEmptyIconBadge: {
    width: 56, height: 56, borderRadius: 28, backgroundColor: '#8A5CF522',
    borderWidth: 1, borderColor: '#8A5CF555', alignItems: 'center', justifyContent: 'center', marginBottom: 8,
  },
  chatEmptyTitle: { color: '#ECEFF2', fontSize: 15.5, fontWeight: '700', textAlign: 'center' },
  chatEmptySubtitle: { color: '#5C6670', fontSize: 12.5, textAlign: 'center', marginTop: 2, marginBottom: 18 },

  examplesList: { width: '100%', gap: 8 },
  exampleChip: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C', borderRadius: 14,
    paddingHorizontal: 14, paddingVertical: 12,
  },
  exampleChipText: { color: '#ECEFF2', fontSize: 13.5, flex: 1, lineHeight: 18 },

  messageRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginBottom: 14, maxWidth: '100%' },
  messageRowUser: { justifyContent: 'flex-end', alignSelf: 'flex-end' },
  messageRowAssistant: { justifyContent: 'flex-start', alignSelf: 'flex-start' },

  avatarBadge: {
    width: 26, height: 26, borderRadius: 13, backgroundColor: '#8A5CF522',
    borderWidth: 1, borderColor: '#8A5CF555', alignItems: 'center', justifyContent: 'center', marginBottom: 2,
  },

  messageBubble: { maxWidth: '82%', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 12 },
  messageBubbleUser: { backgroundColor: '#8A5CF5', borderBottomRightRadius: 6 },
  messageBubbleAssistant: { backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C', borderBottomLeftRadius: 6 },
  messageBubbleError: { borderColor: '#8A5CF5' },
  messageText: { color: '#ECEFF2', fontSize: 14.5, lineHeight: 20 },
  messageTextUser: { color: '#FFFFFF' },

  retryButton: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    marginTop: 8, alignSelf: 'flex-start',
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12,
    backgroundColor: '#8A5CF522', borderWidth: 1, borderColor: '#8A5CF555',
  },
  retryButtonPressed: { opacity: 0.6 },
  retryButtonText: { color: '#8A5CF5', fontSize: 12.5, fontWeight: '600' },

  typingBubble: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  typingText: { color: '#8A96A3', fontSize: 13.5, lineHeight: 18 },

  inputRow: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 10,
    paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#2C343C',
  },
  input: {
    flex: 1, backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 20, paddingHorizontal: 16, paddingVertical: 12, color: '#ECEFF2', fontSize: 14.5,
    maxHeight: 110,
  },
  sendButton: {
    width: 42, height: 42, borderRadius: 21, backgroundColor: '#8A5CF5',
    alignItems: 'center', justifyContent: 'center',
  },
  sendButtonDisabled: { opacity: 0.35 },
});