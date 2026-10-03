import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  SafeAreaView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Switch,
  Alert,
  Image,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useAuthStore } from '../stores/authStore';

/**
 * App name: "ProdPulse"
 *
 * Logo file expected at: /assets/prodpulse-logo.png
 * (from this file path: require('../../assets/prodpulse-logo.png'))
 */

export default function LoginScreen() {
  const navigation = useNavigation<any>();
  const login = useAuthStore((s) => s.login);
  const error = useAuthStore((s) => s.error);
  const clearError = useAuthStore((s) => s.clearError);

  const { width: screenWidth } = useWindowDimensions();

  // Large responsive logo sizing (clamped)
  const logoWidth = Math.min(800, Math.max(180, Math.round(screenWidth * 0.96)));
  const logoHeight = Math.round(logoWidth * 0.30); // matches wide asset

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [remember, setRemember] = useState(true);

  const handleLogin = async () => {
    if (!email.trim() || !password) return;
    clearError();
    setSubmitting(true);
    // No navigation.replace() here: login() updates the auth store's user
    // state, and the root-level navigator (RootNavigator/AuthNavigator)
    // watches that state to decide whether to render the Auth stack or the
    // App stack. Once `user` is set, the whole navigator tree swaps to the
    // App stack on its own — Login isn't just replaced within one stack,
    // it's unmounted entirely, which is what actually prevents navigating
    // back to it (there's nothing to go back to).
    await login(email, password);
    setSubmitting(false);
  };

  const handleForgot = () => {
    Alert.alert('Forgot password', 'Password reset is not yet implemented in this build.');
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.topRow}>
            <Pressable onPress={() => navigation.goBack()} style={styles.backButton} hitSlop={12}>
              <Ionicons name="arrow-back" size={20} color="#8A96A3" />
            </Pressable>
          </View>

          <View style={styles.brand}>
            <Image
              source={require('../../assets/prodpulse-logo.png')}
              style={[styles.logo, { width: logoWidth, height: logoHeight }]}
              resizeMode="contain"
            />
            <Text style={styles.tagline}>Shop floor control · Live hourly recording</Text>
          </View>

          <View style={styles.card}>
            <View style={styles.field}>
              <Text style={styles.label}>EMAIL</Text>
              <View style={styles.inputRow}>
                <Ionicons name="mail-outline" size={18} color="#8A96A3" style={styles.inputIcon} />
                <TextInput
                  style={[styles.input, { paddingLeft: 40 }]}
                  value={email}
                  onChangeText={setEmail}
                  placeholder="admin@technico.com"
                  placeholderTextColor="#5C6670"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                />
              </View>
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>PASSWORD</Text>
              <View style={styles.inputRow}>
                <Ionicons name="lock-closed-outline" size={18} color="#8A96A3" style={styles.inputIcon} />
                <TextInput
                  style={[styles.input, { paddingLeft: 40 }]}
                  value={password}
                  onChangeText={setPassword}
                  placeholder="••••••••"
                  placeholderTextColor="#5C6670"
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                />
                <Pressable onPress={() => setShowPassword((s) => !s)} style={styles.eyeButton} hitSlop={12}>
                  <Ionicons name={showPassword ? 'eye-off' : 'eye'} size={18} color="#8A96A3" />
                </Pressable>
              </View>
            </View>

            <View style={styles.rowBetween}>
              <View style={styles.rememberRow}>
                <Switch value={remember} onValueChange={setRemember} thumbColor={remember ? '#F2A93B' : undefined} />
                <Text style={styles.rememberText}>Remember</Text>
              </View>
              <Pressable onPress={handleForgot}>
                <Text style={styles.forgotText}>Forgot?</Text>
              </Pressable>
            </View>

            {error && (
              <View style={styles.errorBox}>
                <Ionicons name="alert-circle" size={16} color="#D64545" />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            <Pressable
              style={({ pressed }) => [
                styles.submitButton,
                (submitting || pressed) && styles.submitButtonPressed,
              ]}
              onPress={handleLogin}
              disabled={submitting}
            >
              {submitting ? (
                <ActivityIndicator color="#14181C" />
              ) : (
                <Text style={styles.submitText}>Sign In</Text>
              )}
            </Pressable>
          </View>

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0F1417' },

  scroll: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 40,
    alignItems: 'stretch',
  },
  topRow: { height: 40, justifyContent: 'center' },
  backButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },

  // tight brand spacing so logo sits directly above tagline
  brand: {
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 6,
  },
  logo: {
    marginBottom: 2,
  },
  tagline: {
    color: '#8A96A3',
    fontSize: 13,
    marginTop: 2,
    textAlign: 'center',
    lineHeight: 16,
  },

  card: {
    marginTop: 12,
    backgroundColor: '#14181C',
    borderRadius: 14,
    padding: 18,
    borderWidth: 1,
    borderColor: '#24282C',
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },

  field: { marginBottom: 12 },
  label: { color: '#8A96A3', fontSize: 11, letterSpacing: 1.2, marginBottom: 6, fontWeight: '700' },
  inputRow: {
    position: 'relative',
    justifyContent: 'center',
  },
  inputIcon: {
    position: 'absolute',
    left: 12,
    zIndex: 10,
  },
  input: {
    backgroundColor: '#0F1417',
    borderWidth: 1,
    borderColor: '#23282C',
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 52,
    color: '#ECEFF2',
    fontSize: 16,
  },
  eyeButton: {
    position: 'absolute',
    right: 12,
    height: 52,
    justifyContent: 'center',
  },

  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 },
  rememberRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rememberText: { color: '#8A96A3', fontSize: 13 },
  forgotText: { color: '#F2A93B', fontSize: 13, fontWeight: '700' },

  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#D6454522',
    borderWidth: 1,
    borderColor: '#D64545',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  errorText: { color: '#F0A8A8', fontSize: 13, flex: 1 },

  submitButton: {
    height: 56,
    borderRadius: 12,
    backgroundColor: '#F2A93B',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  submitButtonPressed: { opacity: 0.9 },
  submitText: { color: '#14181C', fontSize: 16, fontWeight: '900', letterSpacing: 0.3 },
});