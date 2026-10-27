// src/components/ProdAIPanel.tsx
//
// Prod AI as a popup over the current screen (the Admin Overview) instead
// of a separate route: the screen behind stays mounted and unchanged, and
// closing returns straight to it. The chat inside is the assistant's own
// (screens/AIAssistantScreen ProdAIChat) and its conversation lives in
// stores/prodAIStore, so closing — even while a request is running — keeps
// it; reopening shows the reply when it has arrived.
//
// Layout:
//   • desktop web (≥ 640px wide): a 400px floating panel, bottom-right, with
//     24px viewport margins, over a light backdrop — the overview stays
//     recognizable behind it;
//   • narrow / mobile web: the panel fills the viewport minus an 8px margin;
//   • React Native: full-screen sheet inside the safe area, lifted by the
//     keyboard; Android back closes it (onRequestClose).
// Escape closes on web, focus is trapped inside while open and returned to
// the launcher on close (react-native-web's Modal does all three). Clicking
// the backdrop closes too. Scrolling stays in the conversation — the modal
// layer covers the page behind.

import React from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AI_THEME, ProdAIChat } from '../screens/AIAssistantScreen';
import { prodAIPanelFrame } from '../utils/prodAIPanelLayout';

export default function ProdAIPanel({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const viewport = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const frame = prodAIPanelFrame(Platform.OS, viewport, insets);
  const { layout, ...position } = frame;

  return (
    <Modal
      visible={visible}
      transparent
      animationType={layout === 'floating' ? 'fade' : 'slide'}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={StyleSheet.absoluteFill}>
        {/* Backdrop: light on desktop, so the overview stays readable. */}
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: layout === 'floating' ? 'rgba(0,0,0,0.28)' : 'rgba(0,0,0,0.6)' }]}
          onPress={onClose}
          focusable={false}
          accessible={false}
          importantForAccessibility="no"
        />
        <KeyboardAvoidingView
          style={[styles.frame, position, layout === 'sheet' && { left: position.left ?? 0 }]}
          behavior={Platform.OS === 'ios' ? 'padding' : Platform.OS === 'android' ? 'height' : undefined}
          pointerEvents="box-none"
        >
          <View
            style={[styles.panel, layout === 'sheet' && styles.panelSheet]}
            accessibilityViewIsModal
            aria-modal
            role="dialog"
            aria-label="Prod AI"
          >
            <ProdAIChat mode="panel" onClose={onClose} />
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  frame: { position: 'absolute' },
  panel: {
    flex: 1,
    backgroundColor: AI_THEME.bg,
    borderWidth: 1,
    borderColor: AI_THEME.border,
    borderRadius: 14,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  panelSheet: { borderRadius: 0, borderWidth: 0 },
});
