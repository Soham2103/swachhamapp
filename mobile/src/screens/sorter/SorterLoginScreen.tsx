import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS, SHADOWS } from '../../constants/theme';
import { useAuthStore } from '../../store/authStore';

/**
 * Sorter sign-in.
 *
 * Staff log in with a username rather than an email address, which is the only
 * thing that differs from the other login screens — the store, the API client
 * and the token handling are all the existing ones.
 */
export default function SorterLoginScreen({ navigation }: any) {
  const { sorterLogin, isLoading } = useAuthStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');

  const handleLogin = async () => {
    if (isLoading) return;
    if (!username.trim() || !password) {
      setError('Enter your username and password.');
      return;
    }
    try {
      setError('');
      await sorterLogin({ username: username.trim(), password });
      // The root navigator swaps to the Sorter stack on its own once the
      // authenticated role changes; there is nothing to navigate to here.
    } catch (err: any) {
      setError(err?.message || 'Login failed');
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Image
            source={require('../../../assets/swachham-logo.png')}
            style={styles.logo}
            resizeMode="contain"
          />
          <Text style={styles.brand}>SWACHHAM</Text>
          <Text style={styles.subtitle}>Sorter Login</Text>

          <View style={styles.field}>
            <Ionicons name="person-outline" size={20} color={COLORS.TextSecondary} />
            <TextInput
              style={styles.input}
              placeholder="Username"
              placeholderTextColor={COLORS.TextSecondary}
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="next"
            />
          </View>

          <View style={styles.field}>
            <Ionicons name="lock-closed-outline" size={20} color={COLORS.TextSecondary} />
            <TextInput
              style={styles.input}
              placeholder="Password"
              placeholderTextColor={COLORS.TextSecondary}
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              returnKeyType="go"
              onSubmitEditing={handleLogin}
            />
            <TouchableOpacity onPress={() => setShowPassword((value) => !value)}>
              <Ionicons
                name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                size={20}
                color={COLORS.TextSecondary}
              />
            </TouchableOpacity>
          </View>

          {error ? (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle-outline" size={16} color={COLORS.Error} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <TouchableOpacity
            style={[styles.button, isLoading && styles.buttonDisabled]}
            onPress={handleLogin}
            disabled={isLoading}
            activeOpacity={0.85}
          >
            {isLoading ? (
              <ActivityIndicator size="small" color={COLORS.Surface} />
            ) : (
              <Text style={styles.buttonText}>LOG IN</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.linkButton}
            onPress={() => navigation.goBack()}
            activeOpacity={0.7}
          >
            <Ionicons name="arrow-back" size={16} color={COLORS.Primary} />
            <Text style={styles.linkText}>Back to customer login</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.Background },
  scroll: { padding: SPACING.lg, paddingTop: SPACING.xxl, alignItems: 'stretch' },
  logo: {
    width: 120,
    height: 120,
    alignSelf: 'center',
    borderWidth: 1,
    borderColor: COLORS.Border,
    borderRadius: BORDER_RADIUS.md,
  },
  brand: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xxl,
    fontWeight: 'bold',
    letterSpacing: 2,
    color: COLORS.PrimaryDark,
    textAlign: 'center',
    marginTop: SPACING.sm,
  },
  subtitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.TextSecondary,
    textAlign: 'center',
    marginBottom: SPACING.xl,
  },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    height: 58,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Surface,
    borderWidth: 1.5,
    borderColor: COLORS.Border,
    paddingHorizontal: SPACING.md,
    marginBottom: SPACING.md,
  },
  input: {
    flex: 1,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.TextPrimary,
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    marginBottom: SPACING.sm,
  },
  errorText: {
    flex: 1,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.Error,
  },
  button: {
    height: 58,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...SHADOWS.medium,
    marginTop: SPACING.sm,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: '800',
    letterSpacing: 0.5,
    color: COLORS.Surface,
  },
  linkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.xs,
    marginTop: SPACING.lg,
    paddingVertical: SPACING.sm,
  },
  linkText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '600',
    color: COLORS.Primary,
  },
});
