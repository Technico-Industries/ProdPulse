// src/components/OnScreenKeyboard.web.tsx
//
// Built-in on-screen keyboard for the web app (touch-screen PCs / kiosks /
// TVs with no physical keyboard). Mounted once in App.tsx and switched on or
// off from any dashboard (stores/webKeyboardStore).
//
// While enabled it slides up whenever ANY text field gets focus — on every
// screen, not just the dashboards — and slides away when focus leaves the
// field (or on "Done"). It types straight into the focused <input>/<textarea>
// through the native value setter + an 'input' event, which is exactly what
// React's onChange (react-native-web TextInput's onChangeText) listens for,
// so every existing controlled field works unchanged. A physical keyboard
// keeps working alongside it.
//
// Rendered into document.body via a portal so it sits above RN Modals
// (drawer, Prod AI panel) too. While it's open the app root is shortened by
// the keyboard's height, like a phone keyboard, so the focused field can be
// scrolled into view instead of hiding behind the keys.

import React, { useCallback, useEffect, useRef, useState } from 'react';
// react-dom is installed (react-native-web renders through it) but its
// @types package isn't, so type the one function used here.
// @ts-ignore
import { createPortal as untypedCreatePortal } from 'react-dom';
import { Animated, LayoutChangeEvent, Pressable, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useWebKeyboardStore } from '../stores/webKeyboardStore';

const createPortal = untypedCreatePortal as (children: React.ReactNode, container: Element) => React.ReactPortal;

type Editable = HTMLInputElement | HTMLTextAreaElement;
type Layout = 'letters' | 'symbols' | 'numpad';
type Shift = 'off' | 'once' | 'lock';

// Special keys; anything else in a row is typed literally.
const SHIFT = '{shift}';
const BKSP = '{bksp}';
const ENTER = '{enter}';
const SPACE = '{space}';
const TO_SYMBOLS = '{123}';
const TO_LETTERS = '{abc}';

const LETTER_ROWS = [
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  [SHIFT, 'z', 'x', 'c', 'v', 'b', 'n', 'm', BKSP],
  [TO_SYMBOLS, ',', SPACE, '.', ENTER],
];

const SYMBOL_ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['@', '#', '₹', '%', '&', '-', '+', '(', ')', '/'],
  ['_', '*', '"', "'", ':', ';', '!', '?', BKSP],
  [TO_LETTERS, ',', SPACE, '.', ENTER],
];

const NUMPAD_ROWS = [
  ['1', '2', '3', BKSP],
  ['4', '5', '6', '-'],
  ['7', '8', '9', ':'],
  [TO_LETTERS, '0', '.', ENTER],
];

// Relative key widths (everything else is 1).
const KEY_FLEX: Record<string, number> = {
  [SHIFT]: 1.5,
  [BKSP]: 1.5,
  [SPACE]: 5,
  [ENTER]: 2,
  [TO_SYMBOLS]: 1.5,
  [TO_LETTERS]: 1.5,
};

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);

function isEditable(el: Element | null): el is Editable {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(el.type) && !el.readOnly && !el.disabled;
  return false;
}

function wantsNumpad(el: Editable, inputMode: string | null): boolean {
  if (el instanceof HTMLInputElement && (el.type === 'number' || el.type === 'tel')) return true;
  return inputMode === 'numeric' || inputMode === 'decimal' || inputMode === 'tel';
}

// ─── Editing the focused field ────────────────────────────────────────────

function setNativeValue(el: Editable, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  // The prototype setter bypasses React's value tracker, so React sees the
  // following 'input' event as a real change and fires onChange.
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// type=number/email have no selection API — fall back to the end.
function getSelection(el: Editable): [number, number] {
  try {
    if (el.selectionStart != null && el.selectionEnd != null) return [el.selectionStart, el.selectionEnd];
  } catch {}
  return [el.value.length, el.value.length];
}

function setCaret(el: Editable, pos: number) {
  try {
    el.setSelectionRange(pos, pos);
  } catch {}
}

function insertText(el: Editable, text: string) {
  const [start, end] = getSelection(el);
  const next = el.value.slice(0, start) + text + el.value.slice(end);
  if (el.maxLength >= 0 && next.length > el.maxLength) return;
  setNativeValue(el, next);
  setCaret(el, start + text.length);
}

function deleteBackward(el: Editable) {
  const [start, end] = getSelection(el);
  const v = el.value;
  if (start !== end) {
    setNativeValue(el, v.slice(0, start) + v.slice(end));
    setCaret(el, start);
  } else if (start > 0) {
    setNativeValue(el, v.slice(0, start - 1) + v.slice(start));
    setCaret(el, start - 1);
  }
}

// Single-line fields submit like a real Enter: react-native-web's TextInput
// handles this keydown (onSubmitEditing, then blur) — which also closes the
// keyboard. Multiline fields get a newline.
function pressEnter(el: Editable) {
  if (el instanceof HTMLTextAreaElement) {
    insertText(el, '\n');
    return;
  }
  const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true } as KeyboardEventInit;
  el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
}

// ─── Component ────────────────────────────────────────────────────────────

export default function OnScreenKeyboard() {
  const enabled = useWebKeyboardStore((s) => s.enabled);

  const [target, setTarget] = useState<Editable | null>(null);
  const targetRef = useRef<Editable | null>(null);
  // The field's own inputmode, put back when the keyboard lets go of it.
  const savedModeRef = useRef<{ el: Editable; mode: string | null } | null>(null);
  const pointerInsideRef = useRef(false);

  const [layout, setLayout] = useState<Layout>('letters');
  const [shift, setShift] = useState<Shift>('off');
  const [kbHeight, setKbHeight] = useState(0);

  const restoreInputMode = () => {
    const saved = savedModeRef.current;
    if (!saved) return;
    if (saved.mode == null) saved.el.removeAttribute('inputmode');
    else saved.el.setAttribute('inputmode', saved.mode);
    savedModeRef.current = null;
  };

  const detach = useCallback(() => {
    restoreInputMode();
    targetRef.current = null;
    setTarget(null);
  }, []);

  const attach = useCallback((el: Editable) => {
    if (targetRef.current === el) return;
    restoreInputMode();
    const mode = el.getAttribute('inputmode');
    savedModeRef.current = { el, mode };
    // Stop a tablet's own soft keyboard from opening on top of this one.
    el.setAttribute('inputmode', 'none');
    targetRef.current = el;
    setLayout(wantsNumpad(el, mode) ? 'numpad' : 'letters');
    setShift('off');
    setTarget(el);
  }, []);

  // Follow focus across the whole document while enabled.
  useEffect(() => {
    if (!enabled) {
      detach();
      return;
    }
    const onFocusIn = (e: FocusEvent) => {
      if (isEditable(e.target as Element)) attach(e.target as Editable);
    };
    const onFocusOut = () => {
      // Wait for focus to land: field → field keeps the keyboard up. While a
      // key is being pressed, decide only after the press finishes — a key
      // that blurs on purpose (Enter submitting) must still close it, and a
      // stray focus slip is put back by withTarget before then.
      const check = () => {
        if (pointerInsideRef.current) {
          setTimeout(check, 60);
          return;
        }
        const active = document.activeElement;
        if (isEditable(active)) attach(active);
        else detach();
      };
      setTimeout(check, 0);
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    if (isEditable(document.activeElement)) attach(document.activeElement);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      detach();
    };
  }, [enabled, attach, detach]);

  // A field that gets removed from the page (screen change) while focused
  // doesn't always fire focusout — close the keyboard anyway.
  useEffect(() => {
    if (!target) return;
    const id = setInterval(() => {
      if (!target.isConnected) detach();
    }, 500);
    return () => clearInterval(id);
  }, [target, detach]);

  const visible = target != null;

  // Shorten the app root while open, then bring the field into view.
  useEffect(() => {
    const root = document.getElementById('root');
    if (!root || !visible || !kbHeight) return;
    const prev = root.style.height;
    root.style.height = `calc(100% - ${kbHeight}px)`;
    const raf = requestAnimationFrame(() => {
      targetRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    return () => {
      cancelAnimationFrame(raf);
      root.style.height = prev;
    };
  }, [visible, kbHeight, target]);

  // Slide in / out.
  const anim = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.timing(anim, { toValue: 1, duration: 180, useNativeDriver: false }).start();
    } else {
      Animated.timing(anim, { toValue: 0, duration: 140, useNativeDriver: false }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [visible, anim]);

  // Pressing a key must not take focus away from the field. preventDefault on
  // mousedown (also fired after a touch tap) keeps focus without cancelling
  // the click that Pressable's onPress runs on.
  const panelNodeRef = useRef<HTMLElement | null>(null);
  const setPanelNode = useCallback((node: unknown) => {
    const prev = panelNodeRef.current;
    if (prev) {
      prev.removeEventListener('mousedown', preventMouseDown);
      prev.removeEventListener('pointerdown', markPointerInside);
    }
    const el = node instanceof HTMLElement ? node : null;
    panelNodeRef.current = el;
    if (el) {
      el.addEventListener('mousedown', preventMouseDown);
      el.addEventListener('pointerdown', markPointerInside);
    }
  }, []);

  function preventMouseDown(e: MouseEvent) {
    e.preventDefault();
  }
  function markPointerInside() {
    pointerInsideRef.current = true;
    const clear = () => {
      setTimeout(() => {
        pointerInsideRef.current = false;
      }, 50);
      window.removeEventListener('pointerup', clear);
      window.removeEventListener('pointercancel', clear);
    };
    window.addEventListener('pointerup', clear);
    window.addEventListener('pointercancel', clear);
  }

  // Safety net: if focus slipped anyway, put it back before typing.
  const withTarget = (fn: (el: Editable) => void) => {
    const el = targetRef.current;
    if (!el || !el.isConnected) return;
    if (document.activeElement !== el) el.focus({ preventScroll: true });
    fn(el);
  };

  const onKey = (key: string) => {
    switch (key) {
      case SHIFT:
        setShift((s) => (s === 'off' ? 'once' : s === 'once' ? 'lock' : 'off'));
        return;
      case TO_SYMBOLS:
        setLayout('symbols');
        return;
      case TO_LETTERS:
        setLayout('letters');
        return;
      case BKSP:
        withTarget(deleteBackward);
        return;
      case ENTER:
        withTarget(pressEnter);
        return;
      case SPACE:
        withTarget((el) => insertText(el, ' '));
        return;
      default: {
        const upper = layout === 'letters' && shift !== 'off';
        withTarget((el) => insertText(el, upper ? key.toUpperCase() : key));
        if (shift === 'once') setShift('off');
      }
    }
  };

  // "Done": close right away (not via focusout) and leave the field.
  const hide = () => {
    stopRepeat();
    const el = targetRef.current;
    detach();
    el?.blur();
  };

  // Hold backspace to keep deleting.
  const repeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopRepeat = () => {
    if (repeatRef.current) clearInterval(repeatRef.current);
    repeatRef.current = null;
  };
  const startRepeat = () => {
    stopRepeat();
    withTarget(deleteBackward);
    repeatRef.current = setInterval(() => withTarget(deleteBackward), 70);
  };
  useEffect(() => stopRepeat, []);

  const onLayout = (e: LayoutChangeEvent) => {
    const h = Math.round(e.nativeEvent.layout.height);
    if (h !== kbHeight) setKbHeight(h);
  };

  if (!enabled || !mounted || typeof document === 'undefined') return null;

  const isEmail = target instanceof HTMLInputElement && target.type === 'email';
  const rows = (layout === 'numpad' ? NUMPAD_ROWS : layout === 'symbols' ? SYMBOL_ROWS : LETTER_ROWS).map((row) =>
    // Email fields get '@' where the comma usually is.
    isEmail && layout === 'letters' ? row.map((k) => (k === ',' ? '@' : k)) : row,
  );
  const label = target?.getAttribute('placeholder') || target?.getAttribute('aria-label') || 'Keyboard';

  const panel = (
    <Animated.View
      onLayout={onLayout}
      style={[
        styles.panel,
        {
          transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [kbHeight || 320, 0] }) }],
          opacity: anim,
        },
      ]}
      accessibilityLabel="On-screen keyboard"
    >
      <View ref={setPanelNode as never}>
      <View style={styles.bar}>
        <Ionicons name="keypad-outline" size={15} color="#5C6670" />
        <Text style={styles.barLabel} numberOfLines={1}>
          {label}
        </Text>
        <Pressable
          onPress={hide}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Hide keyboard"
          style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
            styles.doneBtn,
            (pressed || hovered) && { backgroundColor: '#242B32' },
          ]}
        >
          <Text style={styles.doneText}>Done</Text>
          <Ionicons name="chevron-down" size={15} color="#3E7CB1" />
        </Pressable>
      </View>

      <View style={[styles.keys, layout === 'numpad' && styles.keysNumpad]}>
        {rows.map((row, r) => (
          <View
            key={`${layout}-${r}`}
            // Inset the 9-key home row like a real keyboard.
            style={[styles.row, layout !== 'numpad' && row.length === 9 && r === 1 && styles.rowInset]}
          >
            {row.map((key) => (
              <Key
                key={key}
                k={key}
                shift={shift}
                upper={layout === 'letters' && shift !== 'off'}
                onPress={() => onKey(key)}
                onLongPress={key === BKSP ? startRepeat : undefined}
                onPressOut={key === BKSP ? stopRepeat : undefined}
              />
            ))}
          </View>
        ))}
      </View>
      </View>
    </Animated.View>
  );

  return createPortal(panel, document.body);
}

function Key({
  k,
  shift,
  upper,
  onPress,
  onLongPress,
  onPressOut,
}: {
  k: string;
  shift: Shift;
  upper: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  onPressOut?: () => void;
}) {
  const special = k.startsWith('{') && k !== SPACE;
  const isEnter = k === ENTER;
  const shiftOn = k === SHIFT && shift !== 'off';

  let content: React.ReactNode;
  let a11y = k;
  if (k === SHIFT) {
    a11y = 'Shift';
    content = <Ionicons name={shift === 'lock' ? 'arrow-up-circle' : 'arrow-up'} size={20} color={shiftOn ? '#3E7CB1' : '#ECEFF2'} />;
  } else if (k === BKSP) {
    a11y = 'Backspace';
    content = <Ionicons name="backspace-outline" size={20} color="#ECEFF2" />;
  } else if (k === ENTER) {
    a11y = 'Enter';
    content = <Ionicons name="return-down-back" size={20} color="#FFFFFF" />;
  } else if (k === SPACE) {
    a11y = 'Space';
    content = <Text style={styles.spaceText}>space</Text>;
  } else if (k === TO_SYMBOLS || k === TO_LETTERS) {
    a11y = k === TO_SYMBOLS ? 'Numbers and symbols' : 'Letters';
    content = <Text style={styles.modeText}>{k === TO_SYMBOLS ? '?123' : 'ABC'}</Text>;
  } else {
    content = <Text style={styles.keyText}>{upper ? k.toUpperCase() : k}</Text>;
  }

  return (
    <Pressable
      onPress={onLongPress ? undefined : onPress}
      // Backspace: tap deletes once (onPressIn), holding repeats.
      onPressIn={onLongPress ? onPress : undefined}
      onLongPress={onLongPress}
      onPressOut={onPressOut}
      delayLongPress={400}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
        styles.key,
        { flex: KEY_FLEX[k] ?? 1 },
        special && styles.keySpecial,
        shiftOn && styles.keyShiftOn,
        isEnter && styles.keyEnter,
        hovered && !pressed && (isEnter ? styles.keyEnterHover : styles.keyHover),
        pressed && (isEnter ? styles.keyEnterPressed : styles.keyPressed),
        { cursor: 'pointer', userSelect: 'none' } as ViewStyle,
      ]}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: 'fixed' as 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 100000,
    backgroundColor: '#1A1F25',
    borderTopWidth: 1,
    borderTopColor: '#2C343C',
    paddingBottom: 10,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: -4 },
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#232A31',
    marginBottom: 8,
  },
  barLabel: { flex: 1, color: '#8A96A3', fontSize: 12.5, fontWeight: '600' },
  doneBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  doneText: { color: '#3E7CB1', fontSize: 13.5, fontWeight: '800' },
  keys: { width: '100%', maxWidth: 860, alignSelf: 'center', paddingHorizontal: 6, gap: 7 },
  keysNumpad: { maxWidth: 420 },
  row: { flexDirection: 'row', gap: 6 },
  rowInset: { paddingHorizontal: '4.5%' },
  key: {
    height: 48,
    minWidth: 0,
    borderRadius: 8,
    backgroundColor: '#2A323A',
    borderBottomWidth: 2,
    borderBottomColor: '#14181C',
    alignItems: 'center',
    justifyContent: 'center',
  },
  keySpecial: { backgroundColor: '#20272D' },
  keyShiftOn: { backgroundColor: '#3E7CB133' },
  keyHover: { backgroundColor: '#323B44' },
  keyPressed: { backgroundColor: '#3A434C', transform: [{ translateY: 1 }] },
  keyEnter: { backgroundColor: '#3E7CB1' },
  keyEnterHover: { backgroundColor: '#4A88BD' },
  keyEnterPressed: { backgroundColor: '#356C9C', transform: [{ translateY: 1 }] },
  keyText: { color: '#ECEFF2', fontSize: 18, fontWeight: '600' },
  modeText: { color: '#ECEFF2', fontSize: 13.5, fontWeight: '800' },
  spaceText: { color: '#8A96A3', fontSize: 13, fontWeight: '600' },
});
