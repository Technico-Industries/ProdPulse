// src/screens/AIAssistantScreen.tsx
//
// ProdPulse AI — admin chat over the production database. Web only: on
// Android/iOS the menu entry is hidden (constants/adminMenu webOnly) and
// this screen shows a notice instead of the chat.
//
// Sending a message calls src/services/prodPulseAI.ts's askProdPulseAI(),
// which invokes the prodPulseAI Cloud Function (functions/src). The
// backend checks the user is an active admin, runs read-only production
// queries with the app's own calculations, and asks Gemini to explain them.
// Nothing AI- or Firestore-related happens in this file and no API key
// ever appears here.
//
// What the user sees is kept apart:
//   • "Database result" cards — ResultBlocks computed by the backend. Their
//     tables, metrics and Excel export are exactly what the database
//     returned; the model cannot change them.
//   • "AI summary" text — the model's interpretation of those results.
// An answer with no successful query is labelled as such, and a failed
// request shows an error with Retry — never a fabricated reply.

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
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { BarChart } from 'react-native-gifted-charts';
import { askProdPulseAI, ProdPulseAIError } from '../services/prodPulseAI';
import {
  AI_LIMITS,
  AIErrorCategory,
  AIHistoryMessage,
  Cell,
  ColumnKind,
  isProdPulseAIAvailable,
  ProdPulseAIResponse,
  ResultBlock,
} from '../utils/prodPulseAI';
import { exportResultToExcel } from '../utils/prodPulseAIExcelExport';

const ACCENT = '#8A5CF5';

const SUGGESTIONS: { group: string; icon: keyof typeof Ionicons.glyphMap; prompts: string[] }[] = [
  { group: 'Daily production', icon: 'today-outline', prompts: ["What is today's total production?", 'Show production for each line yesterday.'] },
  { group: 'Target variance', icon: 'trending-down-outline', prompts: ['Which lines are below their target today?', 'Which lines have the highest target shortfall this week?'] },
  { group: 'Quality', icon: 'shield-checkmark-outline', prompts: ['Which parts have the highest rejection rate this month?', 'Compare rejection rates across shifts for the last 7 days.'] },
  { group: 'Downtime', icon: 'pause-circle-outline', prompts: ['Which lines experienced the most downtime this week?', 'What were the most common stoppage reasons this month?'] },
  { group: 'Model / part', icon: 'cube-outline', prompts: ['Which models produced the most parts this month?', 'Compare production this week with last week.'] },
];

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  response?: ProdPulseAIResponse;
  // Set only on a failed request — the bubble shows the error and, when the
  // failure is retryable, a Retry that re-sends `question`.
  error?: { message: string; retryable: boolean; category: AIErrorCategory; reason?: string; question: string };
}

let idSeq = 0;
const newId = () => `${Date.now()}-${++idSeq}`;

// Earlier turns sent as context (text only — never result rows), newest
// kept, within the backend's limits.
function historyFor(messages: ChatMessage[]): AIHistoryMessage[] {
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

// ─── Formatting ──────────────────────────────────────────────────────────────

function formatCell(v: Cell, kind: ColumnKind): string {
  if (v == null || v === '') return '—';
  if (typeof v !== 'number') return String(v);
  const n = v.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (kind === 'percent') return `${n}%`;
  if (kind === 'minutes') return `${n} min`;
  return n;
}

// Minimal rich text for the AI summary: "- " / "* " bullets and **bold**.
function SummaryText({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <View style={{ gap: 4 }}>
      {lines.map((line, i) => {
        if (!line.trim()) return <View key={i} style={{ height: 4 }} />;
        const bullet = /^\s*[-*•]\s+/.test(line);
        const body = bullet ? line.replace(/^\s*[-*•]\s+/, '') : line.replace(/^#+\s*/, '');
        const parts = body.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
        const content = parts.map((p, j) =>
          p.startsWith('**') && p.endsWith('**') ? (
            <Text key={j} style={{ fontWeight: '700' }}>{p.slice(2, -2)}</Text>
          ) : (
            <Text key={j}>{p}</Text>
          )
        );
        return bullet ? (
          <View key={i} style={styles.bulletRow}>
            <Text style={styles.messageText}>•</Text>
            <Text style={[styles.messageText, { flex: 1 }]}>{content}</Text>
          </View>
        ) : (
          <Text key={i} style={styles.messageText}>{content}</Text>
        );
      })}
    </View>
  );
}

// ─── Result card ─────────────────────────────────────────────────────────────

function ResultCard({ block, generatedAt, chartWidth }: { block: ResultBlock; generatedAt: string; chartWidth: number }) {
  const [showDetails, setShowDetails] = useState(false);
  const [exportState, setExportState] = useState<'idle' | 'done' | 'error'>('idle');

  const handleExport = () => {
    try {
      exportResultToExcel(block, generatedAt);
      setExportState('done');
    } catch (e) {
      console.error('[AIAssistantScreen] export failed', e);
      setExportState('error');
    }
  };

  const filters = Object.entries(block.filters);
  const range = block.dateRange
    ? `${block.dateRange.from === block.dateRange.to ? block.dateRange.from : `${block.dateRange.from} → ${block.dateRange.to}`} · ${block.dateRange.convention === 'production-date' ? 'production date' : 'calendar date'}`
    : null;

  const chartColumn = block.chart ? block.columns.find((c) => c.key === block.chart!.valueKey) : null;
  const chartData = block.chart
    ? block.rows
        .filter((r) => typeof r[block.chart!.valueKey] === 'number')
        .map((r) => ({
          value: r[block.chart!.valueKey] as number,
          label: String(r[block.chart!.labelKey] ?? '').slice(0, 10),
          frontColor: ACCENT,
          labelTextStyle: { color: '#8A96A3', fontSize: 9.5 },
        }))
    : [];

  return (
    <View style={styles.resultCard}>
      <View style={styles.resultHeader}>
        <View style={styles.dbBadge}>
          <Ionicons name="server-outline" size={11} color="#4C9A6A" />
          <Text style={styles.dbBadgeText}>Database result</Text>
        </View>
        {!block.complete && (
          <View style={styles.warnBadge}>
            <Ionicons name="alert-circle-outline" size={11} color="#F2A93B" />
            <Text style={styles.warnBadgeText}>Has data notes</Text>
          </View>
        )}
      </View>
      <Text style={styles.resultTitle}>{block.title}</Text>
      {range && <Text style={styles.resultMeta}>{range}</Text>}
      {filters.length > 0 && (
        <View style={styles.chipRow}>
          {filters.map(([k, v]) => (
            <View key={k} style={styles.filterChip}>
              <Text style={styles.filterChipText}>{k}: {v}</Text>
            </View>
          ))}
        </View>
      )}

      {block.metrics.length > 0 && (
        <View style={styles.metricGrid}>
          {block.metrics.map((m) => (
            <View key={m.label} style={styles.metricCard}>
              <Text style={styles.metricValue}>{formatCell(m.value, m.kind)}</Text>
              <Text style={styles.metricLabel}>{m.label}</Text>
            </View>
          ))}
        </View>
      )}

      {chartData.length > 1 && chartColumn && (
        <View style={styles.chartWrap}>
          <Text style={styles.sectionLabel}>{chartColumn.label}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator>
            <BarChart
              data={chartData}
              barWidth={22}
              spacing={18}
              height={170}
              width={Math.max(chartWidth, chartData.length * 40 + 40)}
              noOfSections={4}
              yAxisTextStyle={{ color: '#8A96A3', fontSize: 10 }}
              xAxisColor="#2C343C"
              yAxisColor="#2C343C"
              rulesColor="#232A31"
              isAnimated={false}
            />
          </ScrollView>
        </View>
      )}

      {block.columns.length > 0 && (
        <ScrollView horizontal style={styles.tableScroll} showsHorizontalScrollIndicator>
          <View>
            <View style={[styles.tr, styles.trHead]}>
              {block.columns.map((c) => (
                <Text key={c.key} style={[styles.th, c.kind !== 'text' && styles.cellNum]}>{c.label}</Text>
              ))}
            </View>
            {block.rows.length === 0 ? (
              <Text style={styles.emptyTable}>No records matched.</Text>
            ) : (
              block.rows.map((r, i) => (
                <View key={i} style={[styles.tr, i % 2 === 1 && styles.trAlt]}>
                  {block.columns.map((c) => {
                    const v = r[c.key];
                    const negative = c.key === 'variance' && typeof v === 'number' && v < 0;
                    return (
                      <Text key={c.key} style={[styles.td, c.kind !== 'text' && styles.cellNum, negative && { color: '#D64545' }]}>
                        {formatCell(v, c.kind)}
                      </Text>
                    );
                  })}
                </View>
              ))
            )}
          </View>
        </ScrollView>
      )}
      {block.truncatedRows > 0 && (
        <Text style={styles.noteText}>{block.truncatedRows} more row(s) not shown — narrow the question to see them.</Text>
      )}

      {block.notes.length > 0 && (
        <View style={styles.notesBox}>
          {block.notes.map((n, i) => (
            <View key={i} style={styles.bulletRow}>
              <Ionicons name="information-circle-outline" size={13} color="#F2A93B" style={{ marginTop: 2 }} />
              <Text style={[styles.noteText, { flex: 1 }]}>{n}</Text>
            </View>
          ))}
        </View>
      )}

      <View style={styles.cardActions}>
        <Pressable onPress={() => setShowDetails((v) => !v)} style={styles.linkButton} hitSlop={6}>
          <Ionicons name={showDetails ? 'chevron-up' : 'chevron-down'} size={13} color="#8A96A3" />
          <Text style={styles.linkButtonText}>How this is calculated</Text>
        </Pressable>
        {block.columns.length > 0 && (
          <Pressable onPress={handleExport} style={({ pressed }) => [styles.exportButton, pressed && { opacity: 0.6 }]}>
            <Ionicons name={exportState === 'done' ? 'checkmark' : 'download-outline'} size={14} color="#4C9A6A" />
            <Text style={styles.exportButtonText}>
              {exportState === 'done' ? 'Downloaded' : exportState === 'error' ? 'Export failed — retry' : 'Export to Excel'}
            </Text>
          </Pressable>
        )}
      </View>
      {showDetails && (
        <View style={styles.detailsBox}>
          <Text style={styles.detailText}>Source: {block.source}</Text>
          {block.definitions.map((d, i) => (
            <Text key={i} style={styles.detailText}>• {d}</Text>
          ))}
        </View>
      )}
    </View>
  );
}

// ─── Screen ──────────────────────────────────────────────────────────────────

function NativeNotice() {
  const navigation = useNavigation<any>();
  return (
    <SafeAreaView style={styles.safeArea}>
      <Pressable onPress={() => navigation.goBack()} style={styles.backButton} hitSlop={12}>
        <Ionicons name="arrow-back" size={22} color="#8A96A3" />
        <Text style={styles.backText}>Back</Text>
      </Pressable>
      <View style={styles.chatEmpty}>
        <View style={styles.chatEmptyIconBadge}>
          <Ionicons name="desktop-outline" size={28} color={ACCENT} />
        </View>
        <Text style={styles.chatEmptyTitle}>ProdPulse AI is available on the web app</Text>
        <Text style={styles.chatEmptySubtitle}>Open ProdPulse in a browser and sign in with an admin account to use it.</Text>
      </View>
    </SafeAreaView>
  );
}

export default function AIAssistantScreen() {
  if (!isProdPulseAIAvailable(Platform.OS)) return <NativeNotice />;
  return <AIChat />;
}

function AIChat() {
  const navigation = useNavigation<any>();
  const { width } = useWindowDimensions();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  // Bumped by "New conversation" so a reply still in flight for the old
  // conversation is dropped instead of appearing in the new one.
  const conversationRef = useRef(0);

  const contentWidth = Math.min(width, 980);
  const chartWidth = Math.max(240, contentWidth - 120);

  useEffect(() => {
    if (messages.length === 0 && !isSending) return;
    const t = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
    return () => clearTimeout(t);
  }, [messages.length, isSending]);

  // Shared by the composer, the suggestions and Retry. `prior` is the
  // conversation the question is asked in (without the question itself).
  const sendQuestion = (text: string, prior: ChatMessage[], appendUserBubble: boolean) => {
    if (isSending) return;
    const conversation = conversationRef.current;
    if (appendUserBubble) setMessages([...prior, { id: newId(), role: 'user', text }]);
    setIsSending(true);

    askProdPulseAI(text, historyFor(prior))
      .then((response) => {
        if (conversation !== conversationRef.current) return;
        setMessages((prev) => [...prev, { id: newId(), role: 'assistant', text: response.reply.trim(), response }]);
      })
      .catch((err) => {
        if (conversation !== conversationRef.current) return;
        const e = err instanceof ProdPulseAIError ? err : new ProdPulseAIError("Sorry, I couldn't retrieve that information. Please try again.", true, 'INVALID_RESPONSE');
        setMessages((prev) => [
          ...prev,
          { id: newId(), role: 'assistant', text: '', error: { message: e.message, retryable: e.retryable, category: e.category, reason: e.reason, question: text } },
        ]);
      })
      .finally(() => {
        if (conversation === conversationRef.current) setIsSending(false);
      });
  };

  const handleSend = (raw = input) => {
    const text = raw.trim();
    if (!text || isSending) return;
    setInput('');
    sendQuestion(text, messages, true);
  };

  const handleRetry = (messageId: string, question: string) => {
    if (isSending) return;
    // Drop the failed bubble; the user's question stays above it.
    const idx = messages.findIndex((m) => m.id === messageId);
    const remaining = messages.filter((m) => m.id !== messageId);
    setMessages(remaining);
    // Context = everything before the question being retried.
    const prior = messages.slice(0, Math.max(0, idx - 1));
    sendQuestion(question, prior, false);
  };

  const handleNewConversation = () => {
    conversationRef.current++;
    setMessages([]);
    setInput('');
    setIsSending(false);
  };

  // Web: Enter sends, Shift+Enter inserts a newline.
  const handleKeyPress = (e: any) => {
    if (Platform.OS !== 'web') return;
    const ne = e?.nativeEvent ?? {};
    if (ne.key === 'Enter' && !ne.shiftKey && !ne.isComposing) {
      e.preventDefault?.();
      handleSend();
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
        <View style={[styles.column, { maxWidth: 980 }]}>
          <View style={styles.topBar}>
            <Pressable onPress={() => navigation.goBack()} style={styles.backButtonInline} hitSlop={12}>
              <Ionicons name="arrow-back" size={22} color="#8A96A3" />
              <Text style={styles.backText}>Back</Text>
            </Pressable>
            <Pressable
              onPress={handleNewConversation}
              disabled={messages.length === 0 && !isSending}
              style={({ pressed }) => [styles.newChatButton, (messages.length === 0 && !isSending) && { opacity: 0.4 }, pressed && { opacity: 0.6 }]}
              accessibilityLabel="Start a new conversation"
            >
              <Ionicons name="add" size={16} color={ACCENT} />
              <Text style={styles.newChatText}>New conversation</Text>
            </Pressable>
          </View>

          <View style={styles.header}>
            <View style={styles.headerTitleRow}>
              <View style={styles.headerIconBadge}>
                <Ionicons name="sparkles" size={18} color={ACCENT} />
              </View>
              <Text style={styles.headerTitle}>ProdPulse AI</Text>
            </View>
            <Text style={styles.headerGreeting}>
              Answers questions from your live production records — production, targets, rejections and downtime. Figures come straight
              from the database; the AI explains them.
            </Text>
          </View>

          <ScrollView ref={scrollRef} contentContainerStyle={styles.chatArea} keyboardShouldPersistTaps="handled">
            {messages.length === 0 ? (
              <View style={styles.chatEmpty}>
                <View style={styles.chatEmptyIconBadge}>
                  <Ionicons name="chatbubble-ellipses-outline" size={30} color={ACCENT} />
                </View>
                <Text style={styles.chatEmptyTitle}>Ask about your production data</Text>
                <Text style={styles.chatEmptySubtitle}>Pick a suggestion or type your own question.</Text>
                <View style={styles.suggestGrid}>
                  {SUGGESTIONS.map((s) => (
                    <View key={s.group} style={[styles.suggestGroup, { width: contentWidth > 700 ? '48%' : '100%' }]}>
                      <View style={styles.suggestGroupHead}>
                        <Ionicons name={s.icon} size={14} color={ACCENT} />
                        <Text style={styles.suggestGroupTitle}>{s.group}</Text>
                      </View>
                      {s.prompts.map((p) => (
                        <Pressable key={p} onPress={() => handleSend(p)} disabled={isSending} style={({ pressed }) => [styles.exampleChip, pressed && { opacity: 0.6 }]}>
                          <Text style={styles.exampleChipText}>{p}</Text>
                          <Ionicons name="arrow-forward" size={13} color="#5C6670" />
                        </Pressable>
                      ))}
                    </View>
                  ))}
                </View>
              </View>
            ) : (
              messages.map((m) =>
                m.role === 'user' ? (
                  <View key={m.id} style={[styles.messageRow, styles.messageRowUser]}>
                    <View style={[styles.messageBubble, styles.messageBubbleUser]}>
                      <Text style={[styles.messageText, styles.messageTextUser]}>{m.text}</Text>
                    </View>
                  </View>
                ) : m.error ? (
                  <View key={m.id} style={[styles.messageRow, styles.messageRowAssistant]}>
                    <View style={styles.avatarBadge}>
                      <Ionicons name="alert" size={13} color="#D64545" />
                    </View>
                    <View style={[styles.messageBubble, styles.messageBubbleAssistant, styles.messageBubbleError]}>
                      <Text style={styles.messageText}>{m.error.message}</Text>
                      <Text style={styles.errorCode}>Error code: {m.error.category}{m.error.reason ? ` · ${m.error.reason}` : ''}</Text>
                      {m.error.retryable && (
                        <Pressable
                          onPress={() => handleRetry(m.id, m.error!.question)}
                          disabled={isSending}
                          style={({ pressed }) => [styles.retryButton, pressed && { opacity: 0.6 }]}
                          hitSlop={8}
                        >
                          <Ionicons name="refresh" size={13} color={ACCENT} />
                          <Text style={styles.retryButtonText}>Retry</Text>
                        </Pressable>
                      )}
                    </View>
                  </View>
                ) : (
                  <View key={m.id} style={styles.answerBlock}>
                    {(m.response?.results ?? []).map((b) => (
                      <ResultCard key={b.id} block={b} generatedAt={m.response!.generatedAt} chartWidth={chartWidth} />
                    ))}
                    {(m.response?.toolErrors ?? []).length > 0 && (
                      <View style={styles.toolErrorBox}>
                        <Ionicons name="warning-outline" size={14} color="#D64545" />
                        <Text style={[styles.noteText, { flex: 1, color: '#E8A0A0' }]}>
                          Some data could not be retrieved: {m.response!.toolErrors.map((t) => t.message).join(' ')}
                        </Text>
                      </View>
                    )}
                    <View style={styles.summaryBubble}>
                      <View style={styles.summaryHead}>
                        <Ionicons name="sparkles" size={12} color={ACCENT} />
                        <Text style={styles.summaryHeadText}>AI summary</Text>
                        {!m.response?.dataRetrieved && <Text style={styles.noDataTag}>No database results in this answer</Text>}
                      </View>
                      <SummaryText text={m.text} />
                    </View>
                  </View>
                )
              )
            )}

            {isSending && (
              <View style={[styles.messageRow, styles.messageRowAssistant]}>
                <View style={styles.avatarBadge}>
                  <Ionicons name="sparkles" size={13} color={ACCENT} />
                </View>
                <View style={[styles.messageBubble, styles.messageBubbleAssistant, styles.typingBubble]}>
                  <ActivityIndicator size="small" color={ACCENT} />
                  <Text style={styles.typingText}>Querying production data…</Text>
                </View>
              </View>
            )}
          </ScrollView>

          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              value={input}
              onChangeText={setInput}
              onKeyPress={handleKeyPress}
              placeholder="Ask about production, targets, rejections, downtime…"
              placeholderTextColor="#5C6670"
              multiline
              maxLength={AI_LIMITS.maxQuestionChars}
              editable={!isSending}
            />
            <Pressable
              onPress={() => handleSend()}
              disabled={!input.trim() || isSending}
              style={[styles.sendButton, (!input.trim() || isSending) && styles.sendButtonDisabled]}
              accessibilityLabel="Send"
            >
              {isSending ? <ActivityIndicator size="small" color="#14181C" /> : <Ionicons name="arrow-up" size={20} color="#14181C" />}
            </Pressable>
          </View>
          <Text style={styles.composerHint}>Enter to send · Shift+Enter for a new line · Read-only: ProdPulse AI never changes data</Text>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#14181C' },
  column: { flex: 1, width: '100%', alignSelf: 'center' },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, marginTop: 12 },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 20, marginTop: 12 },
  backButtonInline: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  backText: { color: '#8A96A3', fontSize: 15 },
  newChatButton: {
    flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingVertical: 7,
    borderRadius: 14, borderWidth: 1, borderColor: '#8A5CF555', backgroundColor: '#8A5CF51A',
  },
  newChatText: { color: ACCENT, fontSize: 13, fontWeight: '600' },

  header: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 10 },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerIconBadge: {
    width: 32, height: 32, borderRadius: 10, backgroundColor: '#8A5CF522',
    borderWidth: 1, borderColor: '#8A5CF555', alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { color: '#ECEFF2', fontSize: 20, fontWeight: '800' },
  headerGreeting: { color: '#8A96A3', fontSize: 13, marginTop: 6, lineHeight: 18 },

  chatArea: { flexGrow: 1, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16 },

  chatEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 24, paddingHorizontal: 10 },
  chatEmptyIconBadge: {
    width: 56, height: 56, borderRadius: 28, backgroundColor: '#8A5CF522',
    borderWidth: 1, borderColor: '#8A5CF555', alignItems: 'center', justifyContent: 'center', marginBottom: 8,
  },
  chatEmptyTitle: { color: '#ECEFF2', fontSize: 15.5, fontWeight: '700', textAlign: 'center' },
  chatEmptySubtitle: { color: '#5C6670', fontSize: 12.5, textAlign: 'center', marginTop: 2, marginBottom: 16 },

  suggestGrid: { width: '100%', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12 },
  suggestGroup: { gap: 6 },
  suggestGroupHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  suggestGroupTitle: { color: '#8A96A3', fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  exampleChip: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C', borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 11,
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
  messageBubbleUser: { backgroundColor: ACCENT, borderBottomRightRadius: 6 },
  messageBubbleAssistant: { backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C', borderBottomLeftRadius: 6 },
  messageBubbleError: { borderColor: '#D6454577' },
  messageText: { color: '#ECEFF2', fontSize: 14.5, lineHeight: 21 },
  messageTextUser: { color: '#FFFFFF' },
  bulletRow: { flexDirection: 'row', gap: 6, alignItems: 'flex-start' },

  answerBlock: { marginBottom: 18, gap: 10, width: '100%' },
  summaryBubble: { backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C', borderRadius: 16, padding: 14 },
  summaryHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' },
  summaryHeadText: { color: ACCENT, fontSize: 11.5, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  noDataTag: {
    color: '#F2A93B', fontSize: 11, borderWidth: 1, borderColor: '#F2A93B55', borderRadius: 8,
    paddingHorizontal: 6, paddingVertical: 1, marginLeft: 4,
  },

  resultCard: { backgroundColor: '#181D22', borderWidth: 1, borderColor: '#2C343C', borderRadius: 16, padding: 14, gap: 8 },
  resultHeader: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  dbBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2,
    backgroundColor: '#4C9A6A1F', borderWidth: 1, borderColor: '#4C9A6A55',
  },
  dbBadgeText: { color: '#4C9A6A', fontSize: 11, fontWeight: '700' },
  warnBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2,
    backgroundColor: '#F2A93B1A', borderWidth: 1, borderColor: '#F2A93B55',
  },
  warnBadgeText: { color: '#F2A93B', fontSize: 11, fontWeight: '700' },
  resultTitle: { color: '#ECEFF2', fontSize: 15, fontWeight: '700' },
  resultMeta: { color: '#8A96A3', fontSize: 12 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  filterChip: { backgroundColor: '#232A31', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  filterChipText: { color: '#C3CBD3', fontSize: 11.5 },

  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  metricCard: { backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, minWidth: 130, flexGrow: 1 },
  metricValue: { color: '#ECEFF2', fontSize: 17, fontWeight: '800' },
  metricLabel: { color: '#8A96A3', fontSize: 11.5, marginTop: 2 },

  chartWrap: { marginTop: 4, gap: 6 },
  sectionLabel: { color: '#8A96A3', fontSize: 11.5, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },

  tableScroll: { marginTop: 4, borderWidth: 1, borderColor: '#2C343C', borderRadius: 10 },
  tr: { flexDirection: 'row' },
  trHead: { backgroundColor: '#232A31' },
  trAlt: { backgroundColor: '#1B2026' },
  th: { color: '#C3CBD3', fontSize: 12, fontWeight: '700', paddingHorizontal: 10, paddingVertical: 8, width: 128 },
  td: { color: '#ECEFF2', fontSize: 12.5, paddingHorizontal: 10, paddingVertical: 7, width: 128 },
  cellNum: { textAlign: 'right' },
  emptyTable: { color: '#8A96A3', fontSize: 12.5, padding: 12 },

  notesBox: { gap: 4, marginTop: 2 },
  noteText: { color: '#C9B48A', fontSize: 12, lineHeight: 17 },
  toolErrorBox: {
    flexDirection: 'row', gap: 6, alignItems: 'flex-start', padding: 10, borderRadius: 12,
    backgroundColor: '#D645451A', borderWidth: 1, borderColor: '#D6454555',
  },

  cardActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, flexWrap: 'wrap', gap: 8 },
  linkButton: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  linkButtonText: { color: '#8A96A3', fontSize: 12.5 },
  exportButton: {
    flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10,
    backgroundColor: '#4C9A6A1A', borderWidth: 1, borderColor: '#4C9A6A55',
  },
  exportButtonText: { color: '#4C9A6A', fontSize: 12.5, fontWeight: '600' },
  detailsBox: { backgroundColor: '#1D2329', borderRadius: 10, padding: 10, gap: 4 },
  detailText: { color: '#8A96A3', fontSize: 12, lineHeight: 17 },

  retryButton: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    marginTop: 8, alignSelf: 'flex-start',
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12,
    backgroundColor: '#8A5CF522', borderWidth: 1, borderColor: '#8A5CF555',
  },
  retryButtonText: { color: ACCENT, fontSize: 12.5, fontWeight: '600' },
  errorCode: { color: '#5C6670', fontSize: 11, marginTop: 6 },

  typingBubble: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  typingText: { color: '#8A96A3', fontSize: 13.5, lineHeight: 18 },

  inputRow: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 10,
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6, borderTopWidth: 1, borderTopColor: '#2C343C',
  },
  input: {
    flex: 1, backgroundColor: '#1D2329', borderWidth: 1, borderColor: '#2C343C',
    borderRadius: 20, paddingHorizontal: 16, paddingVertical: 12, color: '#ECEFF2', fontSize: 14.5,
    maxHeight: 140,
  },
  sendButton: {
    width: 42, height: 42, borderRadius: 21, backgroundColor: ACCENT,
    alignItems: 'center', justifyContent: 'center',
  },
  sendButtonDisabled: { opacity: 0.35 },
  composerHint: { color: '#5C6670', fontSize: 11, textAlign: 'center', paddingBottom: 10, paddingHorizontal: 16 },
});
