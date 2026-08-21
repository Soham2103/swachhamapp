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

const TYPES = ['HOTEL_RESORT', 'RESTAURANT', 'HOSTEL', 'CORPORATE', 'INSTITUTION', 'OTHER'];

/**
 * Onboards a business directly.
 *
 * Everything the ordering gate requires is asked for here, marked *, so
 * an account created through this screen can trade immediately instead
 * of landing straight back in the incomplete queue.
 */
export default function SuperAdminCreateBusinessScreen({ navigation }: any) {
  const [form, setForm] = useState<Record<string, string>>({
    name: '', business_type: 'HOTEL_RESORT', contact_person_name: '',
    mobile_number: '', email: '', address: '', city: '', state: '',
    pincode: '', gst_number: '', pan_number: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    setError('');
    // Checked here for a fast, friendly message; the server checks again
    // and is the one that actually decides.
    for (const [key, label] of [
      ['name', 'Establishment name'], ['address', 'Address'], ['city', 'City'],
      ['mobile_number', 'Mobile number'], ['contact_person_name', 'Contact person'],
      ['gst_number', 'GST number'], ['email', 'Email ID'],
    ] as const) {
      if (!form[key]?.trim()) { setError(label + ' is required'); return; }
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {};
      Object.entries(form).forEach(([k, v]) => { if (v.trim()) payload[k] = v.trim(); });
      const created = await superAdminApi.createBusiness(payload);
      Alert.alert('Business created', `${created.name} is active and can order.`, [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Could not create the business');
    } finally {
      setSaving(false);
    }
  };

  const field = (label: string, key: string, required: boolean, opts: any = {}) => (
    <View>
      <Text style={sa.label}>
        {label}{required ? <Text style={sa.required}> *</Text> : null}
      </Text>
      <TextInput
        style={[sa.input, opts.multiline && { minHeight: 72 }]}
        value={form[key]}
        onChangeText={(v) => set(key, v)}
        placeholder={label}
        placeholderTextColor={COLORS.TextSecondary}
        {...opts}
      />
    </View>
  );

  return (
    <SafeAreaView style={sa.container} edges={['top']}>
      <View style={sa.header}>
        <TouchableOpacity style={sa.iconBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={22} color={COLORS.TextPrimary} />
        </TouchableOpacity>
        <Text style={sa.headerTitle}>New business</Text>
      </View>

      <KeyboardAvoidingView style={sa.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={sa.scroll} keyboardShouldPersistTaps="handled">
          {!!error && (
            <View style={sa.errorBox}>
              <Ionicons name="alert-circle-outline" size={16} color={COLORS.Error} />
              <Text style={sa.errorText}>{error}</Text>
            </View>
          )}

          {field('Establishment name', 'name', true)}

          <Text style={sa.label}>Type</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {TYPES.map((t) => (
              <TouchableOpacity
                key={t}
                style={[sa.tab, { flex: 0, paddingHorizontal: 12 },
                  form.business_type === t && sa.tabActive]}
                onPress={() => set('business_type', t)}
              >
                <Text style={[sa.tabText, form.business_type === t && sa.tabTextActive]}>
                  {t.replace('_', ' ')}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {field('Address', 'address', true, { multiline: true })}
          {field('City', 'city', true)}
          {field('Contact person name', 'contact_person_name', true)}
          {field('Mobile number', 'mobile_number', true, { keyboardType: 'number-pad', maxLength: 10 })}
          {field('Email ID', 'email', true, { keyboardType: 'email-address', autoCapitalize: 'none' })}
          {field('GST number', 'gst_number', true, { autoCapitalize: 'characters' })}
          <Text style={[sa.label, { marginTop: 24 }]}>OPTIONAL</Text>
          {field('State', 'state', false)}
          {field('Pincode', 'pincode', false, { keyboardType: 'number-pad', maxLength: 6 })}
          {field('PAN number', 'pan_number', false, { autoCapitalize: 'characters' })}

          <TouchableOpacity
            style={[sa.button, saving && sa.buttonDisabled]}
            onPress={submit}
            disabled={saving}
          >
            {saving ? <ActivityIndicator color={COLORS.Surface} />
                    : <Text style={sa.buttonText}>Create business</Text>}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
