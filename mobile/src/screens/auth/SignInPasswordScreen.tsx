import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ActivityIndicator,
  KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS } from '../../constants/theme';
import { useAuthStore } from '../../store/authStore';

/** How each role refers to the thing it types as a username. */
const ROLE_COPY: Record<string, { title: string; hint: string }> = {
  SUPER_ADMIN: { title: 'Super Admin', hint: 'Your admin username' },
  ADMIN: { title: 'Admin', hint: 'Your admin username' },
  MANAGER: { title: 'Manager', hint: 'Your manager username' },
  SORTER: { title: 'Sorter', hint: 'Your staff username' },
  RIDER: { title: 'Rider', hint: 'Your rider username' },
  BUSINESS: { title: 'Business', hint: 'Your registered email' },
};

/**
 * The second half of sign-in, for the roles that need a password.
 *
 * Customers never reach this screen -- their OTP was the credential and
 * they are already inside. Arriving here at all means the server has
 * decided this number belongs to a staff or business account, and it
 * issued the short-lived token this screen must present.
 *
 * The role is shown, so somebody who did not expect a password prompt
 * can see why they are getting one.
 */
export default function SignInPasswordScreen({ navigation, route }: any) {
  const { role, name, preAuthToken, mobile } = route.params || {};
  const { signInPassword, isLoading } = useAuthStore();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const copy = ROLE_COPY[role] || { title: 'Sign in', hint: 'Your username' };

  const submit = async () => {
    setError('');
    if (!username.trim() || !password) {
      setError('Enter your username and password');
      return;
    }
    try {
      await signInPassword(username.trim(), password, preAuthToken);
      // Nothing to navigate: AppNavigator swaps stacks on auth state.
    } catch (e: any) {
      setError(e.message);
      // The token from step 1 lasts 15 minutes. If it lapsed, go back to
      // the number rather than sit on a step that can no longer succeed.
      if (/expired|verification/i.test(e.message)) {
        navigation.reset({ index: 0, routes: [{ name: 'MobileVerificationScreen' }] });
      }
    }
  };

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
            <Ionicons name="lock-closed-outline" size={24} color={COLORS.Primary} />
          </View>

          <Text style={styles.role}>{copy.title.toUpperCase()}</Text>
          <Text style={styles.title}>{name ? 'Welcome, ' + name : 'One more step'}</Text>
          <Text style={styles.subtitle}>
            {mobile ? mobile + ' verified. ' : ''}This account also needs a password.
          </Text>

          <View style={styles.steps}>
            <View style={[styles.stepDot, styles.stepDotActive]} />
            <View style={[styles.stepDot, styles.stepDotActive]} />
          </View>

          <Text style={styles.label}>{copy.hint}</Text>
          <TextInput
            style={styles.input}
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={copy.hint}
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
            onSubmitEditing={submit}
          />

          <TouchableOpacity
            style={[styles.button, isLoading && styles.buttonDisabled]}
            onPress={submit}
            disabled={isLoading}
          >
            {isLoading ? (
              <ActivityIndicator color={COLORS.Surface} />
            ) : (
              <Text style={styles.buttonText}>Sign in</Text>
            )}
          </TouchableOpacity>

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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.Background },
  flex: { flex: 1 },
  scroll: { padding: SPACING.lg, paddingTop: SPACING.md },
  back: { width: 40, height: 40, justifyContent: 'center' },
  badge: {
    width: 52, height: 52, borderRadius: BORDER_RADIUS.full,
    backgroundColor: COLORS.Accent, alignItems: 'center', justifyContent: 'center',
    marginTop: SPACING.md, marginBottom: SPACING.md,
  },
  role: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xs,
    fontWeight: '700', color: COLORS.Primary, letterSpacing: 1,
  },
  title: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.xxl,
    fontWeight: 'bold', color: COLORS.TextPrimary, marginTop: 2,
  },
  subtitle: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary, marginTop: SPACING.xs, marginBottom: SPACING.lg,
  },
  steps: { flexDirection: 'row', gap: SPACING.xs, marginBottom: SPACING.lg },
  stepDot: { height: 4, flex: 1, borderRadius: 2, backgroundColor: COLORS.Border },
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
  button: {
    backgroundColor: COLORS.Primary, borderRadius: BORDER_RADIUS.md,
    paddingVertical: SPACING.md, alignItems: 'center', marginTop: SPACING.lg,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: {
    fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '600', color: COLORS.Surface,
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
