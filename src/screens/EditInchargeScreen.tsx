import React, { useEffect, useState } from 'react';
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
import { useNavigation, useRoute } from '@react-navigation/native';
import { doc, getDoc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../services/firebase';
import { sendSupervisorPasswordReset } from '../services/firebaseAdmin';
import { useAuthStore } from '../stores/authStore';
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

export default function EditInchargeScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const currentUser = useAuthStore((s) => s.user);
  const uid: string = route.params?.uid;

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [employeeCode, setEmployeeCode] = useState('');
  const [email, setEmail] = useState('');
  const [plant, setPlant] = useState<string | null>(null);
  const [assign, setAssign] = useState<string | null>(null);
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sendingReset, setSendingReset] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'users', uid));
        if (snap.exists()) {
          const data: any = snap.data();
          setName(data.name ?? '');
          setEmployeeCode(data.employeeCode ?? '');
          setEmail(data.email ?? '');
          setPlant(data.plant ?? null);
          setAssign(data.assign ?? null);
          setActive(data.active !== false);
        } else {
          setLoadError('This incharge account could not be found.');
        }
      } catch (e) {
        setLoadError('Could not load this account. Check your connection and try again.');
      } finally {
        setLoading(false);
      }
    })();
  }, [uid]);

  const handleSave = async () => {
    if (!name.trim()) {
      setFormError('Name is required.');
      return;
    }
    if (!plant) {
      setFormError('Select a plant.');
      return;
    }
    if (!assign) {
      setFormError('Select what this incharge is assigned as.');
      return;
    }
    setFormError(null);
    setSaving(true);
    try {
      await updateDoc(doc(db, 'users', uid), {
        name: name.trim(),
        employeeCode: employeeCode.trim(),
        plant,
        assign,
        active,
        updatedBy: currentUser?.uid ?? null,
        updatedAt: serverTimestamp(),
      });
      Alert.alert('Saved', 'Incharge account updated.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      setFormError('Could not save changes. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = () => {
    if (active) {
      Alert.alert(
        'Deactivate Account',
        `${name.trim() || 'This incharge'} will no longer be able to sign in. You can reactivate them anytime.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Deactivate', style: 'destructive', onPress: () => setActive(false) },
        ]
      );
    } else {
      setActive(true);
    }
  };

  const handleSendReset = async () => {
    if (!email) {
      Alert.alert('No Email', 'This account has no login email on file.');
      return;
    }
    setSendingReset(true);
    try {
      await sendSupervisorPasswordReset(email);
      Alert.alert('Email Sent', `A password reset link was sent to ${email}.`);
    } catch (e: any) {
      console.error('[handleSendReset] Firebase error:', e.code, e.message);
      const message =
        e.code === 'auth/user-not-found'
          ? `No Firebase Auth account exists for ${email}. It may only exist in Firestore, not Auth.`
          : e.code === 'auth/invalid-email'
          ? `"${email}" is not a valid email address.`
          : 'Could not send the reset email. Check your connection and try again.';
      Alert.alert('Error', message);
    } finally {
      setSendingReset(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={[styles.safeArea, styles.centered]}>
        <ActivityIndicator color="#F2A93B" size="large" />
      </SafeAreaView>
    );
  }

  if (loadError) {
    return (
      <SafeAreaView style={[styles.safeArea, styles.centered]}>
        <Ionicons name="alert-circle" size={22} color="#D64545" />
        <Text style={styles.errorText}>{loadError}</Text>
        <Pressable onPress={() => navigation.goBack()} style={styles.retryButton}>
          <Text style={styles.retryText}>Back</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Pressable onPress={() => navigation.goBack()} style={styles.backButton} hitSlop={12}>
            <Ionicons name="arrow-back" size={22} color="#8A96A3" />
            <Text style={styles.backText}>Back</Text>
          </Pressable>

          <Text style={styles.title}>Edit Incharge</Text>
          <Text style={styles.subtitle}>Update account details</Text>

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
            <Text style={styles.label}>LOGIN EMAIL</Text>
            <View style={styles.readOnlyBox}>
              <Text style={styles.readOnlyText}>{email || '—'}</Text>
              <Ionicons name="lock-closed" size={14} color="#5C6670" />
            </View>
            <Text style={styles.hint}>
              Login email can't be changed here. Use "Send Password Reset" below if they need account recovery.
            </Text>
          </View>

          <ChipSelector label="PLANT" options={PLANTS} value={plant} onChange={setPlant} />
          <ChipSelector label="ASSIGN AS" options={ASSIGN_ROLES} value={assign} onChange={setAssign} />

          <View style={styles.divider} />

          <View style={styles.statusRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.statusLabel}>Account Status</Text>
              <Text style={styles.statusHint}>
                {active ? 'This incharge can currently sign in.' : 'This incharge is blocked from signing in.'}
              </Text>
            </View>
            <Pressable
              onPress={handleToggleActive}
              style={[styles.statusToggle, active ? styles.statusToggleActive : styles.statusToggleInactive]}
            >
              <Text style={[styles.statusToggleText, active ? styles.statusToggleTextActive : styles.statusToggleTextInactive]}>
                {active ? 'Active' : 'Inactive'}
              </Text>
            </Pressable>
          </View>

          <Pressable style={styles.resetButton} onPress={handleSendReset} disabled={sendingReset}>
            {sendingReset ? (
              <ActivityIndicator color="#3E7CB1" size="small" />
            ) : (
              <>
                <Ionicons name="mail-outline" size={16} color="#3E7CB1" />
                <Text style={styles.resetButtonText}>Send Password Reset Email</Text>
              </>
            )}
          </Pressable>

          {formError && (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle" size={16} color="#D64545" />
              <Text style={styles.formErrorText}>{formError}</Text>
            </View>
          )}

          <Pressable
            style={({ pressed }) => [styles.submitButton, (saving || pressed) && styles.submitButtonPressed]}
            onPress={handleSave}
            disabled={saving}
          >
            {saving ? <ActivityIndicator color="#14181C" /> : <Text style={styles.submitText}>Save Changes</Text>}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#14181C' },
  centered: { alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 30 },
  scroll: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 48 },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 20 },
  backText: { color: '#8A96A3', fontSize: 15 },
  title: { color: '#ECEFF2', fontSize: 24, fontWeight: '800' },
  subtitle: { color: '#8A96A3', fontSize: 14, marginTop: 4, marginBottom: 26 },
  field: { marginBottom: 10 },
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
  readOnlyBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#171B20',
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 10,
    paddingHorizontal: 14,
    height: 52,
  },
  readOnlyText: { color: '#8A96A3', fontSize: 15 },
  hint: { color: '#5C6670', fontSize: 11.5, marginTop: 6, lineHeight: 16 },
  divider: { height: 1, backgroundColor: '#2C343C', marginVertical: 22 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  statusLabel: { color: '#ECEFF2', fontSize: 15, fontWeight: '700' },
  statusHint: { color: '#8A96A3', fontSize: 12.5, marginTop: 3 },
  statusToggle: { borderRadius: 20, paddingHorizontal: 16, paddingVertical: 9, borderWidth: 1 },
  statusToggleActive: { backgroundColor: '#4C9A6A22', borderColor: '#4C9A6A' },
  statusToggleInactive: { backgroundColor: '#D6454522', borderColor: '#D64545' },
  statusToggleText: { fontSize: 13, fontWeight: '700' },
  statusToggleTextActive: { color: '#4C9A6A' },
  statusToggleTextInactive: { color: '#D64545' },
  resetButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: '#3E7CB1',
    borderRadius: 10,
    height: 50,
    marginBottom: 22,
  },
  resetButtonText: { color: '#3E7CB1', fontSize: 14, fontWeight: '700' },
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
  errorText: { color: '#F0A8A8', fontSize: 14, textAlign: 'center' },
  formErrorText: { color: '#F0A8A8', fontSize: 13, flex: 1 },
  retryButton: {
    borderWidth: 1,
    borderColor: '#2C343C',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginTop: 4,
  },
  retryText: { color: '#ECEFF2', fontSize: 13, fontWeight: '600' },
  submitButton: {
    height: 56,
    borderRadius: 12,
    backgroundColor: '#F2A93B',
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitButtonPressed: { opacity: 0.85 },
  submitText: { color: '#14181C', fontSize: 16, fontWeight: '800', letterSpacing: 0.3 },
});