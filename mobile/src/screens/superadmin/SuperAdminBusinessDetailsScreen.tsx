import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, TextInput, TouchableOpacity, ActivityIndicator,
  KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING } from '../../constants/theme';
import { sa } from './styles';
import { Pill } from './SuperAdminApprovalsScreen';
import superAdminApi, { BusinessDetail } from '../../services/superAdminApi';
import { downloadBusinessProfilePdf } from '../../utils/businessProfilePdf';

/**
 * What the server refuses to let a business order without.
 *
 * `gst_number` is on the list for a B2B registration ONLY. A B2C account has
 * no GSTIN by definition, so marking it required there would put a red
 * asterisk on a field the server does not ask for -- and the server, which
 * returns `missing_fields`, is the authority either way.
 */
const MANDATORY = [
  'establishment_name',
  'establishment_address',
  'contact_person_name',
  'mobile_number',
  'email_id',
];

const B2B_ONLY_MANDATORY = ['gst_number'];

/**
 * Company / Establishment Details, as the super admin sees it.
 *
 * Onboarding is done for the client, so details get missed. This screen
 * exists to close those gaps: the fields the server counts as mandatory
 * are marked, and any that are still blank are highlighted so the work
 * left to do is obvious at a glance rather than discovered at checkout.
 *
 * The server is the authority on what is missing -- this screen renders
 * `missing_fields` from the API rather than deciding for itself, so the
 * two can never disagree.
 *
 * PRINT PDF lives on this page, not on the business list. The document is one
 * business's profile, so the action belongs where that profile is on screen.
 */
export default function SuperAdminBusinessDetailsScreen({ navigation, route }: any) {
  const businessId: string = route.params.businessId;

  const [detail, setDetail] = useState<BusinessDetail | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const d = await superAdminApi.getBusinessDetail(businessId);
      setDetail(d);
      setForm({
        establishmentName: d.business_name || '',
        establishmentAddress: d.establishment_address || '',
        gstNumber: d.gst_number || '',
        contactPersonName: d.contact_person_name || '',
        mobileNumber: d.mobile_number || '',
        emailId: d.email_id || '',
        panNumber: d.pan_number || '',
        designation: d.designation || '',
        website: d.website || '',
        whatsappNumber: d.whatsapp_number || '',
      });
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Could not load this business');
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const isMissing = (key: string) =>
    !!detail?.missing_fields?.some((f) => f.key === key);

  /**
   * Print PDF, for the business currently on screen.
   *
   * The document is built on the server from this one business's record, so
   * what is printed is what is stored rather than what this form happens to
   * be showing — an unsaved edit is not in it.
   */
  const printPdf = async () => {
    setPrinting(true);
    try {
      const result = await downloadBusinessProfilePdf(
        businessId,
        detail?.business_name || 'Business'
      );
      if (!result.shared) {
        Alert.alert('PDF saved', `Saved to ${result.uri}`);
      }
    } catch (e: any) {
      Alert.alert('Could not generate PDF', e?.response?.data?.message || e.message);
    } finally {
      setPrinting(false);
    }
  };

  const isB2B = (detail?.registration_type || 'B2B') === 'B2B';

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      // Only send what was actually filled in; a blank optional field
      // should stay untouched rather than be overwritten with ''.
      const payload: Record<string, unknown> = {};
      Object.entries(form).forEach(([key, value]) => {
        const trimmed = String(value).trim();
        if (trimmed !== '') payload[key] = trimmed;
      });

      const updated = await superAdminApi.updateBusinessDetail(businessId, payload);
      setDetail(updated);
      Alert.alert(
        updated.is_complete ? 'Details complete' : 'Saved',
        updated.is_complete
          ? 'This business can now place orders.'
          : 'Still missing: ' + updated.missing_fields.map((f) => f.label).join(', '),
        [{ text: 'OK' }]
      );
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={sa.centered} edges={['top']}>
        <ActivityIndicator size="large" color={COLORS.Primary} />
      </SafeAreaView>
    );
  }

  const field = (
    label: string,
    key: string,
    serverKey: string,
    opts: { keyboardType?: any; autoCapitalize?: any; multiline?: boolean } = {}
  ) => {
    const mandatory =
      MANDATORY.includes(serverKey) ||
      (isB2B && B2B_ONLY_MANDATORY.includes(serverKey));
    const missing = isMissing(serverKey);
    return (
      <View key={key}>
        <Text style={sa.label}>
          {label}
          {mandatory ? <Text style={sa.required}> *</Text> : null}
          {missing ? '  ·  required, currently blank' : ''}
        </Text>
        <TextInput
          style={[sa.input, missing && sa.inputMissing, opts.multiline && { minHeight: 72 }]}
          value={form[key]}
          onChangeText={(v) => setForm((f) => ({ ...f, [key]: v }))}
          placeholder={label}
          placeholderTextColor={COLORS.TextSecondary}
          keyboardType={opts.keyboardType}
          autoCapitalize={opts.autoCapitalize}
          multiline={opts.multiline}
        />
      </View>
    );
  };

  return (
    <SafeAreaView style={sa.container} edges={['top']}>
      <View style={sa.header}>
        <TouchableOpacity style={sa.iconBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={22} color={COLORS.TextPrimary} />
        </TouchableOpacity>
        <Text style={sa.headerTitle} numberOfLines={1}>
          Establishment Details
        </Text>
      </View>

      <KeyboardAvoidingView
        style={sa.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={sa.scroll} keyboardShouldPersistTaps="handled">
          <View style={sa.card}>
            <Text style={sa.cardTitle}>{detail?.business_name}</Text>
            <Text style={sa.cardMeta}>
              {detail?.registration_type || 'B2B'} registration
              {isB2B ? '' : ' — no GST number is collected for a B2C account'}
            </Text>
            <Pill status={detail?.status || 'ACTIVE'} />
          </View>

          {detail && !detail.is_complete && (
            <View style={sa.warnBox}>
              <Ionicons name="alert-circle-outline" size={16} color="#8A5200" />
              <Text style={sa.warnText}>
                Cannot place orders. Missing:{' '}
                {detail.missing_fields.map((f) => f.label).join(', ')}
              </Text>
            </View>
          )}
          {detail?.is_complete && (
            <View style={[sa.warnBox, { backgroundColor: '#E6F4EC' }]}>
              <Ionicons name="checkmark-circle-outline" size={16} color="#1B4332" />
              <Text style={[sa.warnText, { color: '#1B4332' }]}>
                All required details are on file. This business can order.
              </Text>
            </View>
          )}

          {!!error && (
            <View style={sa.errorBox}>
              <Ionicons name="alert-circle-outline" size={16} color={COLORS.Error} />
              <Text style={sa.errorText}>{error}</Text>
            </View>
          )}

          {field('Establishment name', 'establishmentName', 'establishment_name')}
          {field('Address', 'establishmentAddress', 'establishment_address', { multiline: true })}
          {/* Shown for a B2B record only. The registration type itself is
              changed on the full Business form, where switching to B2C also
              clears the GSTIN server-side. */}
          {isB2B
            ? field('GST number', 'gstNumber', 'gst_number', { autoCapitalize: 'characters' })
            : null}
          {field('Contact person name', 'contactPersonName', 'contact_person_name')}
          {field('Mobile number', 'mobileNumber', 'mobile_number', { keyboardType: 'number-pad' })}
          {field('Email ID', 'emailId', 'email_id', {
            keyboardType: 'email-address',
            autoCapitalize: 'none',
          })}

          {/* Every other number this business answers on is an alternative
              contact, edited on the full Business form rather than as a bare
              list of digits: a number with no name and no login switch is not
              something the Super Admin can act on. */}
          <TouchableOpacity
            style={[sa.buttonGhost, { marginTop: SPACING.lg }]}
            onPress={() => navigation.navigate('SuperAdminEditBusiness', { businessId })}
          >
            <Text style={sa.buttonGhostText}>Edit full business record & contacts</Text>
          </TouchableOpacity>

          {/* Print PDF lives here, on the page showing the profile it prints.
              It reads the SAVED record, so it is offered whether or not the
              form above has unsaved edits — and prints the stored one. */}
          <TouchableOpacity
            style={[sa.buttonGhost, printing && sa.buttonDisabled]}
            onPress={printPdf}
            disabled={printing}
            accessibilityRole="button"
            accessibilityLabel={`Print the business profile PDF for ${detail?.business_name || 'this business'}`}
          >
            {printing ? (
              <ActivityIndicator color={COLORS.Primary} />
            ) : (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.xs }}>
                <Ionicons name="print-outline" size={18} color={COLORS.Primary} />
                <Text style={sa.buttonGhostText}>Print PDF</Text>
              </View>
            )}
          </TouchableOpacity>

          <Text style={[sa.label, { marginTop: 24 }]}>OPTIONAL</Text>
          {field('PAN number', 'panNumber', 'pan_number', { autoCapitalize: 'characters' })}
          {field('Designation', 'designation', 'designation')}
          {field('WhatsApp number', 'whatsappNumber', 'whatsapp_number', {
            keyboardType: 'number-pad',
          })}
          {field('Website', 'website', 'website', { autoCapitalize: 'none' })}

          <TouchableOpacity
            style={[sa.button, saving && sa.buttonDisabled]}
            onPress={save}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator color={COLORS.Surface} />
            ) : (
              <Text style={sa.buttonText}>Save details</Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
