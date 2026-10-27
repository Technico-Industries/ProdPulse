// src/screens/AIAssistantScreen.tsx
//
// Prod AI — admin chat over the production database. Web only: on
// Android/iOS the floating Prod AI button (components/ProdAIButton) is
// hidden and this screen shows a notice instead of the chat.
//
// The chat (ProdAIChat below) is normally opened as a popup over the Admin
// Overview (components/ProdAIPanel). This route (/ai-assistant) renders the
// same chat full-screen, so an old link or bookmark still works. Both read
// the one conversation in stores/prodAIStore, so closing the popup — even
// mid-request — keeps the conversation for the rest of the app session.
//
// Sending a message calls src/services/prodPulseAI.ts's askProdPulseAI()
// (via the store), which invokes the prodPulseAI Cloud Function
// (functions/src). The backend checks the user is an active admin, runs
// read-only production queries with the app's own calculations, and asks
// Gemini to explain them. Nothing AI- or Firestore-related happens in this
// file and no API key ever appears here.
//
// What the user sees is kept apart:
//   • "Database result" cards — ResultBlocks computed by the backend. Their
//     tables, metrics and Excel export are exactly what the database
//     returned; the model cannot change them.
//   • "AI summary" text — the model's interpretation of those results.
// An answer with no successful query is labelled as such, and a failed
// request shows an error with Retry — never a fabricated reply.
//
// Look: minimal monochrome (AI_THEME) — near-black surfaces, white text and
// primary actions, grey for secondary text, hover, pressed and focus.

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
  LayoutChangeEvent,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { BarChart } from 'react-native-gifted-charts';
import { AI_LIMITS, Cell, ColumnKind, isProdPulseAIAvailable, ResultBlock } from '../utils/prodPulseAI';
import { exportResultToExcel } from '../utils/prodPulseAIExcelExport';
import { ChatMessage } from '../utils/prodAIConversation';
import { prodAIConversation, useProdAI } from '../stores/prodAIStore';
import { useAuthStore } from '../stores/authStore';
import ProdAIThinking, { ProdAIBrain } from '../components/ProdAIThinking';

export const AI_THEME = {
  bg: '#0B0B0B',
  surface: '#151515',
  surface2: '#1D1D1D',
  text: '#FFFFFF',
  textMuted: '#A3A3A3',
  border: '#2B2B2B',
  hover: '#242424',
  pressed: '#2E2E2E',
} as const;
const T = AI_THEME;

const SUGGESTIONS: string[] = [
  "What is today's total production?",
  'Which lines are below their target today?',
  'Which parts have the highest rejection rate this month?',
  'Which lines experienced the most downtime this week?',
  'Which models produced the most parts this month?',
  'Compare production this week with last week.',
];

// Grey hover / pressed and a visible white keyboard-focus ring (web), for
// every Pressable in the chat. `hovered` / `focused` only exist on web.
type PressState = { pressed: boolean; hovered?: boolean; focused?: boolean };
export function pressFeedback({ pressed, hovered, focused }: PressState, base?: object) {
  return [
    base,
    hovered && { backgroundColor: T.hover },
    pressed && { backgroundColor: T.pressed },
    focused && Platform.OS === 'web' && ({ outlineColor: T.text, outlineWidth: 2, outlineStyle: 'solid', outlineOffset: 1 } as any),
  ];
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
          frontColor: '#E5E5E5',
          labelTextStyle: { color: T.textMuted, fontSize: 9.5 },
        }))
    : [];

  return (
    <View style={styles.resultCard}>
      <View style={styles.resultHeader}>
        <View style={styles.tag}>
          <Ionicons name="server-outline" size={11} color={T.textMuted} />
          <Text style={styles.tagText}>Database result</Text>
        </View>
        {!block.complete && (
          <View style={styles.tag}>
            <Ionicons name="alert-circle-outline" size={11} color={T.text} />
            <Text style={[styles.tagText, { color: T.text }]}>Has data notes</Text>
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
              barWidth={18}
              spacing={14}
              height={150}
              width={Math.max(chartWidth, chartData.length * 34 + 40)}
              noOfSections={4}
              yAxisTextStyle={{ color: T.textMuted, fontSize: 10 }}
              xAxisColor={T.border}
              yAxisColor={T.border}
              rulesColor={T.surface2}
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
                  {block.columns.map((c) => (
                    <Text key={c.key} style={[styles.td, c.kind !== 'text' && styles.cellNum]}>
                      {formatCell(r[c.key], c.kind)}
                    </Text>
                  ))}
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
              <Ionicons name="information-circle-outline" size={13} color={T.textMuted} style={{ marginTop: 2 }} />
              <Text style={[styles.noteText, { flex: 1 }]}>{n}</Text>
            </View>
          ))}
        </View>
      )}

      <View style={styles.cardActions}>
        <Pressable
          onPress={() => setShowDetails((v) => !v)}
          style={(s) => pressFeedback(s, styles.linkButton)}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityState={{ expanded: showDetails }}
        >
          <Ionicons name={showDetails ? 'chevron-up' : 'chevron-down'} size={13} color={T.textMuted} />
          <Text style={styles.linkButtonText}>How this is calculated</Text>
        </Pressable>
        {block.columns.length > 0 && (
          <Pressable onPress={handleExport} style={(s) => pressFeedback(s, styles.ghostButton)} accessibilityRole="button">
            <Ionicons name={exportState === 'done' ? 'checkmark' : 'download-outline'} size={14} color={T.text} />
            <Text style={styles.ghostButtonText}>
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

// ─── Chat ────────────────────────────────────────────────────────────────────

function MessageView({ m, chartWidth, isSending }: { m: ChatMessage; chartWidth: number; isSending: boolean }) {
  if (m.role === 'user') {
    return (
      <View style={[styles.messageRow, styles.messageRowUser]}>
        <View style={styles.userBubble}>
          <Text style={styles.messageText}>{m.text}</Text>
        </View>
      </View>
    );
  }
  if (m.error) {
    const err = m.error;
    return (
      <View style={[styles.messageRow, styles.messageRowAssistant]} accessibilityLiveRegion="polite">
        <View style={styles.errorBox}>
          <View style={styles.bulletRow}>
            <Ionicons name="alert-circle-outline" size={16} color={T.text} style={{ marginTop: 2 }} />
            <Text style={[styles.messageText, { flex: 1 }]}>{err.message}</Text>
          </View>
          <Text style={styles.errorCode}>Error code: {err.category}{err.reason ? ` · ${err.reason}` : ''}</Text>
          {err.retryable && (
            <Pressable
              onPress={() => prodAIConversation.getState().retry(m.id)}
              disabled={isSending}
              style={(s) => pressFeedback(s, [styles.ghostButton, { alignSelf: 'flex-start', marginTop: 8 }, isSending && { opacity: 0.4 }])}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Retry this question"
            >
              <Ionicons name="refresh" size={13} color={T.text} />
              <Text style={styles.ghostButtonText}>Retry</Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  }
  return (
    <View style={styles.answerBlock}>
      {(m.response?.results ?? []).map((b) => (
        <ResultCard key={b.id} block={b} generatedAt={m.response!.generatedAt} chartWidth={chartWidth} />
      ))}
      {(m.response?.toolErrors ?? []).length > 0 && (
        <View style={styles.errorBox}>
          <View style={styles.bulletRow}>
            <Ionicons name="warning-outline" size={14} color={T.text} style={{ marginTop: 2 }} />
            <Text style={[styles.noteText, { flex: 1, color: T.text }]}>
              Some data could not be retrieved: {m.response!.toolErrors.map((t) => t.message).join(' ')}
            </Text>
          </View>
        </View>
      )}
      <View style={styles.summary}>
        <View style={styles.summaryHead}>
          <ProdAIBrain size={13} color={T.textMuted} />
          <Text style={styles.summaryHeadText}>AI summary</Text>
          {!m.response?.dataRetrieved && <Text style={styles.noDataTag}>No database results in this answer</Text>}
        </View>
        <SummaryText text={m.text} />
      </View>
    </View>
  );
}

// The chat, shown in the popup (`mode="panel"`, with a close button) or on
// the /ai-assistant route (`mode="screen"`, with Back).
export function ProdAIChat({ mode, onClose }: { mode: 'panel' | 'screen'; onClose: () => void }) {
  const uid = useAuthStore((s) => s.user?.uid ?? null);
  const messages = useProdAI((s) => s.messages);
  const isSending = useProdAI((s) => s.isSending);
  const draft = useProdAI((s) => s.draft);
  const scrollRef = useRef<ScrollView>(null);
  const [width, setWidth] = useState(360);
  const chartWidth = Math.max(220, width - 64);

  // A conversation never carries over to another user on this device.
  useEffect(() => {
    prodAIConversation.getState().ensureOwner(uid);
  }, [uid]);

  useEffect(() => {
    if (messages.length === 0 && !isSending) return;
    const t = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
    return () => clearTimeout(t);
  }, [messages.length, isSending]);

  const send = (text = prodAIConversation.getState().draft) => prodAIConversation.getState().send(text);

  // Web: Enter sends, Shift+Enter inserts a newline.
  const handleKeyPress = (e: any) => {
    if (Platform.OS !== 'web') return;
    const ne = e?.nativeEvent ?? {};
    if (ne.key === 'Enter' && !ne.shiftKey && !ne.isComposing) {
      e.preventDefault?.();
      send();
    }
  };

  const canSend = !!draft.trim() && !isSending;

  return (
    <View style={styles.chat} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
      <View style={styles.header}>
        {mode === 'screen' && (
          <Pressable onPress={onClose} style={(s) => pressFeedback(s, styles.iconButton)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
            <Ionicons name="arrow-back" size={18} color={T.text} />
          </Pressable>
        )}
        <ProdAIBrain size={20} />
        <Text style={styles.headerTitle} accessibilityRole="header">Prod AI</Text>
        <View style={{ flex: 1 }} />
        <Pressable
          onPress={() => prodAIConversation.getState().newConversation()}
          disabled={messages.length === 0 && !isSending}
          style={(s) => pressFeedback(s, [styles.iconButton, messages.length === 0 && !isSending && { opacity: 0.35 }])}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel="Start a new conversation"
        >
          <Ionicons name="create-outline" size={18} color={T.text} />
        </Pressable>
        {mode === 'panel' && (
          <Pressable onPress={onClose} style={(s) => pressFeedback(s, styles.iconButton)} hitSlop={6} accessibilityRole="button" accessibilityLabel="Close Prod AI">
            <Ionicons name="close" size={20} color={T.text} />
          </Pressable>
        )}
      </View>

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={styles.chatArea}
        keyboardShouldPersistTaps="handled"
      >
        {messages.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Ask about your production data</Text>
            <Text style={styles.emptySubtitle}>Production, targets, rejections and downtime. Figures come from the database; the AI explains them.</Text>
            <View style={styles.suggestions}>
              {SUGGESTIONS.map((p) => (
                <Pressable
                  key={p}
                  onPress={() => send(p)}
                  disabled={isSending}
                  style={(s) => pressFeedback(s, styles.suggestion)}
                  accessibilityRole="button"
                >
                  <Text style={styles.suggestionText}>{p}</Text>
                  <Ionicons name="arrow-forward" size={13} color={T.textMuted} />
                </Pressable>
              ))}
            </View>
          </View>
        ) : (
          messages.map((m) => <MessageView key={m.id} m={m} chartWidth={chartWidth} isSending={isSending} />)
        )}

        {isSending && (
          <View style={[styles.messageRow, styles.messageRowAssistant, { paddingVertical: 6 }]}>
            <ProdAIThinking />
          </View>
        )}
      </ScrollView>

      <View style={styles.composer}>
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={(t) => prodAIConversation.getState().setDraft(t)}
            onKeyPress={handleKeyPress}
            placeholder="Ask about production…"
            placeholderTextColor="#6B6B6B"
            multiline
            maxLength={AI_LIMITS.maxQuestionChars}
            editable={!isSending}
            autoFocus={mode === 'panel' && Platform.OS === 'web'}
            accessibilityLabel="Message Prod AI"
          />
          <Pressable
            onPress={() => send()}
            disabled={!canSend}
            style={({ pressed, focused }: PressState) => [
              styles.sendButton,
              !canSend && styles.sendButtonDisabled,
              pressed && { opacity: 0.8 },
              focused && Platform.OS === 'web' && ({ outlineColor: T.text, outlineWidth: 2, outlineStyle: 'solid', outlineOffset: 2 } as any),
            ]}
            accessibilityRole="button"
            accessibilityLabel="Send"
            accessibilityState={{ disabled: !canSend, busy: isSending }}
          >
            <Ionicons name="arrow-up" size={18} color={canSend ? '#000000' : '#6B6B6B'} />
          </Pressable>
        </View>
        <Text style={styles.composerHint}>
          {Platform.OS === 'web' ? 'Enter to send · Shift+Enter for a new line · ' : ''}Read-only: Prod AI never changes data
        </Text>
      </View>
    </View>
  );
}

// ─── Screen ──────────────────────────────────────────────────────────────────

function NativeNotice() {
  const navigation = useNavigation<any>();
  return (
    <SafeAreaView style={styles.safeArea}>
      <Pressable onPress={() => navigation.goBack()} style={styles.backButton} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back">
        <Ionicons name="arrow-back" size={22} color={T.textMuted} />
        <Text style={styles.backText}>Back</Text>
      </Pressable>
      <View style={styles.empty}>
        <ProdAIBrain size={28} />
        <Text style={styles.emptyTitle}>Prod AI is available on the web app</Text>
        <Text style={styles.emptySubtitle}>Open ProdPulse in a browser and sign in with an admin account to use it.</Text>
      </View>
    </SafeAreaView>
  );
}

export default function AIAssistantScreen() {
  const navigation = useNavigation<any>();
  if (!isProdPulseAIAvailable(Platform.OS)) return <NativeNotice />;
  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.screenColumn}>
          <ProdAIChat mode="screen" onClose={() => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Home'))} />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: T.bg },
  screenColumn: { flex: 1, width: '100%', maxWidth: 860, alignSelf: 'center' },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 16, marginTop: 12 },
  backText: { color: T.textMuted, fontSize: 15 },

  chat: { flex: 1, backgroundColor: T.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.border,
  },
  headerTitle: { color: T.text, fontSize: 15, fontWeight: '600', letterSpacing: 0.2 },
  iconButton: { width: 36, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },

  chatArea: { flexGrow: 1, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12 },

  empty: { flex: 1, justifyContent: 'center', gap: 6, paddingVertical: 16 },
  emptyTitle: { color: T.text, fontSize: 15, fontWeight: '600' },
  emptySubtitle: { color: T.textMuted, fontSize: 12.5, lineHeight: 18, marginBottom: 10 },
  suggestions: { gap: 6 },
  suggestion: {
    flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 40,
    backgroundColor: T.surface, borderWidth: 1, borderColor: T.border, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 9,
  },
  suggestionText: { color: T.text, fontSize: 13, flex: 1, lineHeight: 18 },

  messageRow: { flexDirection: 'row', marginBottom: 12, maxWidth: '100%' },
  messageRowUser: { justifyContent: 'flex-end', alignSelf: 'flex-end' },
  messageRowAssistant: { justifyContent: 'flex-start', alignSelf: 'flex-start' },
  userBubble: { maxWidth: '85%', backgroundColor: T.surface2, borderRadius: 14, borderBottomRightRadius: 4, paddingHorizontal: 13, paddingVertical: 9 },
  messageText: { color: T.text, fontSize: 14, lineHeight: 20 },
  bulletRow: { flexDirection: 'row', gap: 6, alignItems: 'flex-start' },

  answerBlock: { marginBottom: 16, gap: 8, width: '100%' },
  summary: { paddingVertical: 2 },
  summaryHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' },
  summaryHeadText: { color: T.textMuted, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.6 },
  noDataTag: {
    color: T.textMuted, fontSize: 11, borderWidth: 1, borderColor: T.border, borderRadius: 6,
    paddingHorizontal: 6, paddingVertical: 1, marginLeft: 4,
  },

  resultCard: { backgroundColor: T.surface, borderWidth: 1, borderColor: T.border, borderRadius: 12, padding: 12, gap: 8 },
  resultHeader: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  tag: {
    flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2,
    borderWidth: 1, borderColor: T.border,
  },
  tagText: { color: T.textMuted, fontSize: 11, fontWeight: '600' },
  resultTitle: { color: T.text, fontSize: 14, fontWeight: '600' },
  resultMeta: { color: T.textMuted, fontSize: 12 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  filterChip: { backgroundColor: T.surface2, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  filterChipText: { color: T.textMuted, fontSize: 11.5 },

  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 },
  metricCard: { backgroundColor: T.surface2, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, minWidth: 110, flexGrow: 1 },
  metricValue: { color: T.text, fontSize: 16, fontWeight: '700' },
  metricLabel: { color: T.textMuted, fontSize: 11, marginTop: 2 },

  chartWrap: { marginTop: 2, gap: 6 },
  sectionLabel: { color: T.textMuted, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },

  tableScroll: { marginTop: 2, borderWidth: 1, borderColor: T.border, borderRadius: 8 },
  tr: { flexDirection: 'row' },
  trHead: { backgroundColor: T.surface2 },
  trAlt: { backgroundColor: '#121212' },
  th: { color: T.textMuted, fontSize: 11.5, fontWeight: '600', paddingHorizontal: 10, paddingVertical: 7, width: 120 },
  td: { color: T.text, fontSize: 12.5, paddingHorizontal: 10, paddingVertical: 6, width: 120 },
  cellNum: { textAlign: 'right' },
  emptyTable: { color: T.textMuted, fontSize: 12.5, padding: 12 },

  notesBox: { gap: 4 },
  noteText: { color: T.textMuted, fontSize: 12, lineHeight: 17 },

  cardActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 2, flexWrap: 'wrap', gap: 8 },
  linkButton: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 6, paddingHorizontal: 4, paddingVertical: 4 },
  linkButtonText: { color: T.textMuted, fontSize: 12.5 },
  ghostButton: {
    flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8,
    borderWidth: 1, borderColor: T.border, minHeight: 32,
  },
  ghostButtonText: { color: T.text, fontSize: 12.5, fontWeight: '500' },
  detailsBox: { backgroundColor: T.surface2, borderRadius: 8, padding: 10, gap: 4 },
  detailText: { color: T.textMuted, fontSize: 12, lineHeight: 17 },

  errorBox: { borderWidth: 1, borderColor: T.border, backgroundColor: T.surface, borderRadius: 12, padding: 12, maxWidth: '92%' },
  errorCode: { color: '#6B6B6B', fontSize: 11, marginTop: 6 },

  composer: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: T.border, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: {
    flex: 1, backgroundColor: T.surface, borderWidth: 1, borderColor: T.border,
    borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, color: T.text, fontSize: 14,
    minHeight: 40, maxHeight: 120,
  },
  sendButton: { width: 40, height: 40, borderRadius: 20, backgroundColor: T.text, alignItems: 'center', justifyContent: 'center' },
  sendButtonDisabled: { backgroundColor: T.surface2 },
  composerHint: { color: '#6B6B6B', fontSize: 10.5, textAlign: 'center', marginTop: 6 },
});
