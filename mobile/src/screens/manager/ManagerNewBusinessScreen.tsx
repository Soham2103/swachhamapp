import React from 'react';
import { View, Text, TouchableOpacity, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../../constants/theme';
import { sa } from '../superadmin/styles';
import managerApi from '../../services/managerApi';
import BusinessForm, { BusinessFormValue } from '../../components/business/BusinessForm';

/**
 * New Business — the Manager's submission form.
 *
 * The form itself is `BusinessForm`, the SAME component the Super Admin's
 * Business Edit screen renders. That is the point: registration and editing
 * ask for the same thing, so they are one form with one set of validation,
 * one GST verification flow, one PAN derivation and one set of auto-fill
 * rules. This screen supplies only the submit operation.
 *
 * B2B / B2C is chosen on the form itself, which is why it is not two screens:
 * the fields, the order and the styling are identical either way, and the
 * only difference is whether the GST field is required or disabled.
 *
 * NOTHING HERE CREATES A BUSINESS. Submitting produces a PENDING request; a
 * Super Admin approves it, and the server re-verifies the GSTIN and
 * re-derives the PAN at that point regardless of what this screen sent.
 */
export default function ManagerNewBusinessScreen({ navigation }: any) {
  const submit = async (value: BusinessFormValue) => {
    await managerApi.submitBusiness({
      // B2B or B2C. The server re-applies the rule this choice implies -- a
      // B2B request without a GSTIN is refused there too, and a GSTIN sent
      // with a B2C one is discarded -- so the disabled field is a
      // convenience, never the enforcement.
      registration_type: value.registration_type,
      gstin: value.gstin,
      legal_name: value.legal_name,
      legal_address: value.legal_address,
      establishment_name: value.establishment_name,
      establishment_address: value.establishment_address,
      billing_cycle: value.billing_cycle,
      city: value.city,
      state: value.state,
      pincode: value.pincode,
      business_head: value.business_head,
      // The login switch is not the Manager's to set; the server defaults a
      // new contact to enabled and the Super Admin controls it from there.
      alternative_contacts: value.alternative_contacts.map((c) => ({
        name: c.name,
        designation: c.designation,
        mobile: c.mobile,
      })),
    });
    Alert.alert(
      'Request submitted',
      'The business request has been sent to a Super Admin for approval. The account is created once it is approved.',
      [{ text: 'OK', onPress: () => navigation.goBack() }]
    );
  };

  return (
    <SafeAreaView style={sa.container} edges={['top']}>
      <View style={sa.header}>
        <TouchableOpacity style={sa.iconBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={22} color={COLORS.TextPrimary} />
        </TouchableOpacity>
        <Text style={sa.headerTitle}>New Business</Text>
      </View>

      <BusinessForm
        mode="create"
        onSubmit={submit}
        onVerifyGst={(gstin) => managerApi.verifyGst(gstin)}
        submitLabel="Submit Request"
        footerNote="This creates a pending request. A Super Admin approves it and the account is created then."
      />
    </SafeAreaView>
  );
}
