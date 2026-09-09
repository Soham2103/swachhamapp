import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import {
  COLORS,
  SPACING,
  TYPOGRAPHY,
  BORDER_RADIUS,
  SHADOWS,
} from '../../constants/theme';

import { useAuthStore } from '../../store/authStore';
import DemoBadge from '../../components/demo/DemoBadge';
import { DEMO_EMAIL, DEMO_PASSWORD } from '../../demo/demoMode';

/**
 * THE DEMO BUILD'S ONLY WAY IN.
 *
 * It replaces the whole production entry sequence — splash, permission gate,
 * mobile OTP, password step — for one reason: every one of those steps needs
 * a server. A demo phone in a hotel lobby with the data switched off would
 * stall on the first OTP, so the demo signs in against the device instead.
 *
 * The branding, the palette and the field styling are the app's own, taken
 * from the production login screen, so this reads as the same product rather
 * than as a test harness bolted on the front.
 *
 * The fields are PRE-FILLED with the demo credentials and the credentials are
 * also printed on the card. Whoever is holding the phone can simply press
 * Sign In, and a hotel that closes the app and comes back later does not need
 * to be told the password again.
 *
 * REACHABLE ONLY IN A DEMO BUILD. AppNavigator registers this screen behind
 * `DEMO_MODE`, and the store action it calls refuses outright if the flag is
 * off — so there is no build in which this is a way into a real account.
 */
export default function DemoLoginScreen() {
  const [email, setEmail] = useState(DEMO_EMAIL);
  const [password, setPassword] = useState(DEMO_PASSWORD);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');

  const { demoLogin, isLoading } = useAuthStore();

  const handleSignIn = async () => {
    setError('');
    try {
      // No navigation call: AppNavigator swaps to the Business stack the
      // moment `isAuthenticated` flips, exactly as it does for a real login.
      await demoLogin(email, password);
    } catch (err: any) {
      setError(err?.message || 'Sign-in failed. Please try again.');
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.headerContainer}>
            <Image
              source={require('../../../assets/swachham-logo.png')}
              style={styles.logo}
              resizeMode="contain"
            />
            <DemoBadge style={styles.headerBadge} />
            <Text style={styles.welcomeText}>Business Sign In</Text>
            <Text style={styles.subtitleText}>
              A demonstration of the Swachham Business app
            </Text>
          </View>

          <View style={styles.formContainer}>
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Email Address</Text>
              <View style={styles.inputWrapper}>
                <Ionicons name="mail-outline" size={20} color={COLORS.TextSecondary} />
                <TextInput
                  style={styles.input}
                  placeholder="Enter your email"
                  placeholderTextColor={COLORS.TextSecondary}
                  value={email}
                  onChangeText={setEmail}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                />
              </View>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.label}>Password</Text>
              <View style={styles.inputWrapper}>
                <Ionicons name="lock-closed-outline" size={20} color={COLORS.TextSecondary} />
                <TextInput
                  style={styles.input}
                  placeholder="Enter your password"
                  placeholderTextColor={COLORS.TextSecondary}
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                />
                <TouchableOpacity
                  onPress={() => setShowPassword((visible) => !visible)}
                  accessibilityRole="button"
                  accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                >
                  <Ionicons
                    name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                    size={20}
                    color={COLORS.TextSecondary}
                  />
                </TouchableOpacity>
              </View>
            </View>

            {error ? (
              <View style={styles.errorBox}>
                <Ionicons name="alert-circle-outline" size={16} color={COLORS.Error} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <TouchableOpacity
              style={[styles.signInButton, isLoading && styles.signInButtonDisabled]}
              onPress={handleSignIn}
              disabled={isLoading}
              activeOpacity={0.85}
            >
              {isLoading ? (
                <>
                  <ActivityIndicator color={COLORS.Surface} />
                  <Text style={styles.signInButtonText}>Signing in...</Text>
                </>
              ) : (
                <Text style={styles.signInButtonText}>Sign In</Text>
              )}
            </TouchableOpacity>

            {/* The credentials, printed. A demo whose password has to be
                asked for is a demo that stops working the moment the phone
                is handed to somebody else. */}
            <View style={styles.credentialsCard}>
              <Text style={styles.credentialsTitle}>Demo credentials</Text>
              <View style={styles.credentialRow}>
                <Text style={styles.credentialKey}>Email</Text>
                <Text style={styles.credentialValue}>{DEMO_EMAIL}</Text>
              </View>
              <View style={styles.credentialRow}>
                <Text style={styles.credentialKey}>Password</Text>
                <Text style={styles.credentialValue}>{DEMO_PASSWORD}</Text>
              </View>
              <Text style={styles.credentialsNote}>
                This demonstration runs entirely on this device and works without
                an internet connection. Orders placed here are sample data only.
              </Text>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.Background,
  },
  keyboardView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: SPACING.lg,
  },
  headerContainer: {
    alignItems: 'center',
    marginBottom: SPACING.xl,
  },
  logo: {
    width: 130,
    height: 130,
    borderWidth: 1,
    borderColor: COLORS.Border,
    borderRadius: BORDER_RADIUS.md,
  },
  headerBadge: {
    marginTop: SPACING.xs,
    marginBottom: SPACING.sm,
  },
  welcomeText: {
    fontSize: TYPOGRAPHY.sizes.xxl,
    fontWeight: '700',
    color: COLORS.PrimaryDark,
  },
  subtitleText: {
    marginTop: SPACING.xs,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
    textAlign: 'center',
  },
  formContainer: {
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.lg,
    ...SHADOWS.medium,
  },
  inputGroup: {
    marginBottom: SPACING.md,
  },
  label: {
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '600',
    color: COLORS.TextPrimary,
    marginBottom: SPACING.xs,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    borderWidth: 1,
    borderColor: COLORS.Border,
    borderRadius: BORDER_RADIUS.md,
    paddingHorizontal: SPACING.md,
    height: 52,
    backgroundColor: COLORS.Surface,
  },
  input: {
    flex: 1,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.TextPrimary,
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    marginBottom: SPACING.md,
  },
  errorText: {
    flex: 1,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.Error,
  },
  signInButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    height: 52,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Primary,
  },
  signInButtonDisabled: {
    opacity: 0.7,
  },
  signInButtonText: {
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '700',
    color: COLORS.Surface,
  },
  credentialsCard: {
    marginTop: SPACING.lg,
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Background,
    borderWidth: 1,
    borderColor: COLORS.Border,
  },
  credentialsTitle: {
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '700',
    color: COLORS.PrimaryDark,
    marginBottom: SPACING.sm,
  },
  credentialRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 3,
  },
  credentialKey: {
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
  },
  credentialValue: {
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '600',
    color: COLORS.TextPrimary,
  },
  credentialsNote: {
    marginTop: SPACING.sm,
    fontSize: TYPOGRAPHY.sizes.xs,
    lineHeight: 17,
    color: COLORS.TextSecondary,
  },
});
