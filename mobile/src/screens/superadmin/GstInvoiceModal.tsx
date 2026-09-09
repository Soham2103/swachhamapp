import React, { useEffect, useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, ActivityIndicator, Platform, Alert, ScrollView,
  TextInput, Image,
} from 'react-native';
// The legacy entry point, the same one the order-PDF code uses: SDK 54's new
// API replaced cacheDirectory with a different file object model.
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, BORDER_RADIUS, TYPOGRAPHY } from '../../constants/theme';
import { sa } from './styles';
import superAdminApi, { LaundryTypeValue, BillingPeriod } from '../../services/superAdminApi';
import SorterCalendar from '../../components/sorter/SorterCalendar';
import { formatLongDate, toDateKey } from '../../utils/sorterDates';
import { businessDocumentFileName } from '../../utils/pdfFileName';
import { freshDownloadTarget } from '../../utils/pdfFile';

/**
 * Generate GST Invoice, for one business over one period.
 *
 * Both dates are picked from the calendar the app already has — nothing is
 * hardcoded and nothing is typed. The totals shown are fetched from the
 * backend, and the PDF is downloaded from it as well: no amount on this
 * screen is calculated here.
 *
 * HOTEL AND GUEST ARE TWO SEPARATE INVOICES, chosen at the top. The type is
 * sent to the server with the two dates, and the server does the filtering —
 * so a Hotel invoice cannot contain a Guest line no matter what this screen
 * does. The invoice below is generated for whichever type is selected.
 *
 * THE ORDER SUMMARY PDF USED TO BE DOWNLOADED HERE TOO. It now lives in the
 * Order Summary tab of the Business Account, unchanged — same endpoint, same
 * document, same file naming. Only its location moved.
 */

interface Props {
  visible: boolean;
  businessId: string | null;
  businessName: string;
  onClose: () => void;
  /**
   * Called once the invoice PDF has actually been ISSUED by the server.
   *
   * Downloading the document is what puts the invoice on record, so this is
   * the moment the Issued Invoice list behind this sheet is out of date. The
   * list used to be reloaded only when the sheet was CLOSED, which meant an
   * operator who generated an invoice and stayed here — to raise the Guest one
   * next, say — was looking at a list that did not contain either. Optional,
   * so a caller that has no list to refresh is unaffected.
   */
  onGenerated?: () => void;
}

type Picking = 'from' | 'to' | null;

/** The two invoice types, in the order the Business Account lists them. */
export const LAUNDRY_TYPES: Array<{ value: LaundryTypeValue; label: string; icon: any }> = [
  { value: 'hotel', label: 'Hotel Laundry', icon: 'business' },
  { value: 'guest', label: 'Guest Laundry', icon: 'person' },
];

export default function GstInvoiceModal({
  visible,
  businessId,
  businessName,
  onClose,
  onGenerated,
}: Props) {
  // Defaults to the current month so far, from the device's own calendar.
  // Only a fallback: `periods` below replaces it as soon as the business's
  // own billing cycle has been read.
  const today = toDateKey(new Date());
  const monthStart = `${today.slice(0, 8)}01`;

  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [picking, setPicking] = useState<Picking>(null);

  /**
   * THE BUSINESS'S OWN BILLING PERIODS, newest first.
   *
   * WHY THIS REPLACED TWO DATE PICKERS. An invoice covers exactly one billing
   * cycle, so two free dates could express something no invoice can be: a
   * range crossing a period boundary. On a fortnightly account, "1 to 31
   * August" is not August's invoice — it is two of them — and the server can
   * only refuse it. Worse, a range that lands wholly inside an EMPTY half of
   * the month reports "no data" for a month with plenty of orders, which is
   * what this screen was doing.
   *
   * Picking from the periods the cycle actually defines removes the whole
   * class of problem: every option is exactly one invoice, and the label says
   * which. The dates still travel to the server unchanged, so nothing about
   * how an invoice is built or numbered changes.
   */
  const [periods, setPeriods] = useState<BillingPeriod[]>([]);
  const [periodsError, setPeriodsError] = useState('');
  const [loadingPeriods, setLoadingPeriods] = useState(false);
  /**
   * Which invoice is being generated. Hotel first, because it is the larger
   * of the two for most businesses. There is deliberately no "both" option:
   * the two are separate invoices, and an operator who wants both generates
   * them one after the other.
   */
  const [laundryType, setLaundryType] = useState<LaundryTypeValue>('hotel');

  /**
   * The deduction taken off the subtotal before GST, as typed.
   *
   * Held as the raw string so a half-typed "5." is not fought with while the
   * operator is still typing; `discountPercent` below is the number actually
   * sent. Blank means none, and the invoice is then exactly what it has
   * always been.
   */
  const [discount, setDiscount] = useState('');

  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const typeLabel =
    LAUNDRY_TYPES.find((option) => option.value === laundryType)?.label ?? '';

  /*
   * WHAT GETS SENT, AND WHETHER IT MAY BE.
   *
   * Blank is 0 — no deduction, and nothing is sent at all. Anything typed
   * must be a number from 0 to 100: the server refuses the rest too, but
   * catching it here means an impossible percentage cannot even reach the
   * button, let alone produce an invoice.
   */
  const discountPercent = discount.trim() === '' ? 0 : Number(discount);
  const discountValid =
    Number.isFinite(discountPercent) && discountPercent >= 0 && discountPercent <= 100;

  const reset = () => {
    setPreview(null);
    setError('');
  };

  /*
   * The periods are read when the sheet opens, and again if it is reopened for
   * a different business — each business has its own cycle, so a list carried
   * over from the last one would offer the wrong windows.
   *
   * The most recent period is selected by default, which is the one an
   * operator generating an invoice today almost always wants. If the list
   * cannot be read the two date pickers below are still there, so the sheet
   * degrades to exactly what it was rather than becoming unusable.
   */
  useEffect(() => {
    if (!visible || !businessId) return;
    let cancelled = false;
    setLoadingPeriods(true);
    setPeriodsError('');
    superAdminApi
      .getBillingPeriods(businessId, 12)
      .then((list) => {
        if (cancelled) return;
        setPeriods(list);
        if (list.length > 0) {
          setFrom(list[0].from);
          setTo(list[0].to);
        }
      })
      .catch((e: any) => {
        if (cancelled) return;
        setPeriodsError(
          e?.response?.data?.message || e.message || 'Could not read this business’s billing periods.'
        );
      })
      .finally(() => {
        if (!cancelled) setLoadingPeriods(false);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, businessId]);

  /** The totals, so the operator sees what is about to be billed. */
  const loadPreview = async () => {
    if (!businessId) return;
    setBusy(true);
    setError('');
    try {
      setPreview(await superAdminApi.getInvoice(businessId, from, to, laundryType, discountPercent));
    } catch (e: any) {
      setPreview(null);
      setError(e?.response?.data?.message || e.message || 'Could not build the invoice.');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Downloads the invoice and hands it to the share sheet.
   *
   * It is built from the `from`, `to` and `laundryType` held above.
   *
   * FileSystem does its own request, so the bearer token is attached
   * explicitly — this endpoint is SUPER_ADMIN only.
   */
  const download = async () => {
    if (!businessId) return;
    setBusy(true);
    setError('');
    try {
      const headers = await superAdminApi.authHeader();
      const url = superAdminApi.invoicePdfUrl(businessId, from, to, laundryType, discountPercent);
      /*
       * THE NAME THE USER ACTUALLY GETS.
       *
       * `downloadAsync` writes the body to the path it is handed and ignores
       * the server's `Content-Disposition` entirely, so this — not the
       * response header — is what decides the file name in the share sheet
       * and in the saved file. It is built to the same shape the server
       * names its own downloads, so the two agree.
       */
      const fileName = businessDocumentFileName({
        establishmentName: businessName,
        from,
        to,
        laundryTypeLabel: typeLabel,
        kind: 'invoice',
      });
      /*
       * A PATH NOTHING HAS USED BEFORE.
       *
       * The name the user sees is unchanged — the uniqueness is in the
       * directory. Writing every generation of this invoice to one fixed path
       * left the share sheet and the device's PDF viewer with a URI they had
       * already seen, and a viewer that caches by URI would show the previous
       * render of a document that had just been regenerated.
       */
      const target = await freshDownloadTarget(fileName);

      const result = await FileSystem.downloadAsync(url, target, { headers });
      if (result.status !== 200) {
        throw new Error(
          `No ${typeLabel} data could be found for this period.`
        );
      }

      /*
       * THE INVOICE IS NOW ISSUED, SO THE LIST BEHIND THIS SHEET IS STALE.
       *
       * Announced here — after a 200 and before the share sheet — because the
       * server records the invoice in the business's history as part of
       * serving these bytes, and it awaits that write, so the row exists by
       * the time this line runs. Announcing it before the share sheet means
       * the refresh happens whether the operator shares the file, saves it or
       * dismisses the sheet without doing either.
       */
      onGenerated?.();

      const title = `${typeLabel} invoice — ${businessName}`;

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(result.uri, {
          mimeType: 'application/pdf',
          dialogTitle: title,
          UTI: 'com.adobe.pdf',
        });
      } else {
        Alert.alert('Saved', result.uri);
      }
    } catch (e: any) {
      setError(e?.message || 'Could not download the document.');
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
            <Text style={[sa.headerTitle, { flex: 1 }]}>Generate Invoice</Text>
            <TouchableOpacity style={sa.iconBtn} onPress={onClose} accessibilityLabel="Close">
              <Ionicons name="close" size={22} color={COLORS.TextPrimary} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={sa.scroll} keyboardShouldPersistTaps="handled">
            <Text style={sa.cardTitle}>{businessName}</Text>

            {/* WHICH INVOICE. Chosen first, because it decides what the dates
                below are then read against — the two types are separate
                invoices and their data never mixes. */}
            <Text style={sa.label}>INVOICE TYPE</Text>
            <View style={{ flexDirection: 'row', gap: SPACING.xs }}>
              {LAUNDRY_TYPES.map((option) => {
                const on = laundryType === option.value;
                return (
                  <TouchableOpacity
                    key={option.value}
                    style={[sa.tab, on && sa.tabActive, { flex: 1, flexDirection: 'row', gap: 6 }]}
                    onPress={() => {
                      setLaundryType(option.value);
                      // The preview belongs to the type it was fetched for.
                      reset();
                    }}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                    accessibilityLabel={`Generate a ${option.label} invoice`}
                  >
                    <Ionicons
                      name={option.icon}
                      size={16}
                      color={on ? COLORS.Surface : COLORS.TextSecondary}
                    />
                    <Text style={[sa.tabText, on && sa.tabTextActive]}>{option.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* WHICH BILLING PERIOD. One invoice covers one billing cycle, so
                the choice is a cycle, not a range — every row here is exactly
                one invoice, drawn from the cycle registered against this
                business. Generating a period that already has an invoice
                updates that invoice; it does not raise a second. */}
            <Text style={sa.label}>BILLING PERIOD</Text>
            {loadingPeriods ? (
              <View style={{ paddingVertical: SPACING.sm }}>
                <ActivityIndicator color={COLORS.Primary} />
              </View>
            ) : periods.length > 0 ? (
              <View style={{ gap: SPACING.xs }}>
                {periods.map((period) => {
                  const on = period.from === from && period.to === to;
                  return (
                    <TouchableOpacity
                      key={`${period.from}_${period.to}`}
                      style={[
                        sa.input,
                        {
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 8,
                          borderColor: on ? COLORS.Primary : COLORS.Border,
                          borderWidth: on ? 2 : 1,
                        },
                      ]}
                      onPress={() => {
                        setFrom(period.from);
                        setTo(period.to);
                        // The preview belongs to the period it was fetched for.
                        reset();
                      }}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: on }}
                      accessibilityLabel={`Bill the ${period.label} period, ${period.from} to ${period.to}`}
                    >
                      <Ionicons
                        name={on ? 'radio-button-on' : 'radio-button-off'}
                        size={18}
                        color={on ? COLORS.Primary : COLORS.TextSecondary}
                      />
                      <View style={{ flex: 1 }}>
                        <Text
                          style={{
                            color: COLORS.TextPrimary,
                            fontFamily: TYPOGRAPHY.fontFamily,
                            fontWeight: on ? '700' : '500',
                          }}
                        >
                          {period.label}
                        </Text>
                        <Text style={sa.cardMeta}>
                          {formatLongDate(period.from)} – {formatLongDate(period.to)}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            ) : (
              <>
                {/* THE FALLBACK, when the periods could not be read. The two
                    pickers this screen has always had, so a failure to load
                    the cycle leaves the sheet usable rather than empty. Dates
                    must still land inside one billing period; the server says
                    so plainly if they do not. */}
                {!!periodsError && (
                  <View style={sa.errorBox}>
                    <Ionicons name="alert-circle-outline" size={16} color={COLORS.Error} />
                    <Text style={sa.errorText}>{periodsError}</Text>
                  </View>
                )}
                <View style={{ flexDirection: 'row', gap: SPACING.sm }}>
                  {dateButton('From', from, 'from')}
                  {dateButton('To', to, 'to')}
                </View>
                <Text style={sa.cardMeta}>
                  Both dates must fall inside one billing period of this business's cycle.
                </Text>
              </>
            )}

            {/* THE DEDUCTION, taken off the subtotal before GST is charged.
                Typed before generating; left blank the invoice is unchanged.
                The arithmetic is the server's, as every other figure here is. */}
            <Text style={sa.label}>DISCOUNT / DEDUCTION (%)</Text>
            <TextInput
              style={[sa.input, !discountValid && sa.inputMissing]}
              value={discount}
              onChangeText={(text) => {
                setDiscount(text);
                // The preview belongs to the deduction it was fetched for.
                reset();
              }}
              keyboardType="decimal-pad"
              placeholder="0"
              placeholderTextColor={COLORS.TextSecondary}
              accessibilityLabel="Discount or deduction percentage"
            />
            <Text style={sa.cardMeta}>
              {discountValid
                ? 'Taken off the subtotal before CGST/SGST. Leave blank for none.'
                : 'Enter a percentage between 0 and 100.'}
            </Text>

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
                {/* THE TYPE, from the server rather than from this screen's
                    own state: it reports what the invoice was actually built
                    with, so a stale preview cannot claim the wrong one. */}
                <Text style={[sa.cardLine, { fontWeight: '700' }]}>
                  Type: {preview.laundry_type_label || 'Hotel & Guest Laundry'}
                </Text>
                {/* THE BILLING PERIOD THIS INVOICE ACTUALLY COVERS.
                    The dates below choose WHICH billing cycle to bill, not the
                    range — the server pins the period to the cycle registered
                    against the business — so the resolved period is shown
                    here rather than leaving the operator to infer it from the
                    two dates they picked. */}
                {preview.period?.from && preview.period?.to ? (
                  <Text style={[sa.cardLine, { fontWeight: '700' }]}>
                    Billing period: {preview.period.label
                      ? `${preview.period.label} (${preview.period.from} to ${preview.period.to})`
                      : `${preview.period.from} to ${preview.period.to}`}
                  </Text>
                ) : null}
                <Text style={sa.cardLine}>Orders: {preview.orders?.length ?? 0}</Text>
                <Text style={sa.cardLine}>Items billed: {preview.lines?.length ?? 0}</Text>
                {/* SUB TOTAL IS ALWAYS SHOWN, not only when a deduction was
                    taken. It is the figure the PDF closes its Amount column
                    with, so an operator checking the preview against the
                    document is comparing the same row; hiding it on an
                    undiscounted invoice left the screen starting at the
                    taxable value and the PDF starting at the sub total. */}
                <Text style={sa.cardLine}>
                  Sub total: INR {Number(preview.totals?.subtotal ?? 0).toFixed(2)}
                </Text>
                {preview.totals?.discount_amount > 0 ? (
                  <>
                    <Text style={sa.cardLine}>
                      Less {preview.totals.discount_percent}%: INR{' '}
                      {Number(preview.totals.discount_amount).toFixed(2)}
                    </Text>
                    <Text style={sa.cardLine}>
                      Taxable value: INR {Number(preview.totals?.taxable_value ?? 0).toFixed(2)}
                    </Text>
                  </>
                ) : null}
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

                {/* THE SCAN-TO-PAY QR, exactly as the PDF prints it.
                    The image is the PNG the server put on the invoice, so
                    what is previewed here and what is printed, downloaded,
                    shared or handed to a printer are the same code — there
                    is no second encoder in the app to drift from it.
                    The server decides whether there is one at all; this only
                    shows what it sent, including the reason when it did
                    not. */}
                {preview.upi_payment?.available && preview.upi_payment?.qr_data_url ? (
                  <View style={{ alignItems: 'flex-start', marginTop: SPACING.sm }}>
                    <Image
                      source={{ uri: preview.upi_payment.qr_data_url }}
                      style={{ width: 160, height: 160 }}
                      /* `contain` on a square image in a square box leaves the
                         QR's proportions untouched; a stretched QR does not
                         scan. */
                      resizeMode="contain"
                      accessibilityLabel="UPI payment QR code"
                    />
                    {/* THE SAME BADGE THE PDF PRINTS UNDER THE CODE, so the
                        preview and the document a customer receives read
                        alike. Two Views rather than an image, for the same
                        reason the PDF draws it: no asset to keep in step. */}
                    <View
                      style={{
                        flexDirection: 'row',
                        borderRadius: 4,
                        overflow: 'hidden',
                        marginTop: 6,
                      }}
                    >
                      <View style={{ backgroundColor: '#ECEFEF', paddingHorizontal: 8, paddingVertical: 3 }}>
                        <Text style={{ color: '#5F6B6C', fontWeight: '800', fontSize: 11, fontStyle: 'italic' }}>
                          UPI
                        </Text>
                      </View>
                      <View style={{ backgroundColor: '#16D08A', paddingHorizontal: 10, paddingVertical: 3 }}>
                        <Text style={{ color: '#FFFFFF', fontWeight: '800', fontSize: 11 }}>
                          SCAN TO PAY
                        </Text>
                      </View>
                    </View>
                    {/* On screen there is room to state the amount and the
                        payee outright; both are inside the QR either way. */}
                    <Text style={sa.cardMeta}>
                      {preview.upi_payment.amount != null
                        ? `Opens for INR ${Number(preview.upi_payment.amount).toFixed(2)}`
                        : 'Amount entered in the UPI app'}
                      {preview.upi_payment.vpa ? ` — ${preview.upi_payment.vpa}` : ''}
                    </Text>
                  </View>
                ) : (
                  <Text style={[sa.cardMeta, { marginTop: SPACING.sm }]}>
                    {preview.upi_payment?.message || 'UPI payment unavailable'}
                  </Text>
                )}
              </View>
            )}

            <TouchableOpacity
              style={[sa.button, (busy || !discountValid) && sa.buttonDisabled]}
              onPress={loadPreview}
              disabled={busy || !discountValid}
            >
              {busy ? <ActivityIndicator color={COLORS.Surface} />
                    : <Text style={sa.buttonText}>Preview totals</Text>}
            </TouchableOpacity>

            {/* THE INVOICE, for the type and period chosen above. */}
            <TouchableOpacity
              style={[
                sa.button,
                { backgroundColor: COLORS.PrimaryDark },
                (busy || !discountValid) && sa.buttonDisabled,
              ]}
              onPress={() => download()}
              disabled={busy || !discountValid}
              accessibilityRole="button"
              accessibilityLabel={`Generate the ${typeLabel} invoice PDF`}
            >
              <Text style={sa.buttonText}>{typeLabel} Invoice (PDF)</Text>
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
