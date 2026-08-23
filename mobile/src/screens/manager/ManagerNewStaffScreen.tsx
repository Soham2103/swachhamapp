import React, { useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator, TextInput,
  KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import { sa } from '../superadmin/styles';
import managerApi from '../../services/managerApi';

/**
 * New Rider / New Sorter.
 *
 * ONE SCREEN FOR BOTH. A rider and a sorter are the same three fields and the
 * same workflow — they differ only in the role the approval assigns — so the
 * kind is a route parameter rather than a duplicated screen.
 *
 * The fields are the ones the existing `users` table already holds for staff
 * accounts: name, email and mobile. The email is the username, which is why
 * it is required here even though the column is nullable.
 *
 * Submitting produces a PENDING request. No account exists until a Super
 * Admin approves, and the password is generated at that point — never here.
 */

type Kind = 'RIDER' | 'SORTER';

const COPY: Record<Kind, { title: string; noun: string }> = {
  RIDER: { title: 'New Rider', noun: 'rider' },
  SORTER: { title: 'New Sorter', noun: 'sorter' },
};

export default function ManagerNewStaffScreen({ navigation, route }: any) {
  const kind: Kind = route?.params?.kind === 'SORTER' ? 'SORTER' : 'RIDER';
  const copy = COPY[kind];

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [mobile, setMobile] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const payload = { name, email, mobile_number: mobile };
      if (kind === 'RIDER') await managerApi.submitRider(payload);
      else await managerApi.submitSorter(payload);

      Alert.alert(
        'Request submitted',
        `The ${copy.noun} request has been sent to a Super Admin for approval. The account is created once it is approved.`,
        [{ text: 'OK', onPress: () => navigation.goBack() }]
      );
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Could not submit the request.');
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = name.trim() !== '' && email.trim() !== '' && mobile.trim().length === 10;

  return (
    <SafeAreaView style={sa.container} edges={['top']}>
      <View style={sa.header}>
        <TouchableOpacity style={sa.iconBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={22} color={COLORS.TextPrimary} />
        </TouchableOpacity>
        <Text style={sa.headerTitle}>{copy.title}</Text>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={sa.scroll} keyboardShouldPersistTaps="handled">
          {!!error && (
            <View style={sa.errorBox}>
              <Ionicons name="alert-circle-outline" size={16} color={COLORS.Error} />
              <Text style={sa.errorText}>{error}</Text>
            </View>
          )}

          <View style={sa.card}>
            <Text
              style={{
                fontFamily: TYPOGRAPHY.fontFamily,
                fontSize: TYPOGRAPHY.sizes.lg,
                fontWeight: '800',
                color: COLORS.PrimaryDark,
              }}
            >
              {copy.title.replace('New ', '')} Details
            </Text>

            <Text style={sa.label}>
              NAME <Text style={sa.required}>*</Text>
            </Text>
            <TextInput
              style={sa.input}
              value={name}
              onChangeText={setName}
              placeholder="Full name"
              placeholderTextColor={COLORS.TextSecondary}
            />

            {/* The email is the login username once the account is approved. */}
            <Text style={sa.label}>
              EMAIL ID <Text style={sa.required}>*</Text>
            </Text>
            <TextInput
              style={sa.input}
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              placeholder="Becomes the login username"
              placeholderTextColor={COLORS.TextSecondary}
            />

            <Text style={sa.label}>
              MOBILE NUMBER <Text style={sa.required}>*</Text>
            </Text>
            <TextInput
              style={sa.input}
              value={mobile}
              onChangeText={setMobile}
              keyboardType="phone-pad"
              maxLength={10}
              placeholder="10-digit Indian mobile"
              placeholderTextColor={COLORS.TextSecondary}
            />
          </View>

          <TouchableOpacity
            style={[sa.button, (!canSubmit || busy) && sa.buttonDisabled]}
            onPress={submit}
            disabled={!canSubmit || busy}
          >
            {busy ? (
              <ActivityIndicator color={COLORS.Surface} />
            ) : (
              <Text style={sa.buttonText}>Submit Request</Text>
            )}
          </TouchableOpacity>

          <Text style={[sa.cardMeta, { marginTop: SPACING.sm, textAlign: 'center' }]}>
            A Super Admin reviews this. The account and its password are created only
            after approval.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
