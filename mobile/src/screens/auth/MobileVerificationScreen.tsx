import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
  BackHandler,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
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

export default function MobileVerificationScreen({ navigation }: any) {
  const [mobile, setMobile] = useState('');
  const [isOtpSent, setIsOtpSent] = useState(false);
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [timer, setTimer] = useState(0);
  const [error, setError] = useState('');

  const inputRefs = useRef<Array<TextInput | null>>([]);

  const {
    signInSendOtp,
    signInVerifyOtp,
    resendEntryOtp,
    isLoading,
  } = useAuthStore();

  useEffect(() => {
    if (timer <= 0) {
      return;
    }

    const interval = setInterval(() => {
      setTimer((previous) => previous - 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [timer]);

  /**
   * Back has two meanings on this screen:
   *  - while the OTP step is showing, it returns to the mobile-number step
   *    (clearing the entered OTP and any in-flight verification state)
   *  - on the mobile-number step, it leaves for the previous screen in the
   *    auth flow, falling back to PermissionScreen when there is no history.
   */
  const handleBack = useCallback((): boolean => {
    if (isOtpSent) {
      setIsOtpSent(false);
      setOtp(['', '', '', '', '', '']);
      setError('');
      setTimer(0);
      return true;
    }

    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.reset({ index: 0, routes: [{ name: 'PermissionScreen' }] });
    }
    return true;
  }, [isOtpSent, navigation]);

  // Android hardware back follows the same rules as the on-screen button.
  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener('hardwareBackPress', handleBack);
      return () => subscription.remove();
    }, [handleBack])
  );

  const handleSendOtp = async () => {
    const trimmedMobile = mobile.trim();
    if (!trimmedMobile || trimmedMobile.length !== 10) {
      setError('Please enter a valid 10-digit mobile number.');
      return;
    }

    try {
      setError('');
      await signInSendOtp(trimmedMobile);
      setIsOtpSent(true);
      setTimer(30);
      setOtp(['', '', '', '', '', '']);
    } catch (err: any) {
      setError(err?.message || 'Failed to send OTP.');
    }
  };

  const handleOtpChange = (value: string, index: number) => {
    const numericValue = value.replace(/\D/g, '');

    if (numericValue.length > 1) {
      const digits = numericValue.slice(0, 6).split('');
      const updatedOtp = ['', '', '', '', '', ''];
      digits.forEach((digit, i) => {
        updatedOtp[i] = digit;
      });
      setOtp(updatedOtp);
      const lastIndex = Math.min(digits.length - 1, 5);
      inputRefs.current[lastIndex]?.focus();
      return;
    }

    const updatedOtp = [...otp];
    updatedOtp[index] = numericValue;
    setOtp(updatedOtp);
    setError('');

    if (numericValue && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyPress = (event: any, index: number) => {
    if (event.nativeEvent.key === 'Backspace' && !otp[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handleVerify = async () => {
    const enteredOtp = otp.join('');
    if (enteredOtp.length !== 6) {
      setError('Please enter the complete 6-digit OTP.');
      return;
    }

    try {
      setError('');
      const verifiedMobile = mobile.trim();
      const result = await signInVerifyOtp(verifiedMobile, enteredOtp);

      // The SERVER decides what this number is; the app only routes.
      //
      // A customer is already signed in by this point -- the OTP was the
      // credential -- so there is nothing to navigate to: AppNavigator
      // swaps to the customer stack on its own once auth state flips.
      if (result.mode === 'CUSTOMER_SESSION') {
        return;
      }

      if (result.mode === 'PASSWORD_REQUIRED') {
        navigation.navigate('SignInPasswordScreen', {
          role: result.role,
          name: result.name,
          preAuthToken: result.preAuthToken,
          mobile: verifiedMobile,
        });
        return;
      }

      // AMBIGUOUS: the number answers to several accounts, so it grants
      // none of them. Say so plainly instead of failing silently.
      setError(
        result.message ||
          'This mobile number is linked to more than one account. Please contact support.'
      );
    } catch (err: any) {
      setError(err?.message || 'Invalid OTP. Please check the OTP and try again.');
    }
  };

  const handleResend = async () => {
    if (timer > 0 || isLoading) return;

    try {
      setError('');
      await resendEntryOtp(mobile.trim());
      setOtp(['', '', '', '', '', '']);
      setTimer(30);
      inputRefs.current[0]?.focus();
    } catch (err: any) {
      setError(err?.message || 'Unable to resend OTP. Please try again.');
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
        >
          <TouchableOpacity
            style={styles.backButton}
            onPress={handleBack}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Ionicons name="arrow-back" size={24} color={COLORS.Surface} />
          </TouchableOpacity>

          <View style={styles.headerContainer}>
            <View style={styles.iconCircle}>
              <Ionicons name="shield-checkmark-outline" size={42} color={COLORS.Primary} />
            </View>
            <Text style={styles.title}>Verify your number</Text>
            <Text style={styles.subtitle}>Enter your mobile number to continue</Text>
          </View>

          <View style={styles.formContainer}>
            {!isOtpSent ? (
              <View style={styles.inputGroup}>
                <Text style={styles.label}>Mobile Number</Text>
                <View style={[styles.inputContainer, error && styles.inputContainerError]}>
                  <Ionicons name="call-outline" size={20} color={COLORS.TextSecondary} style={styles.inputIcon} />
                  <TextInput
                    style={styles.input}
                    placeholder="Enter your 10-digit mobile number"
                    placeholderTextColor={COLORS.TextSecondary}
                    value={mobile}
                    onChangeText={(text) => { setMobile(text); setError(''); }}
                    keyboardType="phone-pad"
                    maxLength={10}
                  />
                </View>
                {error ? (
                  <View style={styles.errorContainer}>
                    <Ionicons name="alert-circle-outline" size={16} color="#D32F2F" />
                    <Text style={styles.errorText}>{error}</Text>
                  </View>
                ) : null}
                <TouchableOpacity
                  style={[styles.verifyButton, isLoading && styles.verifyButtonDisabled]}
                  onPress={handleSendOtp}
                  disabled={isLoading}
                  activeOpacity={0.8}
                >
                  {isLoading ? (
                    <>
                      <ActivityIndicator size="small" color={COLORS.Surface} />
                      <Text style={styles.verifyButtonText}>Sending...</Text>
                    </>
                  ) : (
                    <Text style={styles.verifyButtonText}>Send OTP</Text>
                  )}
                </TouchableOpacity>
              </View>
            ) : (
              <>
                <Text style={styles.label}>Enter OTP</Text>
                <View style={styles.otpContainer}>
                  {otp.map((digit, index) => (
                    <TextInput
                      key={index}
                      ref={(ref) => { inputRefs.current[index] = ref; }}
                      style={[styles.otpInput, error && styles.otpInputError]}
                      value={digit}
                      onChangeText={(value) => handleOtpChange(value, index)}
                      onKeyPress={(event) => handleKeyPress(event, index)}
                      keyboardType="number-pad"
                      maxLength={1}
                      textContentType={index === 0 ? 'oneTimeCode' : 'none'}
                      autoComplete={index === 0 ? 'sms-otp' : 'off'}
                      selectTextOnFocus
                    />
                  ))}
                </View>

                {error ? (
                  <View style={styles.errorContainer}>
                    <Ionicons name="alert-circle-outline" size={16} color="#D32F2F" />
                    <Text style={styles.errorText}>{error}</Text>
                  </View>
                ) : null}

                <TouchableOpacity
                  style={[styles.verifyButton, (isLoading || otp.join('').length !== 6) && styles.verifyButtonDisabled]}
                  onPress={handleVerify}
                  disabled={isLoading || otp.join('').length !== 6}
                  activeOpacity={0.8}
                >
                  {isLoading ? (
                    <>
                      <ActivityIndicator size="small" color={COLORS.Surface} />
                      <Text style={styles.verifyButtonText}>Verifying...</Text>
                    </>
                  ) : (
                    <Text style={styles.verifyButtonText}>Verify OTP</Text>
                  )}
                </TouchableOpacity>

                <View style={styles.resendContainer}>
                  <Text style={styles.resendText}>Didn't receive the OTP?</Text>
                  <TouchableOpacity disabled={timer > 0 || isLoading} onPress={handleResend}>
                    <Text style={[styles.resendLink, (timer > 0 || isLoading) && styles.resendDisabled]}>
                      {timer > 0 ? `Resend in ${timer}s` : 'Resend OTP'}
                    </Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.Primary },
  keyboardView: { flex: 1 },
  scrollContent: { flexGrow: 1 },
  backButton: {
    marginLeft: SPACING.lg,
    marginTop: SPACING.md,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerContainer: {
    alignItems: 'center',
    paddingTop: SPACING.xl,
    paddingBottom: SPACING.xxl,
    paddingHorizontal: SPACING.xl,
  },
  iconCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: COLORS.Surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: SPACING.lg,
  },
  title: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xxl,
    fontWeight: 'bold',
    color: COLORS.Surface,
    textAlign: 'center',
    marginBottom: SPACING.xs,
  },
  subtitle: {
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
  inputGroup: {
    marginBottom: SPACING.lg,
  },
  label: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '600',
    color: COLORS.TextPrimary,
    marginBottom: SPACING.md,
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
    marginBottom: SPACING.md,
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
  otpContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: SPACING.md,
  },
  otpInput: {
    width: 48,
    height: 55,
    borderWidth: 1,
    borderColor: COLORS.Border,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Background,
    textAlign: 'center',
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xl,
    fontWeight: 'bold',
    color: COLORS.TextPrimary,
  },
  otpInputError: { borderColor: '#D32F2F' },
  errorContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.md,
  },
  errorText: {
    marginLeft: 5,
    flex: 1,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: '#D32F2F',
  },
  verifyButton: {
    height: 55,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Primary,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    ...SHADOWS.medium,
    marginTop: SPACING.md,
    marginBottom: SPACING.xl,
  },
  verifyButtonDisabled: { opacity: 0.5 },
  verifyButtonText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: 'bold',
    color: COLORS.Surface,
  },
  resendContainer: { alignItems: 'center', marginBottom: SPACING.xl },
  resendText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
    marginBottom: SPACING.xs,
  },
  resendLink: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: 'bold',
    color: COLORS.Primary,
  },
  resendDisabled: { color: COLORS.TextSecondary },
});
