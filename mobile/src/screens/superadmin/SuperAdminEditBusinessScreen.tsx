import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../../constants/theme';
import { sa } from './styles';
import superAdminApi, { BusinessAdmin } from '../../services/superAdminApi';
import BusinessForm, { BusinessFormValue } from '../../components/business/BusinessForm';

/**
 * Business Edit, as the Super Admin sees it.
 *
 * IT IS THE REGISTRATION FORM. `BusinessForm` is the same component the
 * Manager's New Business screen renders — same fields, same validation, same
 * GST verification, same PAN derivation, same "same as legal" auto-fill, same
 * 1..3 alternative contacts. There is deliberately no simplified edit form:
 * a second, smaller form is how fields become uneditable by accident.
 *
 * The only difference from registration is the submit operation: this one
 * PUTs the master record instead of raising a request.
 *
 * WHAT THE SERVER DOES WITH IT. Every rule is re-applied server-side —
 * a changed GSTIN is re-verified against the provider and the PAN is
 * re-derived from it, the contact rules are re-checked, and the alternative
 * contacts are rewritten as rows. Nothing here is trusted.
 */
export default function SuperAdminEditBusinessScreen({ navigation, route }: any) {
  const businessId: string = route.params.businessId;

  const [business, setBusiness] = useState<BusinessAdmin | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setBusiness(await superAdminApi.getManagedBusiness(businessId));
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Could not load this business');
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  /**
   * The record, in the shape the form speaks.
   *
   * The head contact is the business's PRIMARY `business_users` row. The
   * flat `contact_person_name` / `mobile_number` fields the API still
   * reports are read from that same row, so the fallbacks below now only
   * cover a business with no contact row at all.
   */
  const initial = useMemo<Partial<BusinessFormValue> | undefined>(() => {
    if (!business) return undefined;
    const contacts = business.contacts || [];
    const head = contacts.find((c) => c.contact_type === 'BUSINESS_HEAD');

    return {
      registration_type: business.registration_type || 'B2B',
      gstin: business.gst_number || '',
      pan: business.pan_number || '',
      // Legal Name -> businesses.name is the canonical mapping, so `name` is
      // the fallback when the legal_name column was never filled.
      legal_name: business.legal_name || business.name || '',
      legal_address: business.address || '',
      establishment_name: business.establishment_name || '',
      establishment_address: business.establishment_address || '',
      billing_cycle: business.billing_cycle || 'MONTHLY',
      city: business.city || '',
      state: business.state || '',
      pincode: business.pincode || '',
      business_head: {
        name: head?.name || business.contact_person_name || '',
        designation: head?.designation || business.designation || '',
        mobile: head?.mobile || business.mobile_number || '',
        whatsapp: head?.whatsapp || business.whatsapp_number || '',
        email: head?.email || business.email_id || '',
      },
      alternative_contacts: contacts
        .filter((c) => c.contact_type === 'ALTERNATIVE')
        .map((c) => ({
          id: c.id,
          name: c.name,
          designation: c.designation || '',
          mobile: c.mobile || '',
          login_enabled: c.login_enabled,
        })),
    };
  }, [business]);

  const submit = async (value: BusinessFormValue) => {
    const updated = await superAdminApi.updateManagedBusiness(businessId, {
      // Sent only when it differs is not necessary: the server compares it
      // against what is on file and only re-verifies on an actual change.
      registration_type: value.registration_type,
      gstin: value.gstin,
      // Legal Name -> businesses.name, with legal_name kept in step, which is
      // the mapping the approval path already uses.
      name: value.legal_name,
      legal_name: value.legal_name,
      // Legal Address -> businesses.address.
      address: value.legal_address,
      establishment_name: value.establishment_name,
      establishment_address: value.establishment_address,
      billing_cycle: value.billing_cycle,
      city: value.city,
      state: value.state,
      pincode: value.pincode,
      business_head: value.business_head,
      // The whole list, including each contact's login switch. The server
      // enforces the 1..3 rule again before writing any of it.
      alternative_contacts: value.alternative_contacts.map((c) => ({
        name: c.name,
        designation: c.designation,
        mobile: c.mobile,
        login_enabled: c.login_enabled,
      })),
    });
    setBusiness(updated);
    Alert.alert('Saved', `${updated.name} has been updated.`, [
      { text: 'OK', onPress: () => navigation.goBack() },
    ]);
  };

  if (loading) {
    return (
      <SafeAreaView style={sa.centered} edges={['top']}>
        <ActivityIndicator size="large" color={COLORS.Primary} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={sa.container} edges={['top']}>
      <View style={sa.header}>
        <TouchableOpacity style={sa.iconBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={22} color={COLORS.TextPrimary} />
        </TouchableOpacity>
        <Text style={sa.headerTitle} numberOfLines={1}>
          Edit {business?.name || 'Business'}
        </Text>
      </View>

      {!!error && (
        <View style={[sa.errorBox, { margin: 12 }]}>
          <Ionicons name="alert-circle-outline" size={16} color={COLORS.Error} />
          <Text style={sa.errorText}>{error}</Text>
        </View>
      )}

      {initial ? (
        <BusinessForm
          mode="edit"
          initial={initial}
          onSubmit={submit}
          onVerifyGst={(gstin) => superAdminApi.gstLookup(gstin)}
          submitLabel="Save Changes"
          onCancel={() => navigation.goBack()}
        />
      ) : null}
    </SafeAreaView>
  );
}
