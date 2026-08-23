import React, { useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, ActivityIndicator, Platform, Alert, ScrollView,
} from 'react-native';
// The legacy entry point, the same one the order-PDF code uses: SDK 54's new
// API replaced cacheDirectory with a different file object model.
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, BORDER_RADIUS, TYPOGRAPHY } from '../../constants/theme';
import { sa } from './styles';
import superAdminApi from '../../services/superAdminApi';
import SorterCalendar from '../../components/sorter/SorterCalendar';
import { formatLongDate, toDateKey } from '../../utils/sorterDates';

/**
 * Generate GST Invoice, for one business over one period.
 *
 * Both dates are picked from the calendar the app already has — nothing is
 * hardcoded and nothing is typed. The totals shown are fetched from the
 * backend, and the PDF is downloaded from it as well: no amount on this
 * screen is calculated here.
 */

interface Props {
  visible: boolean;
  businessId: string | null;
  businessName: string;
  onClose: () => void;
}

type Picking = 'from' | 'to' | null;

export default function GstInvoiceModal({ visible, businessId, businessName, onClose }: Props) {
  // Defaults to the current month so far, from the device's own calendar.
  const today = toDateKey(new Date());
  const monthStart = `${today.slice(0, 8)}01`;

  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [picking, setPicking] = useState<Picking>(null);

  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const reset = () => {
    setPreview(null);
    setError('');
  };

  /** The totals, so the operator sees what is about to be billed. */
  const loadPreview = async () => {
    if (!businessId) return;
    setBusy(true);
    setError('');
    try {
      setPreview(await superAdminApi.getInvoice(businessId, from, to));
    } catch (e: any) {
      setPreview(null);
      setError(e?.response?.data?.message || e.message || 'Could not build the invoice.');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Downloads the PDF the backend renders and hands it to the share sheet.
   *
   * FileSystem does its own request, so the bearer token is attached
   * explicitly — this endpoint is SUPER_ADMIN only.
   */
  const downloadPdf = async () => {
    if (!businessId) return;
    setBusy(true);
    setError('');
    try {
      const headers = await superAdminApi.authHeader();
      const url = superAdminApi.invoicePdfUrl(businessId, from, to);
      const target = `${FileSystem.cacheDirectory}invoice-${businessId}-${from}-${to}.pdf`;

      const result = await FileSystem.downloadAsync(url, target, { headers });
      if (result.status !== 200) {
        throw new Error('The invoice could not be generated for this period.');
      }

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(result.uri, {
          mimeType: 'application/pdf',
          dialogTitle: `GST invoice — ${businessName}`,
          UTI: 'com.adobe.pdf',
        });
      } else {
        Alert.alert('Invoice saved', result.uri);
      }
    } catch (e: any) {
      setError(e?.message || 'Could not download the invoice.');
    } finally {
      setBusy(false);
    }
  };

  const dateButton = (label: string, value: string, which: Exclude<Picking, null>) => (
    <View style={{ flex: 1 }}>
      <Text style={sa.label}>{label}</Text>
      <TouchableOpacity
        style={[sa.input, { flexDirection: 'row', alignItems: 'center', gap: 8 }]}
        onPress={() => setPicking(which)}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${formatLongDate(value)}`}
      >
        <Ionicons name="calendar-outline" size={18} color={COLORS.Primary} />
        <Text style={{ color: COLORS.TextPrimary, fontFamily: TYPOGRAPHY.fontFamily }}>
          {formatLongDate(value)}
        </Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}>
        <View
          style={{
            backgroundColor: COLORS.Background,
            borderTopLeftRadius: BORDER_RADIUS.lg,
            borderTopRightRadius: BORDER_RADIUS.lg,
            paddingBottom: SPACING.lg,
            maxHeight: '88%',
          }}
        >
          <View style={sa.header}>
            <Text style={[sa.headerTitle, { flex: 1 }]}>Generate GST Invoice</Text>
            <TouchableOpacity style={sa.iconBtn} onPress={onClose} accessibilityLabel="Close">
              <Ionicons name="close" size={22} color={COLORS.TextPrimary} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={sa.scroll} keyboardShouldPersistTaps="handled">
            <Text style={sa.cardTitle}>{businessName}</Text>

            <View style={{ flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.sm }}>
              {dateButton('From', from, 'from')}
              {dateButton('To', to, 'to')}
            </View>

            {!!error && (
              <View style={sa.errorBox}>
                <Ionicons name="alert-circle-outline" size={16} color={COLORS.Error} />
                <Text style={sa.errorText}>{error}</Text>
              </View>
            )}

            {/* The figures, straight from the backend. */}
            {preview && (
              <View style={[sa.card, { marginTop: SPACING.sm }]}>
                {/* The SHOWN number: the server's first-10-character form,
                    the same string the PDF prints. The full number stays on
                    `invoice_number` and is what the download is named by. */}
                <Text style={sa.cardTitle}>
                  {preview.invoice_number_display || preview.invoice_number}
                </Text>
                <Text style={sa.cardLine}>Orders: {preview.orders?.length ?? 0}</Text>
                <Text style={sa.cardLine}>Items billed: {preview.lines?.length ?? 0}</Text>
                <Text style={sa.cardLine}>
                  Taxable value: INR {Number(preview.totals?.taxable_value ?? 0).toFixed(2)}
                </Text>
                {preview.totals?.intra_state ? (
                  <>
                    <Text style={sa.cardLine}>
                      CGST @ {preview.totals.gst_rate / 2}%: INR {Number(preview.totals.cgst).toFixed(2)}
                    </Text>
                    <Text style={sa.cardLine}>
                      SGST @ {preview.totals.gst_rate / 2}%: INR {Number(preview.totals.sgst).toFixed(2)}
                    </Text>
                  </>
                ) : (
                  <Text style={sa.cardLine}>
                    IGST @ {preview.totals?.gst_rate}%: INR {Number(preview.totals?.igst ?? 0).toFixed(2)}
                  </Text>
                )}
                <Text style={[sa.cardLine, { fontWeight: '800' }]}>
                  Grand total: INR {Number(preview.totals?.grand_total ?? 0).toFixed(2)}
                </Text>
              </View>
            )}

            <TouchableOpacity
              style={[sa.button, busy && sa.buttonDisabled]}
              onPress={loadPreview}
              disabled={busy}
            >
              {busy ? <ActivityIndicator color={COLORS.Surface} />
                    : <Text style={sa.buttonText}>Preview totals</Text>}
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                sa.button,
                { backgroundColor: COLORS.PrimaryDark },
                busy && sa.buttonDisabled,
              ]}
              onPress={downloadPdf}
              disabled={busy}
            >
              <Text style={sa.buttonText}>Generate Invoice (PDF)</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>

      {/* The calendar the Sorter module already uses, reused as-is. */}
      <SorterCalendar
        visible={picking !== null}
        value={picking === 'to' ? to : from}
        // Nothing can be billed for a day that has not happened.
        maxDate={today}
        title={picking === 'to' ? 'To date' : 'From date'}
        onSelect={(key) => {
          if (picking === 'to') setTo(key);
          else setFrom(key);
          setPicking(null);
          reset();
        }}
        onClose={() => setPicking(null)}
      />
    </Modal>
  );
}
