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

export default function LoginScreen({ navigation, route }: any) {
  const [role, setRole] = useState<'customer' | 'business'>('customer');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');

  const { customerLogin, businessLogin, isLoading } = useAuthStore();

  const selectRole = (next: 'customer' | 'business') => {
    setRole(next);
    setError('');
  };

  const handleLogin = async () => {
    setError('');

    if (!email.trim() || !password) {
      setError('Please enter both email and password.');
      return;
    }

    try {
      if (role === 'customer') {
        await customerLogin({ email: email.trim(), password });
        // Navigation is handled automatically by the AppNavigator observing isAuthenticated and userType
      } else {
        await businessLogin({ email: email.trim(), password });
      }
    } catch (err: any) {
      console.error('Login error:', err);
      setError(err?.message || 'Login failed. Please try again.');
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
          {/* Header */}
          <View style={styles.headerContainer}>
            <Image
              source={require('../../../assets/swachham-logo.png')}
              style={styles.logo}
              resizeMode="contain"
            />
            <Text style={styles.welcomeText}>Welcome Back</Text>
            <Text style={styles.subtitleText}>Sign in to continue</Text>
          </View>

          {/* Form */}
          <View style={styles.formContainer}>
            
            {/* Role Selection Tabs */}
            <View style={styles.roleTabs}>
              <TouchableOpacity
                style={[styles.roleTab, role === 'customer' && styles.roleTabActive]}
                onPress={() => selectRole('customer')}
              >
                <Ionicons 
                  name="person" 
                  size={16} 
                  color={role === 'customer' ? COLORS.Surface : COLORS.TextSecondary} 
                />
                <Text style={[styles.roleTabText, role === 'customer' && styles.roleTabTextActive]}>
                  Customer
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.roleTab, role === 'business' && styles.roleTabActive]}
                onPress={() => selectRole('business')}
              >
                <Ionicons 
                  name="business" 
                  size={16} 
                  color={role === 'business' ? COLORS.Surface : COLORS.TextSecondary} 
                />
                <Text style={[styles.roleTabText, role === 'business' && styles.roleTabTextActive]}>
                  Business
                </Text>
              </TouchableOpacity>
            </View>

            {/* Email Input */}
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Email Address</Text>
              <View style={[styles.inputContainer, error && styles.inputContainerError]}>
                <Ionicons name="mail-outline" size={20} color={COLORS.TextSecondary} style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  placeholder="Enter your email"
                  placeholderTextColor={COLORS.TextSecondary}
                  value={email}
                  onChangeText={(text) => { setEmail(text); setError(''); }}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
            </View>

            {/* Password Input */}
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Password</Text>
              <View style={[styles.inputContainer, error && styles.inputContainerError]}>
                <Ionicons name="lock-closed-outline" size={20} color={COLORS.TextSecondary} style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  placeholder="Enter your password"
                  placeholderTextColor={COLORS.TextSecondary}
                  value={password}
                  onChangeText={(text) => { setPassword(text); setError(''); }}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                />
                <TouchableOpacity onPress={() => setShowPassword(!showPassword)}>
                  <Ionicons name={showPassword ? "eye-off-outline" : "eye-outline"} size={20} color={COLORS.TextSecondary} />
                </TouchableOpacity>
              </View>
            </View>

            {/* Error Message */}
            {error ? (
              <View style={styles.errorContainer}>
                <Ionicons name="alert-circle-outline" size={16} color="#D32F2F" />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            {/* Forgot Password (Customer only) */}
            {role === 'customer' ? (
              <TouchableOpacity
                style={styles.forgotPasswordContainer}
                onPress={() => navigation.navigate('ForgotPasswordScreen')}
              >
                <Text style={styles.forgotPasswordText}>Forgot Password?</Text>
              </TouchableOpacity>
            ) : null}

            {/* Login Button */}
            <TouchableOpacity
              style={[styles.loginButton, isLoading && styles.loginButtonDisabled]}
              onPress={handleLogin}
              disabled={isLoading}
              activeOpacity={0.8}
            >
              {isLoading ? (
                <>
                  <ActivityIndicator size="small" color={COLORS.Surface} />
                  <Text style={styles.loginButtonText}>Signing in...</Text>
                </>
              ) : (
                <Text style={styles.loginButtonText}>Sign In</Text>
              )}
            </TouchableOpacity>

            {/* Register Link */}
            <View style={styles.registerContainer}>
              <Text style={styles.registerText}>Don't have an account? </Text>
              <TouchableOpacity 
                onPress={() => {
                  if (role === 'customer') {
                    navigation.navigate('CustomerRegisterScreen');
                  } else {
                    navigation.navigate('BusinessRegisterScreen', {
                      verifiedMobile: route?.params?.verifiedMobile,
                    });
                  }
                }}
              >
                <Text style={styles.registerLink}>
                  {role === 'customer' ? 'Register' : 'Register Business'}
                </Text>
              </TouchableOpacity>
            </View>

            {/* No staff links here any more. Everyone signs in through the
                one mobile-number flow, and the server decides from the
                number whether a password step is needed. */}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.Primary,
  },
  keyboardView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
  headerContainer: {
    alignItems: 'center',
    paddingTop: SPACING.xxl,
    paddingBottom: SPACING.xl,
    paddingHorizontal: SPACING.xl,
  },
  logo: {
    width: 80,
    height: 80,
    marginBottom: SPACING.md,
  },
  welcomeText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xxl,
    fontWeight: 'bold',
    color: COLORS.Surface,
    marginBottom: SPACING.xs,
    textAlign: 'center',
  },
  subtitleText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.Surface,
    opacity: 0.9,
    textAlign: 'center',
  },
  formContainer: {
    flex: 1,
    backgroundColor: COLORS.Surface,
    borderTopLeftRadius: BORDER_RADIUS.xl * 1.5,
    borderTopRightRadius: BORDER_RADIUS.xl * 1.5,
    paddingHorizontal: SPACING.xl,
    paddingTop: SPACING.xxl,
    paddingBottom: SPACING.xxl,
  },
  roleTabs: {
    flexDirection: 'row',
    backgroundColor: COLORS.Background,
    borderRadius: BORDER_RADIUS.md,
    padding: 4,
    marginBottom: SPACING.xl,
  },
  roleTab: {
    flex: 1,
    flexDirection: 'row',
    paddingVertical: SPACING.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: BORDER_RADIUS.sm,
    gap: SPACING.xs,
  },
  roleTabActive: {
    backgroundColor: COLORS.Primary,
    ...SHADOWS.light,
  },
  roleTabText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: 'bold',
    color: COLORS.TextSecondary,
  },
  roleTabTextActive: {
    color: COLORS.Surface,
  },
  inputGroup: {
    marginBottom: SPACING.lg,
  },
  label: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '600',
    color: COLORS.TextPrimary,
    marginBottom: SPACING.xs,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.Border,
    borderRadius: BORDER_RADIUS.md,
    paddingHorizontal: SPACING.md,
    height: 55,
    backgroundColor: COLORS.Background,
  },
  inputContainerError: {
    borderColor: '#D32F2F',
  },
  inputIcon: {
    marginRight: SPACING.sm,
  },
  input: {
    flex: 1,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.TextPrimary,
  },
  errorContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: -SPACING.sm,
    marginBottom: SPACING.md,
  },
  errorText: {
    marginLeft: 5,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: '#D32F2F',
    flex: 1,
  },
  forgotPasswordContainer: {
    alignItems: 'flex-end',
    marginBottom: SPACING.xl,
    marginTop: -SPACING.sm,
  },
  forgotPasswordText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '600',
    color: COLORS.Primary,
  },
  loginButton: {
    backgroundColor: COLORS.Primary,
    height: 55,
    borderRadius: BORDER_RADIUS.md,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row',
    ...SHADOWS.medium,
    marginBottom: SPACING.xl,
    gap: SPACING.sm,
  },
  loginButtonDisabled: {
    opacity: 0.7,
  },
  loginButtonText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: 'bold',
    color: COLORS.Surface,
  },
  registerContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
  },
  registerText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.TextSecondary,
  },
  staffLink: { alignItems: 'center', marginTop: SPACING.lg, paddingVertical: SPACING.sm },
  staffLinkText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '600',
    color: COLORS.TextSecondary,
    textDecorationLine: 'underline',
  },
  registerLink: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: 'bold',
    color: COLORS.Primary,
  },
});
