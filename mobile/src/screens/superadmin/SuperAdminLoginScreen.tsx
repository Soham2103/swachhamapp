import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ActivityIndicator,
  KeyboardAvoidingView, Platform, ScrollView, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS } from '../../constants/theme';
import { useAuthStore } from '../../store/authStore';

/**
 * Super admin sign-in, in two steps.
 *
 * Step 1 proves the mobile number by OTP. Only then does the server say
 * whether this number belongs to a super admin, and only then does it
 * hand back the short-lived token that step 2 requires. Clearing step 1
 * is not a session -- it is only permission to attempt the password.
 *
 * The screen never decides the role itself; it renders whatever the
 * server reports, so the client cannot talk its way into step 2.
 */
export default function SuperAdminLoginScreen({ navigation }: any) {
  const { superAdminSendOtp, superAdminVerifyOtp, superAdminLogin, isLoading } = useAuthStore();

  const [step, setStep] = useState<'mobile' | 'otp' | 'password'>('mobile');
  const [mobile, setMobile] = useState('');
  const [otp, setOtp] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [preAuthToken, setPreAuthToken] = useState('');
  const [adminName, setAdminName] = useState<string | null>(null);
  const [error, setError] = useState('');

  const sendOtp = async () => {
    setError('');
    if (!/^[6-9]\d{9}$/.test(mobile.trim())) {
      setError('Enter a valid 10-digit mobile number');
      return;
    }
    try {
      await superAdminSendOtp(mobile.trim());
      setStep('otp');
    } catch (e: any) {
      setError(e.message);
    }
  };

  const verifyOtp = async () => {
    setError('');
    if (otp.trim().length !== 6) {
      setError('Enter the 6-digit OTP');
      return;
    }
    try {
      const result = await superAdminVerifyOtp(mobile.trim(), otp.trim());
      if (!result.isSuperAdmin || !result.preAuthToken) {
        // Truthful, and no hint about which numbers are admins.
        Alert.alert(
          'Not a super admin account',
          'This mobile number is not registered as a super admin. Please use the normal sign-in.',
          [{ text: 'Go back', onPress: () => navigation.goBack() }]
        );
        return;
      }
      setPreAuthToken(result.preAuthToken);
      setAdminName(result.name);
      setStep('password');
    } catch (e: any) {
      setError(e.message);
    }
  };

  const signIn = async () => {
    setError('');
    if (!username.trim() || !password) {
      setError('Enter your username and password');
      return;
    }
    try {
      await superAdminLogin(username.trim(), password, preAuthToken);
      // Navigation is driven by auth state in AppNavigator, not from here.
    } catch (e: any) {
      setError(e.message);
      // The pre-auth token lasts 5 minutes; if it lapsed, start over
      // rather than leaving the user on a step that can no longer work.
      if (/expired|verification/i.test(e.message)) {
        setStep('mobile');
        setOtp('');
        setPreAuthToken('');
      }
    }
  };

  const stepIndex = step === 'mobile' ? 0 : step === 'otp' ? 0 : 1;

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
            <Ionicons name="arrow-back" size={22} color={COLORS.TextPrimary} />
          </TouchableOpacity>

          <View style={styles.badge}>
            <Ionicons name="shield-checkmark-outline" size={26} color={COLORS.Primary} />
          </View>
          <Text style={styles.title}>Super Admin</Text>
          <Text style={styles.subtitle}>
            {step === 'password'
              ? `Verified${adminName ? ' as ' + adminName : ''}. Now enter your credentials.`
              : 'Sign in with your registered mobile number, then your credentials.'}
          </Text>

          {/* Two dots, because there are two things to clear: the number,
              then the credentials. */}
          <View style={styles.steps}>
            {[0, 1].map((i) => (
              <View key={i} style={[styles.stepDot, i <= stepIndex && styles.stepDotActive]} />
            ))}
          </View>

          {step === 'mobile' && (
            <>
              <Text style={styles.label}>Mobile number</Text>
              <TextInput
                style={styles.input}
                value={mobile}
                onChangeText={setMobile}
                keyboardType="number-pad"
                maxLength={10}
                placeholder="10-digit mobile number"
                placeholderTextColor={COLORS.TextSecondary}
                autoFocus
              />
              <Primary label="Send OTP" onPress={sendOtp} loading={isLoading} />
            </>
          )}

          {step === 'otp' && (
            <>
              <Text style={styles.label}>Enter the 6-digit OTP</Text>
              <TextInput
                style={[styles.input, styles.otpInput]}
                value={otp}
                onChangeText={setOtp}
                keyboardType="number-pad"
                maxLength={6}
                placeholder="------"
                placeholderTextColor={COLORS.Border}
                autoFocus
              />
              <Primary label="Verify" onPress={verifyOtp} loading={isLoading} />
              <TouchableOpacity onPress={() => setStep('mobile')}>
                <Text style={styles.linkText}>Change mobile number</Text>
              </TouchableOpacity>
            </>
          )}

          {step === 'password' && (
            <>
              <Text style={styles.label}>Username</Text>
              <TextInput
                style={styles.input}
                value={username}
                onChangeText={setUsername}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="Username"
                placeholderTextColor={COLORS.TextSecondary}
                autoFocus
              />
              <Text style={styles.label}>Password</Text>
              <TextInput
                style={styles.input}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                placeholder="Password"
                placeholderTextColor={COLORS.TextSecondary}
              />
              <Primary label="Sign in" onPress={signIn} loading={isLoading} />
            </>
          )}

          {!!error && (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle-outline" size={16} color={COLORS.Error} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Primary({ label, onPress, loading }: { label: string; onPress: () => void; loading: boolean }) {
  return (
    <TouchableOpacity
      style={[styles.button, loading && styles.buttonDisabled]}
      onPress={onPress}
      disabled={loading}
    >
      {loading ? (
        <ActivityIndicator color={COLORS.Surface} />
      ) : (
        <Text style={styles.buttonText}>{label}</Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.Background },
  flex: { flex: 1 },
  scroll: { padding: SPACING.lg, paddingTop: SPACING.md },
  back: { width: 40, height: 40, justifyContent: 'center' },
  badge: {
    width: 56, height: 56, borderRadius: BORDER_RADIUS.full,
    backgroundColor: COLORS.Accent, alignItems: 'center', justifyContent: 'center',
    marginTop: SPACING.md, marginBottom: SPACING.md,
  },
  title: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xxl,
    fontWeight: 'bold', color: COLORS.TextPrimary,
  },
  subtitle: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary, marginTop: SPACING.xs, marginBottom: SPACING.lg,
  },
  steps: { flexDirection: 'row', gap: SPACING.xs, marginBottom: SPACING.lg },
  stepDot: {
    height: 4, flex: 1, borderRadius: 2, backgroundColor: COLORS.Border,
  },
  stepDotActive: { backgroundColor: COLORS.Primary },
  label: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xs,
    fontWeight: '600', color: COLORS.TextSecondary,
    marginBottom: SPACING.xs, marginTop: SPACING.sm,
  },
  input: {
    backgroundColor: COLORS.Surface, borderWidth: 1, borderColor: COLORS.Border,
    borderRadius: BORDER_RADIUS.md, paddingHorizontal: SPACING.md, paddingVertical: SPACING.md,
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.base, color: COLORS.TextPrimary,
  },
  otpInput: { letterSpacing: 8, textAlign: 'center', fontSize: TYPOGRAPHY.sizes.xl },
  button: {
    backgroundColor: COLORS.Primary, borderRadius: BORDER_RADIUS.md,
    paddingVertical: SPACING.md, alignItems: 'center', marginTop: SPACING.lg,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '600', color: COLORS.Surface,
  },
  linkText: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.Primary, textAlign: 'center', marginTop: SPACING.md,
  },
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.xs,
    backgroundColor: '#FDECEC', borderRadius: BORDER_RADIUS.sm,
    padding: SPACING.sm, marginTop: SPACING.md,
  },
  errorText: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.Error, flex: 1,
  },
});
