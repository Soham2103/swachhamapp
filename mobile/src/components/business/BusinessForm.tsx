import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator, TextInput,
  KeyboardAvoidingView, Platform, Switch,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS } from '../../constants/theme';
import { sa } from '../../screens/superadmin/styles';

/**
 * THE Business form. One component, two operations.
 *
 * Business REGISTRATION and Business EDITING ask for exactly the same thing —
 * a business — so they are the same form. Keeping them as two screens is how
 * they drift: a field added to registration quietly becomes uneditable, and a
 * validation rule relaxed on one side is not relaxed on the other. Here the
 * ONLY difference between the two is `onSubmit`.
 *
 * THREE FRAMES: Business Information, Contact Information (the business head)
 * and Alternative Contact Information. They are separate cards because they
 * are separate subjects, and the third one repeats.
 *
 * LEGAL vs ESTABLISHMENT. A company's registered name and address are often
 * not the name over the door or the place the van collects from, so both are
 * captured. The "same as legal" toggles exist because they usually ARE the
 * same, and re-typing an address is how the two end up subtly different.
 *
 * GST DRIVES THE FORM. The GSTIN is verified through the backend, and what
 * comes back fills the PAN, the legal name and the address. The PAN field is
 * READ-ONLY in both modes: it is characters 3-12 of the GSTIN, derived by the
 * server, so typing one would only let it disagree with the registration.
 * Whatever this form shows, the SERVER re-derives the PAN when it saves.
 *
 * ALTERNATIVE CONTACTS ARE NAME + DESIGNATION + MOBILE ONLY, at least one and
 * at most three. No email and no WhatsApp: the only email that matters is the
 * head's, because that is the login username. Their mobile lets them be
 * routed to this business's login page — it is not a credential, and the
 * Login Access switch is what decides whether it routes at all.
 */

/**
 * Alternative contacts are OPTIONAL: none to three.
 *
 * The PRIMARY contact is the login account and is the only contact a business
 * must have. An alternative contact is a further person authorised to reach
 * the same account — useful, but not something registration should insist
 * exists.
 */
export const MIN_ALTERNATIVES = 0;
export const MAX_ALTERNATIVES = 3;

export const BILLING_CYCLES: Array<{ value: string; label: string }> = [
  { value: 'MONTHLY', label: 'Monthly' },
  // Every 14 days, anchored to the month: 1st-14th and 15th-end.
  { value: 'FORTNIGHTLY', label: 'Fortnightly' },
  { value: 'QUARTERLY', label: 'Quarterly' },
  { value: 'HALF_YEARLY', label: 'Half-Yearly' },
  { value: 'YEARLY', label: 'Yearly' },
];

export interface HeadContactValue {
  name: string;
  designation: string;
  mobile: string;
  whatsapp: string;
  email: string;
}

export interface AlternativeContactValue {
  /** Present for a contact that already exists on the server. */
  id?: string;
  name: string;
  designation: string;
  mobile: string;
  /** Whether this number may be used to reach the business login page. */
  login_enabled: boolean;
}

/**
 * B2B or B2C.
 *
 * B2B carries a GST number and cannot be submitted without one. B2C has none:
 * the field is disabled, nothing is sent, and the server discards a GSTIN
 * that arrives with a B2C submission rather than storing it.
 */
export type RegistrationType = 'B2B' | 'B2C';

export const REGISTRATION_TYPES: Array<{ value: RegistrationType; label: string; hint: string }> = [
  { value: 'B2B', label: 'B2B', hint: 'Registered business — GST number required' },
  { value: 'B2C', label: 'B2C', hint: 'Consumer account — no GST number' },
];

export interface BusinessFormValue {
  registration_type: RegistrationType;
  gstin: string;
  /** Derived from the GSTIN by the server. Never typed. */
  pan: string;
  legal_name: string;
  legal_address: string;
  establishment_name: string;
  establishment_address: string;
  billing_cycle: string;
  city: string;
  state: string;
  pincode: string;
  business_head: HeadContactValue;
  alternative_contacts: AlternativeContactValue[];
}

/** What a GST lookup returns, in the one shape both roles' endpoints use. */
export interface GstLookupResult {
  verified: boolean;
  data?: {
    gstin: string;
    pan_number: string;
    legalName: string | null;
    tradeName: string | null;
    registrationStatus: string | null;
    state: string | null;
    address: string | null;
    city: string | null;
    pincode: string | null;
  };
  message?: string;
}

interface Props {
  mode: 'create' | 'edit';
  /** The record being edited, or the starting point for a new one. */
  initial?: Partial<BusinessFormValue>;
  /**
   * The one thing that differs between the two modes. Throwing from here
   * shows the message on the form; returning normally means it saved.
   */
  onSubmit: (value: BusinessFormValue) => Promise<void>;
  /** Verifies a GSTIN. Manager and Super Admin reach different endpoints. */
  onVerifyGst: (gstin: string) => Promise<GstLookupResult>;
  submitLabel: string;
  /** Shown under the submit button, e.g. what approval will do next. */
  footerNote?: string;
  /** Called when Cancel is pressed. Omitted means no Cancel button. */
  onCancel?: () => void;
}

const emptyAlternative = (): AlternativeContactValue => ({
  name: '',
  designation: '',
  mobile: '',
  login_enabled: true,
});

export default function BusinessForm({
  mode,
  initial,
  onSubmit,
  onVerifyGst,
  submitLabel,
  footerNote,
  onCancel,
}: Props) {
  /* ---- Business information ---- */
  // B2B by default: it is what the form asked for before this choice existed,
  // so an unchanged form still behaves exactly as it used to.
  const [registrationType, setRegistrationType] = useState<RegistrationType>(
    initial?.registration_type || 'B2B'
  );
  const isB2B = registrationType === 'B2B';

  const [gstin, setGstin] = useState(initial?.gstin || '');
  const [pan, setPan] = useState(initial?.pan || '');
  const [legalName, setLegalName] = useState(initial?.legal_name || '');
  const [legalAddress, setLegalAddress] = useState(initial?.legal_address || '');
  const [establishmentName, setEstablishmentName] = useState(initial?.establishment_name || '');
  const [establishmentAddress, setEstablishmentAddress] = useState(
    initial?.establishment_address || ''
  );

  /*
   * The "same as legal" mirrors.
   *
   * On a NEW business they start ticked, because that is the common case. On
   * an EXISTING one they start ticked only if the two values actually match:
   * a business whose trading name really is different must not have it
   * silently overwritten the first time the legal name is edited.
   */
  const [sameName, setSameName] = useState(
    mode === 'create'
      ? true
      : Boolean(initial?.establishment_name) &&
          initial?.establishment_name === initial?.legal_name
  );
  const [sameAddress, setSameAddress] = useState(
    mode === 'create'
      ? true
      : Boolean(initial?.establishment_address) &&
          initial?.establishment_address === initial?.legal_address
  );

  const [billingCycle, setBillingCycle] = useState(initial?.billing_cycle || 'MONTHLY');
  const [city, setCity] = useState(initial?.city || '');
  const [state, setState] = useState(initial?.state || '');
  const [pincode, setPincode] = useState(initial?.pincode || '');

  const [gstChecked, setGstChecked] = useState(false);
  const [gstMessage, setGstMessage] = useState('');
  const [verifying, setVerifying] = useState(false);

  /*
   * The GSTIN this form was opened with.
   *
   * Editing is allowed, but a CHANGED number has to be verified before it can
   * be saved — the server verifies it again regardless, so this only saves a
   * pointless round trip and explains why.
   */
  const [originalGstin] = useState(initial?.gstin || '');
  const gstinChanged = gstin.trim().toUpperCase() !== originalGstin.trim().toUpperCase();

  /* ---- Contact information (business head) ---- */
  const [head, setHead] = useState<HeadContactValue>({
    name: initial?.business_head?.name || '',
    designation: initial?.business_head?.designation || '',
    mobile: initial?.business_head?.mobile || '',
    whatsapp: initial?.business_head?.whatsapp || '',
    email: initial?.business_head?.email || '',
  });

  /* ---- Alternative contacts: at least one, at most three ---- */
  const [alternatives, setAlternatives] = useState<AlternativeContactValue[]>(
    initial?.alternative_contacts?.length
      ? initial.alternative_contacts.map((c) => ({ ...c }))
      : [emptyAlternative()]
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // An edit screen loads its record after mounting, so the form is re-seeded
  // when that arrives rather than keeping the empty first render.
  useEffect(() => {
    if (!initial) return;
    setRegistrationType(initial.registration_type || 'B2B');
    setGstin(initial.gstin || '');
    setPan(initial.pan || '');
    setLegalName(initial.legal_name || '');
    setLegalAddress(initial.legal_address || '');
    setEstablishmentName(initial.establishment_name || '');
    setEstablishmentAddress(initial.establishment_address || '');
    setBillingCycle(initial.billing_cycle || 'MONTHLY');
    setCity(initial.city || '');
    setState(initial.state || '');
    setPincode(initial.pincode || '');
    setHead({
      name: initial.business_head?.name || '',
      designation: initial.business_head?.designation || '',
      mobile: initial.business_head?.mobile || '',
      whatsapp: initial.business_head?.whatsapp || '',
      email: initial.business_head?.email || '',
    });
    setAlternatives(
      initial.alternative_contacts?.length
        ? initial.alternative_contacts.map((c) => ({ ...c }))
        : [emptyAlternative()]
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  const setHeadField = (key: keyof HeadContactValue, value: string) =>
    setHead((current) => ({ ...current, [key]: value }));

  const setAltField = (
    index: number,
    key: keyof AlternativeContactValue,
    value: string | boolean
  ) =>
    setAlternatives((current) =>
      current.map((c, i) => (i === index ? { ...c, [key]: value } : c))
    );

  /* The mirrors. Writing through the setters keeps the establishment value in
     step while the box is ticked, so there is never a moment where the two
     disagree without the user having said so. */
  const changeLegalName = (value: string) => {
    setLegalName(value);
    if (sameName) setEstablishmentName(value);
  };
  const changeLegalAddress = (value: string) => {
    setLegalAddress(value);
    if (sameAddress) setEstablishmentAddress(value);
  };
  const toggleSameName = () => {
    const next = !sameName;
    setSameName(next);
    if (next) setEstablishmentName(legalName);
  };
  const toggleSameAddress = () => {
    const next = !sameAddress;
    setSameAddress(next);
    if (next) setEstablishmentAddress(legalAddress);
  };

  const addAlternative = () => {
    if (alternatives.length >= MAX_ALTERNATIVES) return;
    setAlternatives((current) => [...current, emptyAlternative()]);
  };

  /**
   * Removing a contact. Any of them, including the last.
   *
   * Alternative contacts are optional, so a business is allowed to have none
   * — the backend accepts an empty list for the same reason.
   */
  const removeAlternative = (index: number) => {
    setAlternatives((current) => current.filter((_, i) => i !== index));
  };

  /**
   * Verifies the GSTIN through the backend and fills in what it returns.
   *
   * The PAN is taken from the response rather than computed here, so the
   * value on screen is the value the server derived.
   */
  const verifyGst = async () => {
    setVerifying(true);
    setError('');
    setGstMessage('');
    try {
      const result = await onVerifyGst(gstin);
      setGstChecked(true);
      setGstMessage(result.message || '');
      if (result.data) {
        setPan(result.data.pan_number);
        // Through the mirroring setters, so a ticked "same as legal" box
        // picks the GST values up as well. Existing values are kept when the
        // provider has nothing better: an edit must not blank a field.
        if (result.data.legalName) changeLegalName(result.data.legalName);
        if (result.data.address) changeLegalAddress(result.data.address);
        if (result.data.city) setCity(result.data.city);
        if (result.data.state) setState(result.data.state);
        if (result.data.pincode) setPincode(result.data.pincode);
      }
    } catch (e: any) {
      setGstChecked(false);
      setError(e?.response?.data?.message || e.message || 'Could not verify that GST number.');
    } finally {
      setVerifying(false);
    }
  };

  const submit = async () => {
    // The same rules the server enforces, checked here so the answer is
    // immediate. The server is what decides.
    if (alternatives.length > MAX_ALTERNATIVES) {
      setError(`You can add at most ${MAX_ALTERNATIVES} alternative contacts.`);
      return;
    }
    // A slot that was opened and left blank is dropped, not complained about.
    // One that was half-filled is: a contact without a number cannot be
    // reached and cannot sign in, so it is not a contact.
    if (alternatives.some((c) => !c.mobile.trim() && c.name.trim())) {
      setError('An alternative contact needs a mobile number.');
      return;
    }
    if (isB2B && !gstin.trim()) {
      setError('A GST number is required for a B2B registration.');
      return;
    }
    // Only ever asked of a B2B record: a B2C one has no GSTIN to verify.
    if (isB2B && gstinChanged && !gstChecked) {
      setError('Please verify the new GST number before saving.');
      return;
    }

    setBusy(true);
    setError('');
    try {
      await onSubmit({
        registration_type: registrationType,
        // Emptied for a B2C submission rather than merely ignored, so what
        // leaves this screen matches what the server will store. The server
        // discards it again regardless -- this is not the enforcement.
        gstin: isB2B ? gstin.trim().toUpperCase() : '',
        pan: isB2B ? pan : '',
        legal_name: legalName.trim(),
        legal_address: legalAddress.trim(),
        // Sent explicitly rather than left to the server to infer, so what
        // was on screen is what is stored.
        establishment_name: (sameName ? legalName : establishmentName).trim(),
        establishment_address: (sameAddress ? legalAddress : establishmentAddress).trim(),
        billing_cycle: billingCycle,
        city: city.trim(),
        state: state.trim(),
        pincode: pincode.trim(),
        business_head: {
          name: head.name.trim(),
          designation: head.designation.trim(),
          mobile: head.mobile.trim(),
          whatsapp: head.whatsapp.trim(),
          email: head.email.trim(),
        },
        // Blank slots never leave the screen.
        alternative_contacts: alternatives
          .filter((c) => c.mobile.trim() || c.name.trim())
          .map((c) => ({
            ...c,
            name: c.name.trim(),
            designation: c.designation.trim(),
            mobile: c.mobile.trim(),
          })),
      });
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  const canSubmit =
    // Required for B2B, and not collected at all for B2C.
    (!isB2B || gstin.trim() !== '') &&
    legalName.trim() !== '' &&
    legalAddress.trim() !== '' &&
    head.name.trim() !== '' &&
    head.mobile.trim() !== '' &&
    head.email.trim() !== '' &&
    // Alternative contacts are optional, so an empty list submits. A slot
    // that has been typed into needs a mobile number, because that is the
    // part that makes it a reachable contact.
    alternatives.every((c) => !c.name.trim() || c.mobile.trim());

  return (
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

        {/* ============ FRAME: BUSINESS INFORMATION ============ */}
        <View style={sa.card}>
          <Text style={styles.frameTitle}>Business Information</Text>

          {/* ---- Registration type ----
              First, because it decides whether the two fields under it are
              asked for at all. The layout, the styling and the field order
              below are otherwise exactly as they were. */}
          <Text style={sa.label}>
            REGISTRATION TYPE <Text style={sa.required}>*</Text>
          </Text>
          <View style={{ flexDirection: 'row', gap: SPACING.xs }}>
            {REGISTRATION_TYPES.map((option) => {
              const on = registrationType === option.value;
              return (
                <TouchableOpacity
                  key={option.value}
                  style={[styles.chip, on && styles.chipOn]}
                  onPress={() => {
                    setRegistrationType(option.value);
                    // Switching to B2C clears what a B2C account cannot have,
                    // so the disabled field is never left showing a number
                    // that will not be saved.
                    if (option.value === 'B2C') {
                      setGstChecked(false);
                      setGstMessage('');
                    }
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={option.hint}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{option.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text style={[sa.cardMeta, { marginTop: SPACING.xs }]}>
            {REGISTRATION_TYPES.find((o) => o.value === registrationType)?.hint}
          </Text>

          <Text style={sa.label}>
            GST NUMBER {isB2B ? <Text style={sa.required}>*</Text> : null}
          </Text>
          <TextInput
            style={[sa.input, !isB2B && styles.mirrored]}
            placeholder={isB2B ? '27AAPFU0939F1ZV' : 'Not applicable for B2C'}
            placeholderTextColor={COLORS.TextSecondary}
            autoCapitalize="characters"
            // Emptied on screen too, so a B2C form never shows a number it is
            // not going to send.
            value={isB2B ? gstin : ''}
            onChangeText={(t) => {
              setGstin(t.toUpperCase().trim());
              setGstChecked(false);
              setGstMessage('');
            }}
            editable={isB2B}
            maxLength={15}
          />

          {isB2B ? (
            <>
              <TouchableOpacity
                style={[sa.buttonGhost, (verifying || gstin.length !== 15) && sa.buttonDisabled]}
                onPress={verifyGst}
                disabled={verifying || gstin.length !== 15}
              >
                {verifying ? (
                  <ActivityIndicator color={COLORS.Primary} />
                ) : (
                  <Text style={sa.buttonGhostText}>Verify GST</Text>
                )}
              </TouchableOpacity>
              {gstChecked && !!gstMessage && (
                <Text style={[sa.cardMeta, { marginTop: SPACING.xs }]}>{gstMessage}</Text>
              )}
              {/* Says why the button matters, at the moment it starts to. */}
              {mode === 'edit' && gstinChanged && !gstChecked && (
                <View style={[sa.warnBox, { marginTop: SPACING.xs }]}>
                  <Ionicons name="alert-circle-outline" size={16} color="#8A5200" />
                  <Text style={sa.warnText}>
                    The GST number has changed. Verify it before saving — the PAN is re-derived
                    from it.
                  </Text>
                </View>
              )}

              {/* Derived by the server from GSTIN characters 3-12. Read-only,
                  so it can never disagree with the registration. */}
              <Text style={sa.label}>PAN NUMBER</Text>
              <View style={[sa.input, styles.readOnly]}>
                <Text style={styles.readOnlyText}>{pan || 'Derived from the GST number'}</Text>
                <Ionicons name="lock-closed-outline" size={14} color={COLORS.TextSecondary} />
              </View>
            </>
          ) : (
            <Text style={[sa.cardMeta, { marginTop: SPACING.xs }]}>
              A B2C registration does not carry a GST number, so the field above is disabled
              and nothing is sent. The rest of the form is unchanged.
            </Text>
          )}

          <Text style={sa.label}>
            LEGAL NAME <Text style={sa.required}>*</Text>
          </Text>
          <TextInput
            style={sa.input}
            placeholder="As registered"
            placeholderTextColor={COLORS.TextSecondary}
            value={legalName}
            onChangeText={changeLegalName}
          />

          <CheckRow
            checked={sameName}
            onPress={toggleSameName}
            label="Establishment name is same as legal name"
          />

          <Text style={sa.label}>ESTABLISHMENT NAME</Text>
          <TextInput
            style={[sa.input, sameName && styles.mirrored]}
            placeholder="The name over the door"
            placeholderTextColor={COLORS.TextSecondary}
            value={sameName ? legalName : establishmentName}
            onChangeText={setEstablishmentName}
            editable={!sameName}
          />

          <Text style={sa.label}>
            BILLING CYCLE <Text style={sa.required}>*</Text>
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs }}>
            {BILLING_CYCLES.map((cycle) => {
              const on = billingCycle === cycle.value;
              return (
                <TouchableOpacity
                  key={cycle.value}
                  style={[styles.chip, on && styles.chipOn]}
                  onPress={() => setBillingCycle(cycle.value)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{cycle.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={sa.label}>
            LEGAL ADDRESS <Text style={sa.required}>*</Text>
          </Text>
          <TextInput
            style={[sa.input, { minHeight: 80, textAlignVertical: 'top' }]}
            placeholder="Registered address"
            placeholderTextColor={COLORS.TextSecondary}
            value={legalAddress}
            onChangeText={changeLegalAddress}
            multiline
          />

          <CheckRow
            checked={sameAddress}
            onPress={toggleSameAddress}
            label="Establishment address is same as legal address"
          />

          <Text style={sa.label}>ESTABLISHMENT ADDRESS</Text>
          <TextInput
            style={[
              sa.input,
              { minHeight: 80, textAlignVertical: 'top' },
              sameAddress && styles.mirrored,
            ]}
            placeholder="Where the laundry is collected from"
            placeholderTextColor={COLORS.TextSecondary}
            value={sameAddress ? legalAddress : establishmentAddress}
            onChangeText={setEstablishmentAddress}
            editable={!sameAddress}
            multiline
          />

          <View style={{ flexDirection: 'row', gap: SPACING.sm }}>
            <View style={sa.flex}>
              <Text style={sa.label}>CITY</Text>
              <TextInput
                style={sa.input}
                value={city}
                onChangeText={setCity}
                placeholderTextColor={COLORS.TextSecondary}
              />
            </View>
            <View style={sa.flex}>
              <Text style={sa.label}>PINCODE</Text>
              <TextInput
                style={sa.input}
                value={pincode}
                onChangeText={setPincode}
                keyboardType="number-pad"
                maxLength={6}
                placeholderTextColor={COLORS.TextSecondary}
              />
            </View>
          </View>
          <Text style={sa.label}>STATE</Text>
          <TextInput
            style={sa.input}
            value={state}
            onChangeText={setState}
            placeholderTextColor={COLORS.TextSecondary}
          />
        </View>

        {/* ============ FRAME: CONTACT INFORMATION ============ */}
        <View style={sa.card}>
          <Text style={styles.frameTitle}>Primary Contact — Contact 1</Text>
          <Text style={sa.cardMeta}>
            The business account itself. This email and password are the credentials the
            business signs in with, and every alternative contact signs in with them too.
          </Text>

          <Text style={sa.label}>
            NAME <Text style={sa.required}>*</Text>
          </Text>
          <TextInput
            style={sa.input}
            value={head.name}
            onChangeText={(t) => setHeadField('name', t)}
            placeholderTextColor={COLORS.TextSecondary}
          />

          <Text style={sa.label}>DESIGNATION</Text>
          <TextInput
            style={sa.input}
            value={head.designation}
            onChangeText={(t) => setHeadField('designation', t)}
            placeholderTextColor={COLORS.TextSecondary}
          />

          <Text style={sa.label}>
            MOBILE NUMBER <Text style={sa.required}>*</Text>
          </Text>
          <TextInput
            style={sa.input}
            value={head.mobile}
            onChangeText={(t) => setHeadField('mobile', t)}
            keyboardType="phone-pad"
            maxLength={10}
            placeholder="10-digit Indian mobile"
            placeholderTextColor={COLORS.TextSecondary}
          />

          {/* Not defaulted from the mobile: they are frequently different. */}
          <Text style={sa.label}>WHATSAPP NUMBER</Text>
          <TextInput
            style={sa.input}
            value={head.whatsapp}
            onChangeText={(t) => setHeadField('whatsapp', t)}
            keyboardType="phone-pad"
            maxLength={10}
            placeholder="If different from the mobile number"
            placeholderTextColor={COLORS.TextSecondary}
          />

          <Text style={sa.label}>
            EMAIL ID <Text style={sa.required}>*</Text>
          </Text>
          <TextInput
            style={sa.input}
            value={head.email}
            onChangeText={(t) => setHeadField('email', t)}
            keyboardType="email-address"
            autoCapitalize="none"
            placeholderTextColor={COLORS.TextSecondary}
          />
        </View>

        {/* ============ FRAME: ALTERNATIVE CONTACTS ============ */}
        <View style={sa.card}>
          <Text style={styles.frameTitle}>Alternative Contact Information</Text>
          <Text style={sa.cardMeta}>
            Optional — up to {MAX_ALTERNATIVES} can be added. Each one signs in by verifying
            their own mobile number and then entering this business's email and password;
            they never get a password of their own.
            Name, designation and mobile only — no email is collected for these contacts.
          </Text>

          {alternatives.map((contact, index) => (
            <View key={contact.id || `new-${index}`} style={styles.altBlock}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={[sa.cardTitle, sa.flex]}>Contact {index + 2}</Text>
                {/* Every one can go: a business is allowed to have none. */}
                <TouchableOpacity
                  onPress={() => removeAlternative(index)}
                  accessibilityLabel={`Remove contact ${index + 2}`}
                >
                  <Text style={styles.removeText}>Delete</Text>
                </TouchableOpacity>
              </View>

              {/* The MOBILE NUMBER is the only required part: it is what
                  identifies this business when the contact signs in. Name and
                  designation say who is being rung, and are optional. */}
              <Text style={sa.label}>NAME</Text>
              <TextInput
                style={sa.input}
                value={contact.name}
                onChangeText={(t) => setAltField(index, 'name', t)}
                placeholder="Optional"
                placeholderTextColor={COLORS.TextSecondary}
              />

              <Text style={sa.label}>DESIGNATION</Text>
              <TextInput
                style={sa.input}
                value={contact.designation}
                onChangeText={(t) => setAltField(index, 'designation', t)}
                placeholder="e.g. Front Office Manager"
                placeholderTextColor={COLORS.TextSecondary}
              />

              <Text style={sa.label}>
                MOBILE NUMBER <Text style={sa.required}>*</Text>
              </Text>
              <TextInput
                style={sa.input}
                value={contact.mobile}
                onChangeText={(t) => setAltField(index, 'mobile', t)}
                keyboardType="phone-pad"
                maxLength={10}
                placeholder="This contact's own number, for OTP"
                placeholderTextColor={COLORS.TextSecondary}
              />

              {/* The Super Admin's switch. Turning it off stops this number
                  resolving to the business at all — the backend excludes a
                  disabled contact from the login lookup, so it is a real
                  restriction and not a hidden button. */}
              <View style={styles.loginRow}>
                <Switch
                  value={contact.login_enabled}
                  onValueChange={(v) => setAltField(index, 'login_enabled', v)}
                  trackColor={{ true: COLORS.PrimaryLight, false: COLORS.Border }}
                  thumbColor={contact.login_enabled ? COLORS.Primary : COLORS.Surface}
                />
                <Text style={styles.loginLabel}>
                  Login access:{' '}
                  <Text style={{ fontWeight: '800' }}>
                    {contact.login_enabled ? 'Enabled' : 'Disabled'}
                  </Text>
                  {contact.login_enabled
                    ? ' — this mobile can reach the business login'
                    : ' — this mobile cannot reach the business login'}
                </Text>
              </View>
            </View>
          ))}

          {/* Hidden once three exist, rather than shown and refused. */}
          {alternatives.length < MAX_ALTERNATIVES && (
            <TouchableOpacity style={sa.buttonGhost} onPress={addAlternative}>
              <Text style={sa.buttonGhostText}>+ Add Alternative Contact</Text>
            </TouchableOpacity>
          )}
        </View>

        <TouchableOpacity
          style={[sa.button, (!canSubmit || busy) && sa.buttonDisabled]}
          onPress={submit}
          disabled={!canSubmit || busy}
        >
          {busy ? (
            <ActivityIndicator color={COLORS.Surface} />
          ) : (
            <Text style={sa.buttonText}>{submitLabel}</Text>
          )}
        </TouchableOpacity>

        {onCancel ? (
          <TouchableOpacity style={sa.buttonGhost} onPress={onCancel}>
            <Text style={sa.buttonGhostText}>Cancel</Text>
          </TouchableOpacity>
        ) : null}

        {footerNote ? (
          <Text style={[sa.cardMeta, { marginTop: SPACING.sm, textAlign: 'center' }]}>
            {footerNote}
          </Text>
        ) : null}

        <View style={{ height: SPACING.xxl }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/**
 * A labelled checkbox.
 *
 * The whole row is the target, not just the box, because a 20pt square is an
 * awkward thing to hit on a phone.
 */
function CheckRow({
  checked, onPress, label,
}: { checked: boolean; onPress: () => void; label: string }) {
  return (
    <TouchableOpacity
      style={styles.checkRow}
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
    >
      <Ionicons
        name={checked ? 'checkbox' : 'square-outline'}
        size={20}
        color={checked ? COLORS.Primary : COLORS.TextSecondary}
      />
      <Text style={styles.checkLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = {
  checkRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: SPACING.sm,
    paddingVertical: SPACING.sm,
    marginTop: SPACING.xs,
  },
  checkLabel: {
    flex: 1,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextPrimary,
  },
  /** A field being mirrored from another: readable, clearly not editable. */
  mirrored: {
    backgroundColor: COLORS.Background,
    color: COLORS.TextSecondary,
  },
  frameTitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: '800' as const,
    color: COLORS.PrimaryDark,
    marginBottom: 2,
  },
  readOnly: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    backgroundColor: COLORS.Background,
  },
  readOnlyText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.TextPrimary,
    letterSpacing: 1,
  },
  chip: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.full,
    borderWidth: 1,
    borderColor: COLORS.Border,
    backgroundColor: COLORS.Surface,
  },
  chipOn: { backgroundColor: COLORS.Primary, borderColor: COLORS.PrimaryDark },
  chipText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '600' as const,
    color: COLORS.TextPrimary,
  },
  chipTextOn: { color: COLORS.Surface, fontWeight: '800' as const },
  altBlock: {
    borderTopWidth: 1,
    borderTopColor: COLORS.Border,
    marginTop: SPACING.md,
    paddingTop: SPACING.sm,
  },
  removeText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '600' as const,
    color: COLORS.Error,
  },
  loginRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: SPACING.sm,
    marginTop: SPACING.sm,
  },
  loginLabel: {
    flex: 1,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextPrimary,
  },
};
