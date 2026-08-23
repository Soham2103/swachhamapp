import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS, SHADOWS } from '../../constants/theme';
import BusinessHeader from '../../components/business/BusinessHeader';
import businessOrderApi, { BusinessProfile, BusinessProfileUpdate } from '../../services/businessOrderApi';
import { extractErrorMessage } from '../../services/api';

const CUSTOMER_TYPES = [
  { value: 'HOTEL_RESORT', label: 'Hotel / Resort' },
  { value: 'RESTAURANT', label: 'Restaurant' },
  { value: 'HOSTEL', label: 'Hostel' },
  { value: 'CORPORATE', label: 'Corporate' },
  { value: 'INSTITUTION', label: 'Institution' },
  { value: 'OTHER', label: 'Other' },
];

type FormState = {
  customerType: string;
  otherTypeSpecify: string;
  establishmentAddress: string;
  gstNumber: string;
  panNumber: string;
  website: string;
  contactPersonName: string;
  designation: string;
  mobileNumber: string;
  whatsappNumber: string;
  emailId: string;
  alternateContactPerson: string;
  alternateMobileNo: string;
};

const EMPTY: FormState = {
  customerType: '',
  otherTypeSpecify: '',
  establishmentAddress: '',
  gstNumber: '',
  panNumber: '',
  website: '',
  contactPersonName: '',
  designation: '',
  mobileNumber: '',
  whatsappNumber: '',
  emailId: '',
  alternateContactPerson: '',
  alternateMobileNo: '',
};

const MOBILE_RE = /^[6-9]\d{9}$/;
const GST_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/i;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/i;

function toForm(profile: BusinessProfile): FormState {
  return {
    customerType: profile.customer_type || '',
    otherTypeSpecify: profile.other_type_specify || '',
    establishmentAddress: profile.establishment_address || '',
    gstNumber: profile.gst_number || '',
    panNumber: profile.pan_number || '',
    website: profile.website || '',
    contactPersonName: profile.contact_person_name || '',
    designation: profile.designation || '',
    mobileNumber: profile.mobile_number || '',
    whatsappNumber: profile.whatsapp_number || '',
    emailId: profile.email_id || '',
    alternateContactPerson: profile.alternate_contact_person || '',
    alternateMobileNo: profile.alternate_mobile_no || '',
  };
}

export default function BusinessProfileDetailsScreen({ navigation }: any) {
  const [profile, setProfile] = useState<BusinessProfile | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [isEditing, setIsEditing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const load = useCallback(async () => {
    try {
      setError('');
      setIsLoading(true);
      const response = await businessOrderApi.getProfile();
      setProfile(response.data);
      setForm(toForm(response.data));
    } catch (err: any) {
      setError(extractErrorMessage(err, 'Failed to load profile'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setField = (key: keyof FormState, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setError('');
    setSuccess('');
  };

  const validate = (): string | null => {
    if (!form.customerType) return 'Please select a customer type.';
    if (form.customerType === 'OTHER' && !form.otherTypeSpecify.trim()) {
      return 'Please specify the customer type.';
    }
    if (form.establishmentAddress.trim().length < 5) {
      return 'Establishment address must be at least 5 characters.';
    }
    if (form.contactPersonName.trim().length < 2) {
      return 'Contact person name is required.';
    }
    if (!MOBILE_RE.test(form.mobileNumber.trim())) {
      return 'Enter a valid 10-digit mobile number.';
    }
    if (form.whatsappNumber.trim() && !MOBILE_RE.test(form.whatsappNumber.trim())) {
      return 'Enter a valid 10-digit WhatsApp number.';
    }
    if (form.alternateMobileNo.trim() && !MOBILE_RE.test(form.alternateMobileNo.trim())) {
      return 'Enter a valid 10-digit alternate mobile number.';
    }
    if (form.gstNumber.trim() && !GST_RE.test(form.gstNumber.trim())) {
      return 'Enter a valid GST number.';
    }
    if (form.panNumber.trim() && !PAN_RE.test(form.panNumber.trim())) {
      return 'Enter a valid PAN number.';
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.emailId.trim())) {
      return 'Enter a valid email address.';
    }
    if (form.website.trim() && !/^https?:\/\/.+/i.test(form.website.trim())) {
      return 'Website must start with http:// or https://';
    }
    return null;
  };

  const handleSave = async () => {
    if (isSaving) return;
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      setSuccess('');
      return;
    }

    const payload: BusinessProfileUpdate = {
      customerType: form.customerType,
      otherTypeSpecify: form.otherTypeSpecify.trim() || null,
      establishmentAddress: form.establishmentAddress.trim(),
      gstNumber: form.gstNumber.trim() || null,
      panNumber: form.panNumber.trim() || null,
      website: form.website.trim() || null,
      contactPersonName: form.contactPersonName.trim(),
      designation: form.designation.trim() || null,
      mobileNumber: form.mobileNumber.trim(),
      whatsappNumber: form.whatsappNumber.trim() || null,
      emailId: form.emailId.trim(),
      alternateContactPerson: form.alternateContactPerson.trim() || null,
      alternateMobileNo: form.alternateMobileNo.trim() || null,
    };

    try {
      setIsSaving(true);
      setError('');
      const response = await businessOrderApi.updateProfile(payload);
      setProfile(response.data);
      setForm(toForm(response.data));
      setIsEditing(false);
      setSuccess('Profile updated successfully.');
    } catch (err: any) {
      setError(extractErrorMessage(err, 'Failed to update profile'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    if (profile) setForm(toForm(profile));
    setIsEditing(false);
    setError('');
    setSuccess('');
  };

  const renderField = (
    label: string,
    key: keyof FormState,
    options?: { keyboardType?: any; autoCapitalize?: any; multiline?: boolean; maxLength?: number }
  ) => (
    <View style={styles.fieldGroup} key={key}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {isEditing ? (
        <TextInput
          style={[styles.input, options?.multiline && styles.inputMultiline]}
          value={form[key]}
          onChangeText={(text) => setField(key, text)}
          placeholder={`Enter ${label.toLowerCase()}`}
          placeholderTextColor={COLORS.TextSecondary}
          keyboardType={options?.keyboardType}
          autoCapitalize={options?.autoCapitalize ?? 'sentences'}
          multiline={options?.multiline}
          maxLength={options?.maxLength}
        />
      ) : (
        <Text style={styles.fieldValue}>{form[key] || '—'}</Text>
      )}
    </View>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Shared Business header: Swachham logo on the left. */}
      <BusinessHeader
        title="User Profile"
        onBack={() => navigation.goBack()}
        action={
          isEditing ? undefined : (
            <TouchableOpacity style={styles.iconButton} onPress={() => setIsEditing(true)}>
              <Ionicons name="create-outline" size={22} color={COLORS.Primary} />
            </TouchableOpacity>
          )
        }
      />

      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={COLORS.Primary} />
        </View>
      ) : (
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
            {/* Set at registration — displayed, never edited here. */}
            <View style={styles.nameCard}>
              <Text style={styles.nameLabel}>Business Name</Text>
              <Text style={styles.nameValue}>{profile?.business_name || '—'}</Text>
              <View style={styles.lockedBadge}>
                <Ionicons name="lock-closed" size={12} color={COLORS.TextSecondary} />
                <Text style={styles.lockedText}>Set during registration</Text>
              </View>
            </View>

            {error ? (
              <View style={[styles.banner, styles.bannerError]}>
                <Ionicons name="alert-circle-outline" size={16} color={COLORS.Error} />
                <Text style={[styles.bannerText, { color: COLORS.Error }]}>{error}</Text>
              </View>
            ) : null}

            {success ? (
              <View style={[styles.banner, styles.bannerSuccess]}>
                <Ionicons name="checkmark-circle-outline" size={16} color={COLORS.Success} />
                <Text style={[styles.bannerText, { color: COLORS.Success }]}>{success}</Text>
              </View>
            ) : null}

            <View style={styles.card}>
              <Text style={styles.fieldLabel}>Customer Type</Text>
              {isEditing ? (
                <View style={styles.chipWrap}>
                  {CUSTOMER_TYPES.map((type) => {
                    const active = form.customerType === type.value;
                    return (
                      <TouchableOpacity
                        key={type.value}
                        style={[styles.chip, active && styles.chipActive]}
                        onPress={() => setField('customerType', type.value)}
                      >
                        <Text style={[styles.chipText, active && styles.chipTextActive]}>{type.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              ) : (
                <Text style={styles.fieldValue}>
                  {CUSTOMER_TYPES.find((t) => t.value === form.customerType)?.label || '—'}
                </Text>
              )}

              {form.customerType === 'OTHER'
                ? renderField('Specify Type', 'otherTypeSpecify')
                : null}

              {renderField('Establishment Address', 'establishmentAddress', { multiline: true })}

              {/* The registration type is shown, never edited here: whether an
                  account is B2B or B2C is set at registration and changed by a
                  Super Admin, because it decides whether a GSTIN is required. */}
              <Text style={styles.fieldLabel}>Registration Type</Text>
              <Text style={styles.fieldValue}>{profile?.registration_type || '—'}</Text>

              {/* A B2C account has no GST number, so the field is not offered
                  rather than shown permanently blank. */}
              {profile?.registration_type === 'B2C'
                ? null
                : renderField('GST Number', 'gstNumber', {
                    autoCapitalize: 'characters',
                    maxLength: 15,
                  })}
              {renderField('PAN Number', 'panNumber', { autoCapitalize: 'characters', maxLength: 10 })}
              {renderField('Website', 'website', { autoCapitalize: 'none' })}
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Contact Details</Text>
              {renderField('Contact Person Name', 'contactPersonName')}
              {renderField('Designation', 'designation')}
              {renderField('Mobile Number', 'mobileNumber', { keyboardType: 'phone-pad', maxLength: 10 })}
              {renderField('WhatsApp Number', 'whatsappNumber', { keyboardType: 'phone-pad', maxLength: 10 })}
              {renderField('Email ID', 'emailId', { keyboardType: 'email-address', autoCapitalize: 'none' })}
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Alternate Contact</Text>
              {renderField('Alternate Contact Person', 'alternateContactPerson')}
              {renderField('Alternate Mobile No', 'alternateMobileNo', {
                keyboardType: 'phone-pad',
                maxLength: 10,
              })}
            </View>

            {isEditing ? (
              <View style={styles.actionRow}>
                <TouchableOpacity
                  style={[styles.button, styles.buttonSecondary]}
                  onPress={handleCancel}
                  disabled={isSaving}
                >
                  <Text style={styles.buttonSecondaryText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.button, styles.buttonPrimary, isSaving && styles.buttonDisabled]}
                  onPress={handleSave}
                  disabled={isSaving}
                >
                  {isSaving ? (
                    <ActivityIndicator size="small" color={COLORS.Surface} />
                  ) : (
                    <Text style={styles.buttonPrimaryText}>Save Changes</Text>
                  )}
                </TouchableOpacity>
              </View>
            ) : null}
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.Background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
  },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: COLORS.Surface,
    alignItems: 'center',
    justifyContent: 'center',
    ...SHADOWS.light,
  },
  headerTitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: 'bold',
    color: COLORS.TextPrimary,
  },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: SPACING.md, paddingBottom: SPACING.xxl },
  nameCard: {
    backgroundColor: COLORS.Primary,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.lg,
    marginBottom: SPACING.md,
  },
  nameLabel: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.Surface,
    opacity: 0.85,
  },
  nameValue: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xxl,
    fontWeight: 'bold',
    color: COLORS.Surface,
    marginTop: SPACING.xs,
  },
  lockedBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: SPACING.sm },
  lockedText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.Surface,
    opacity: 0.8,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    padding: SPACING.sm,
    borderRadius: BORDER_RADIUS.sm,
    marginBottom: SPACING.md,
  },
  bannerError: { backgroundColor: COLORS.Error + '15' },
  bannerSuccess: { backgroundColor: COLORS.Success + '15' },
  bannerText: { flex: 1, fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm },
  card: {
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.md,
    marginBottom: SPACING.md,
    ...SHADOWS.light,
  },
  cardTitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: 'bold',
    color: COLORS.TextPrimary,
    marginBottom: SPACING.sm,
  },
  fieldGroup: { marginTop: SPACING.md },
  fieldLabel: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '600',
    color: COLORS.TextSecondary,
    marginBottom: SPACING.xs,
  },
  fieldValue: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.TextPrimary,
  },
  input: {
    borderWidth: 1,
    borderColor: COLORS.Border,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: COLORS.Background,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.TextPrimary,
  },
  inputMultiline: { minHeight: 72, textAlignVertical: 'top' },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs },
  chip: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    borderRadius: BORDER_RADIUS.full,
    borderWidth: 1,
    borderColor: COLORS.Border,
    backgroundColor: COLORS.Background,
  },
  chipActive: { backgroundColor: COLORS.Primary, borderColor: COLORS.Primary },
  chipText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
  },
  chipTextActive: { color: COLORS.Surface, fontWeight: '600' },
  actionRow: { flexDirection: 'row', gap: SPACING.md },
  button: {
    flex: 1,
    height: 50,
    borderRadius: BORDER_RADIUS.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonPrimary: { backgroundColor: COLORS.Primary, ...SHADOWS.medium },
  buttonPrimaryText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: 'bold',
    color: COLORS.Surface,
  },
  buttonSecondary: { backgroundColor: COLORS.Surface, borderWidth: 1, borderColor: COLORS.Border },
  buttonSecondaryText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '600',
    color: COLORS.TextPrimary,
  },
  buttonDisabled: { opacity: 0.6 },
});
