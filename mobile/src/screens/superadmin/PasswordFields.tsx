import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import { sa } from './styles';

/**
 * The Password / Confirm password pair the Super Admin types when setting an
 * initial password.
 *
 * ONE COMPONENT FOR ALL FOUR ACCOUNT TYPES — Manager, Business user, Rider,
 * Sorter — so the policy hint, the match check and the show/hide behave
 * identically wherever a password is set. Four copies would drift.
 *
 * The value lives in the parent's state only for as long as the sheet is
 * open; the parent clears it as soon as the request returns. It is never
 * persisted, never written to storage, and the API never sends it back.
 *
 * The checks here are for immediate feedback. The BACKEND validates the same
 * rules and is what actually decides — this cannot be the only gate.
 */

export const PASSWORD_MIN_LENGTH = 8;

/** Mirrors the server's policy, so the hint and the 400 cannot disagree. */
export function passwordProblem(password: string, confirm: string): string | null {
  if (!password) return 'Password is required.';
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`;
  }
  if (!/[A-Za-z]/.test(password)) return 'Password must contain at least one letter.';
  if (!/\d/.test(password)) return 'Password must contain at least one number.';
  if (!confirm) return 'Please confirm the password.';
  if (confirm !== password) return 'Passwords do not match.';
  return null;
}

interface Props {
  password: string;
  confirm: string;
  onChangePassword: (value: string) => void;
  onChangeConfirm: (value: string) => void;
  /** e.g. "PASSWORD" / "NEW PASSWORD". */
  label?: string;
  /** The account this password is for, shown above the fields. */
  username?: string;
}

export default function PasswordFields({
  password,
  confirm,
  onChangePassword,
  onChangeConfirm,
  label = 'PASSWORD',
  username,
}: Props) {
  const [visible, setVisible] = useState(false);
  // Only complain about the match once there is something to compare, so the
  // form does not shout while it is still being filled in.
  const mismatch = confirm.length > 0 && confirm !== password;

  return (
    <View>
      {username ? (
        <>
          <Text style={sa.label}>USERNAME</Text>
          {/* The username is fixed by the account (it is the email), so it is
              shown rather than offered as a field. */}
          <View
            style={[
              sa.input,
              {
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                backgroundColor: COLORS.Background,
              },
            ]}
          >
            <Text
              style={{
                fontFamily: TYPOGRAPHY.fontFamily,
                fontSize: TYPOGRAPHY.sizes.sm,
                color: COLORS.TextPrimary,
              }}
              numberOfLines={1}
            >
              {username}
            </Text>
            <Ionicons name="lock-closed-outline" size={14} color={COLORS.TextSecondary} />
          </View>
        </>
      ) : null}

      <View style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
        <Text style={[sa.label, { flex: 1 }]}>
          {label} <Text style={sa.required}>*</Text>
        </Text>
        <TouchableOpacity
          onPress={() => setVisible((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel={visible ? 'Hide password' : 'Show password'}
          style={{ paddingBottom: SPACING.xs }}
        >
          <Text
            style={{
              fontFamily: TYPOGRAPHY.fontFamily,
              fontSize: TYPOGRAPHY.sizes.xs,
              fontWeight: '700',
              color: COLORS.Primary,
            }}
          >
            {visible ? 'HIDE' : 'SHOW'}
          </Text>
        </TouchableOpacity>
      </View>
      <TextInput
        style={sa.input}
        value={password}
        onChangeText={onChangePassword}
        secureTextEntry={!visible}
        autoCapitalize="none"
        autoCorrect={false}
        /* Keeps the OS from offering to save a password that belongs to
           someone else's account, not to the person typing it. */
        textContentType="none"
        autoComplete="off"
        placeholder={`At least ${PASSWORD_MIN_LENGTH} characters, a letter and a number`}
        placeholderTextColor={COLORS.TextSecondary}
      />

      <Text style={sa.label}>
        CONFIRM PASSWORD <Text style={sa.required}>*</Text>
      </Text>
      <TextInput
        style={[sa.input, mismatch && { borderColor: COLORS.Error }]}
        value={confirm}
        onChangeText={onChangeConfirm}
        secureTextEntry={!visible}
        autoCapitalize="none"
        autoCorrect={false}
        textContentType="none"
        autoComplete="off"
        placeholder="Re-enter the password"
        placeholderTextColor={COLORS.TextSecondary}
      />
      {mismatch ? (
        <Text
          style={{
            fontFamily: TYPOGRAPHY.fontFamily,
            fontSize: TYPOGRAPHY.sizes.xs,
            color: COLORS.Error,
            marginTop: SPACING.xs,
          }}
        >
          Passwords do not match.
        </Text>
      ) : null}

      <Text
        style={{
          fontFamily: TYPOGRAPHY.fontFamily,
          fontSize: TYPOGRAPHY.sizes.xs,
          color: COLORS.TextSecondary,
          marginTop: SPACING.sm,
          lineHeight: 18,
        }}
      >
        This exact password is emailed to the account holder. Only its hash is stored, so it
        cannot be looked up again afterwards.
      </Text>
    </View>
  );
}
