import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useAuthStore } from '../stores/authStore';
import { createSupervisorAccount } from '../services/firebaseAdmin';
import { PLANTS, ASSIGN_ROLES } from '../constants/lineOptions';

function ChipSelector({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: string[];
  value: string | null;
  onChange: (v: string) => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.chipRow}>
        {options.map((opt) => {
          const selected = value === opt;
          return (
            <Pressable
              key={opt}
              onPress={() => onChange(opt)}
              style={[styles.chip, selected && styles.chipSelected]}
            >
              <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{opt}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export default function RegisterInchargeScreen() {
  const navigation = useNavigation<any>();
  const user = useAuthStore((s) => s.user);

  const [name, setName] = useState('');
  const [employeeCode, setEmployeeCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [plant, setPlant] = useState<string | null>(null);
  const [assign, setAssign] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  if (user && user.role !== 'admin') {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.scroll}>
          <Text style={styles.title}>Access Restricted</Text>
          <Text style={styles.subtitle}>Only admin accounts can register incharges.</Text>
          <Pressable style={styles.submitButton} onPress={() => navigation.navigate('Home')}>
            <Text style={styles.submitText}>Back to Home</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const validate = (): string | null => {
    if (!name.trim()) return 'Name is required.';
    if (!employeeCode.trim()) return 'Employee code is required.';
    if (!email.trim() || !email.includes('@')) return 'Enter a valid email address.';
    if (!plant) return 'Select a plant.';
    if (!assign) return 'Select what this incharge is assigned as.';
    if (password.length < 6) return 'Password must be at least 6 characters.';
    if (password !== confirmPassword) return 'Passwords do not match.';
    return null;
  };

  const handleSubmit = async () => {
    const err = validate();
    if (err) {
      setFormError(err);
      return;
    }
    setFormError(null);
    setSubmitting(true);
    try {
      await createSupervisorAccount({
        name,
        employeeCode,
        email,
        password,
        plant: plant!,
        assign: assign!,
        createdBy: user?.uid ?? 'unknown',
      });
      Alert.alert('Incharge Created', `${name.trim()} can now sign in with ${email.trim()}.`, [
        { text: 'OK', onPress: () => navigation.navigate('Home') },
      ]);
    } catch (e: any) {
      setFormError(mapCreateError(e.code));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Pressable onPress={() => navigation.goBack()} style={styles.backButton} hitSlop={12}>
            <Ionicons name="arrow-back" size={22} color="#8A96A3" />
            <Text style={styles.backText}>Back</Text>
          </Pressable>

          <Text style={styles.title}>Register New Incharge</Text>
          <Text style={styles.subtitle}>Create login access for a plant floor incharge</Text>

          <View style={styles.field}>
            <Text style={styles.label}>FULL NAME</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="e.g. Rajesh Kumar"
              placeholderTextColor="#5C6670"
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>EMPLOYEE CODE</Text>
            <TextInput
              style={styles.input}
              value={employeeCode}
              onChangeText={setEmployeeCode}
              placeholder="e.g. EMP-1042"
              placeholderTextColor="#5C6670"
              autoCapitalize="characters"
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>EMAIL</Text>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              placeholder="incharge@technico.com"
              placeholderTextColor="#5C6670"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
            />
          </View>

          <ChipSelector label="PLANT" options={PLANTS} value={plant} onChange={setPlant} />
          <ChipSelector label="ASSIGN AS" options={ASSIGN_ROLES} value={assign} onChange={setAssign} />

          <View style={styles.field}>
            <Text style={styles.label}>PASSWORD</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              placeholder="At least 6 characters"
              placeholderTextColor="#5C6670"
              secureTextEntry
              autoCapitalize="none"
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>CONFIRM PASSWORD</Text>
            <TextInput
              style={styles.input}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              placeholder="Re-enter password"
              placeholderTextColor="#5C6670"
              secureTextEntry
              autoCapitalize="none"
            />
          </View>

          {formError && (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle" size={16} color="#D64545" />
              <Text style={styles.errorText}>{formError}</Text>
            </View>
          )}

          <Pressable
            style={({ pressed }) => [styles.submitButton, (submitting || pressed) && styles.submitButtonPressed]}
            onPress={handleSubmit}
            disabled={submitting}
          >
            {submitting ? (
              <ActivityIndicator color="#14181C" />
            ) : (
              <Text style={styles.submitText}>Create Incharge</Text>
            )}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function mapCreateError(code: string): string {
  switch (code) {
    case 'auth/email-already-in-use':
      return 'An account with this email already exists.';
    case 'auth/invalid-email':
      return 'Enter a valid email address.';
    case 'auth/weak-password':
      return 'Password is too weak — use at least 6 characters.';
    default:
      return 'Could not create the account. Check your connection and try again.';
  }
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#14181C' },
  scroll: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 48 },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 20 },
  backText: { color: '#8A96A3', fontSize: 15 },
  title: { color: '#ECEFF2', fontSize: 24, fontWeight: '800' },
  subtitle: { color: '#8A96A3', fontSize: 14, marginTop: 4, marginBottom: 26 },
  field: { marginBottom: 18 },
  label: { color: '#8A96A3', fontSize: 11, letterSpacing: 1, marginBottom: 8, fontWeight: '700' },
  input: {
    backgroundColor: '#1D2329',
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 10,
    paddingHorizontal: 14,
    height: 52,
    color: '#ECEFF2',
    fontSize: 16,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chip: {
    borderWidth: 1,
    borderColor: '#2C343C',
    backgroundColor: '#1D2329',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  chipSelected: { borderColor: '#F2A93B', backgroundColor: '#F2A93B22' },
  chipText: { color: '#8A96A3', fontSize: 13.5, fontWeight: '600' },
  chipTextSelected: { color: '#F2A93B' },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#D6454522',
    borderWidth: 1,
    borderColor: '#D64545',
    borderRadius: 10,
    padding: 12,
    marginBottom: 18,
  },
  errorText: { color: '#F0A8A8', fontSize: 13, flex: 1 },
  submitButton: {
    height: 56,
    borderRadius: 12,
    backgroundColor: '#F2A93B',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  submitButtonPressed: { opacity: 0.85 },
  submitText: { color: '#14181C', fontSize: 16, fontWeight: '800', letterSpacing: 0.3 },
});