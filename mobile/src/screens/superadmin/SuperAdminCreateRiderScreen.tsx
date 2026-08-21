import React, { useState } from 'react';
import {
  View, Text, ScrollView, TextInput, TouchableOpacity, ActivityIndicator,
  KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../../constants/theme';
import { sa } from './styles';
import superAdminApi from '../../services/superAdminApi';

/**
 * Creates a rider account.
 *
 * A rider created here is approved on the spot -- it was entered by the
 * person who would otherwise approve it, so routing it into their own
 * queue would be theatre. The password is set once and shown nowhere
 * afterwards, so it has to be handed over at this point.
 */
export default function SuperAdminCreateRiderScreen({ navigation }: any) {
  const [form, setForm] = useState({ name: '', mobile_number: '', email: '', password: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    setError('');
    if (!form.name.trim()) return setError('Rider name is required');
    if (!/^[6-9]\d{9}$/.test(form.mobile_number.trim()))
      return setError('Enter a valid 10-digit mobile number');
    if (form.password.length < 8) return setError('Password must be at least 8 characters');

    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        mobile_number: form.mobile_number.trim(),
        password: form.password,
      };
      if (form.email.trim()) payload.email = form.email.trim();

      const created = await superAdminApi.createRider(payload);
      Alert.alert(
        'Rider created',
        `${created.name} can sign in with ${form.mobile_number.trim()} and the password you set. The password is not shown again.`,
        [{ text: 'OK', onPress: () => navigation.goBack() }]
      );
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Could not create the rider');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={sa.container} edges={['top']}>
      <View style={sa.header}>
        <TouchableOpacity style={sa.iconBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={22} color={COLORS.TextPrimary} />
        </TouchableOpacity>
        <Text style={sa.headerTitle}>New rider</Text>
      </View>

      <KeyboardAvoidingView style={sa.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={sa.scroll} keyboardShouldPersistTaps="handled">
          {!!error && (
            <View style={sa.errorBox}>
              <Ionicons name="alert-circle-outline" size={16} color={COLORS.Error} />
              <Text style={sa.errorText}>{error}</Text>
            </View>
          )}

          <Text style={sa.label}>Rider name<Text style={sa.required}> *</Text></Text>
          <TextInput
            style={sa.input} value={form.name} onChangeText={(v) => set('name', v)}
            placeholder="Full name" placeholderTextColor={COLORS.TextSecondary}
          />

          <Text style={sa.label}>Mobile number<Text style={sa.required}> *</Text></Text>
          <TextInput
            style={sa.input} value={form.mobile_number}
            onChangeText={(v) => set('mobile_number', v)}
            keyboardType="number-pad" maxLength={10}
            placeholder="10-digit mobile number" placeholderTextColor={COLORS.TextSecondary}
          />

          <Text style={sa.label}>Email (optional)</Text>
          <TextInput
            style={sa.input} value={form.email} onChangeText={(v) => set('email', v)}
            keyboardType="email-address" autoCapitalize="none"
            placeholder="Email" placeholderTextColor={COLORS.TextSecondary}
          />

          <Text style={sa.label}>Password<Text style={sa.required}> *</Text></Text>
          <TextInput
            style={sa.input} value={form.password} onChangeText={(v) => set('password', v)}
            secureTextEntry placeholder="At least 8 characters"
            placeholderTextColor={COLORS.TextSecondary}
          />
          <Text style={[sa.cardMeta, { marginTop: 6 }]}>
            Share this with the rider — it is not shown again.
          </Text>

          <TouchableOpacity
            style={[sa.button, saving && sa.buttonDisabled]}
            onPress={submit} disabled={saving}
          >
            {saving ? <ActivityIndicator color={COLORS.Surface} />
                    : <Text style={sa.buttonText}>Create rider</Text>}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
