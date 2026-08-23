import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
  Image,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS, SHADOWS } from '../../constants/theme';
import BusinessHeader from '../../components/business/BusinessHeader';
import businessOrderApi, { BusinessOrderDetail } from '../../services/businessOrderApi';
import { extractErrorMessage } from '../../services/api';
import { useBusinessOrderStore } from '../../store/businessOrderStore';
import {
  generateOrderPdf,
  buildPdfBaseName,
  formatDateTime,
  formatWeightKg,
  LAUNDRY_LABEL,
  ORDER_LABEL,
  SERVICE_LABEL,
} from '../../utils/businessOrderPdf';

export default function BusinessOrderDetailsScreen({ navigation, route }: any) {
  const { orderId } = route.params || {};
  const [order, setOrder] = useState<BusinessOrderDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  /**
   * Which PDF action is running, or null. One flag for both buttons is what
   * stops a second generation starting while the first is still going.
   */
  const [pdfAction, setPdfAction] = useState<'share' | 'download' | null>(null);
  /**
   * The state above drives the UI; this ref is the actual lock. It flips
   * synchronously, so two taps in the same frame — before React has
   * re-rendered the disabled buttons — cannot both start a generation.
   */
  const pdfBusyRef = useRef(false);
  const [isRepeating, setIsRepeating] = useState(false);
  const { repeatIntoCart } = useBusinessOrderStore();

  const load = useCallback(async () => {
    try {
      setError('');
      setIsLoading(true);
      const response = await businessOrderApi.getOrderById(String(orderId));
      setOrder(response.data);
    } catch (err: any) {
      setError(extractErrorMessage(err, 'Failed to load order'));
    } finally {
      setIsLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    load();
  }, [load]);



  /**
   * Copies this order's items/selections into the cart. The business then
   * reviews and confirms, so the repeat goes through the normal validated
   * create-order flow and receives its own new order number.
   */
  const handleRepeatOrder = async () => {
    if (isRepeating) return;
    try {
      setIsRepeating(true);
      setError('');
      // The store is populated from the rebuilt cart the server returns, so the
      // Cart shows the repeated items the moment it opens. No order is created
      // here — the new order number is issued when the business confirms.
      await repeatIntoCart(String(orderId));
      navigation.navigate('BusinessCart');
    } catch (err: any) {
      setError(err?.message || 'Failed to repeat order');
    } finally {
      setIsRepeating(false);
    }
  };

  /**
   * The PDF is always built from a fresh read of the order, so the document
   * matches the server rather than a stale screen. Nothing is written back.
   */
  const buildPdf = async () => {
    const fresh = (await businessOrderApi.getOrderById(String(orderId))).data;
    return generateOrderPdf(fresh);
  };

  /** Share PDF — hands the real PDF file to the native share sheet. */
  const handleSharePdf = async () => {
    if (pdfBusyRef.current) return;
    pdfBusyRef.current = true;
    let uri = '';
    let fileName = '';
    try {
      setPdfAction('share');
      setError('');
      ({ uri, fileName } = await buildPdf());
    } catch (err: any) {
      if (__DEV__) console.error('[OrderPdf] generation failed', err);
      setError('Unable to generate PDF. Please try again.');
      setPdfAction(null);
      pdfBusyRef.current = false;
      return;
    }

    try {
      if (!(await Sharing.isAvailableAsync())) {
        throw new Error('Sharing is not available on this device');
      }
      await Sharing.shareAsync(uri, {
        mimeType: 'application/pdf',
        dialogTitle: fileName,
        UTI: 'com.adobe.pdf',
      });
    } catch (err: any) {
      if (__DEV__) console.error('[OrderPdf] share failed', err);
      setError('Unable to share PDF. Please try again.');
    } finally {
      setPdfAction(null);
      pdfBusyRef.current = false;
    }
  };

  /**
   * Download PDF — saves the file to the device rather than opening a share
   * sheet. Android writes into a folder the user picks through the Storage
   * Access Framework (the supported route on modern Android); iOS writes into
   * the app's Documents folder, which the Files app exposes.
   */
  const handleDownloadPdf = async () => {
    if (pdfBusyRef.current) return;
    pdfBusyRef.current = true;
    let uri = '';
    let fileName = '';
    try {
      setPdfAction('download');
      setError('');
      ({ uri, fileName } = await buildPdf());
    } catch (err: any) {
      if (__DEV__) console.error('[OrderPdf] generation failed', err);
      setError('Unable to generate PDF. Please try again.');
      setPdfAction(null);
      pdfBusyRef.current = false;
      return;
    }

    try {
      const base64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });

      if (Platform.OS === 'android') {
        const permission =
          await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
        if (!permission.granted) {
          setError('Choose a folder to save the PDF, then try again.');
          return;
        }
        // The extension is left to SAF: it appends .pdf for this MIME type, so
        // the saved file is exactly <order number>.pdf.
        const savedUri = await FileSystem.StorageAccessFramework.createFileAsync(
          permission.directoryUri,
          buildPdfBaseName(order?.order_number || ''),
          'application/pdf'
        );
        await FileSystem.writeAsStringAsync(savedUri, base64, { encoding: 'base64' });
      } else {
        const targetUri = `${FileSystem.documentDirectory}${encodeURIComponent(fileName)}`;
        await FileSystem.deleteAsync(targetUri, { idempotent: true });
        await FileSystem.writeAsStringAsync(targetUri, base64, { encoding: 'base64' });
      }

      Alert.alert('PDF downloaded successfully.', fileName);
    } catch (err: any) {
      if (__DEV__) console.error('[OrderPdf] download failed', err);
      setError('Unable to download PDF. Please try again.');
    } finally {
      setPdfAction(null);
      pdfBusyRef.current = false;
    }
  };

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <BusinessHeader title="Order Details" onBack={() => navigation.goBack()} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={COLORS.Primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (error && !order) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <BusinessHeader title="Order Details" onBack={() => navigation.goBack()} />
        <View style={styles.centered}>
          <Ionicons name="alert-circle-outline" size={44} color={COLORS.Error} />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={load}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (!order) return null;

  const { date, time } = formatDateTime(order.created_at);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <BusinessHeader title="Order Details" subtitle={order.order_number} onBack={() => navigation.goBack()} />

      <ScrollView contentContainerStyle={styles.scroll}>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        {/* Brand mark, then Business Information — mirrors the PDF. */}
        <Text style={styles.brand}>SWACHHAM</Text>

        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>Business Information</Text>
          </View>
          <Row label="Business Name" value={order.business_name} />
          {/* The number this order was placed on -- orders.placed_by_mobile,
              the one that passed OTP for that session. "N/A" for orders from
              before the field existed rather than a substituted number. */}
          <Row label="Mobile Number" value={order.placed_by_mobile || 'N/A'} />
          <Row label="Contact Person" value={order.contact_person_name || '—'} />
          <Row label="Address" value={order.business_address || '—'} />
        </View>

        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>Order Information</Text>
            <View style={styles.statusPill}>
              <Text style={styles.statusText}>{(order.status || '').replace(/_/g, ' ')}</Text>
            </View>
          </View>
          <Row label="Order Number" value={order.order_number} />
          <Row label="Order Date" value={date} />
          <Row label="Order Time" value={time} />
          <Row label="Laundry Type" value={LAUNDRY_LABEL[order.laundry_type || ''] || '—'} />
          <Row label="Order Type" value={ORDER_LABEL[order.order_type || ''] || '—'} />
          <Row
            label="Service"
            value={SERVICE_LABEL[order.service_type || ''] || order.service_name || '—'}
          />
          <Row label="Order Status" value={(order.status || '').replace(/_/g, ' ')} />
          {/* Total order weight = SUM(item weight x quantity). */}
          <Row label="Total Weight" value={formatWeightKg(order.total_weight_kg)} />
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Items ({order.item_count})</Text>
          {order.items.map((item) => (
            <View key={item.id} style={styles.itemRow}>
              <View style={styles.itemImage}>
                {item.image_url ? (
                  <Image source={{ uri: item.image_url }} style={styles.itemImageInner} resizeMode="contain" />
                ) : (
                  <Ionicons name="shirt-outline" size={22} color={COLORS.Primary} />
                )}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.itemName}>{item.service_name}</Text>
                <Text style={styles.itemMeta}>
                  {item.category_name || '—'} · {item.quantity} {item.unit}
                </Text>
                {/* This line's own laundry service — the same value the PDF
                    prints against the item. */}
                <Text style={styles.itemMeta}>
                  Service: {item.laundry_service_name || '—'}
                </Text>
                {/*
                  THE DEFECTIVE ADJUSTMENT, WHEN THERE IS ONE.

                  Read-only, and shown here so the quantity above is never a
                  stale or unexplained figure: the line bills the FINAL count,
                  and this says what it was reduced from. Only the Sorter can
                  record or change it — the server refuses the endpoint to
                  every other role, so there is nothing to hide here beyond
                  not offering it.
                */}
                {item.defective_quantity > 0 ? (
                  <Text style={styles.itemAdjust}>
                    Ordered {item.original_quantity} · Defective{' '}
                    {item.defective_quantity} · Final {item.quantity}
                  </Text>
                ) : null}
                {/*
                  WHETHER THIS ITEM HAS GONE, when the order is split.

                  Read-only: only a Sorter can move an item between ready and
                  pending, through an endpoint this session cannot reach.
                  Pending is not defective — the item is charged as ordered
                  and is simply still being worked on.
                */}
                {item.pending_quantity > 0 ? (
                  <Text style={styles.itemPending}>
                    {item.delivery_quantity > 0
                      ? `${item.delivery_quantity} sent · ${item.pending_quantity} still being processed`
                      : `All ${item.pending_quantity} still being processed at Swachham`}
                  </Text>
                ) : null}
              </View>
              <Text style={styles.itemWeight}>{formatWeightKg(item.total_weight_kg)}</Text>
            </View>
          ))}
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Total Weight</Text>
            <Text style={styles.summaryValue}>{formatWeightKg(order.total_weight_kg)}</Text>
          </View>
        </View>

        {/* Both PDF actions run the same generator; while either is working
            both are disabled, so only one PDF is ever produced at a time. */}
        <TouchableOpacity
          style={[styles.primaryButton, pdfAction !== null && styles.buttonDisabled]}
          onPress={handleSharePdf}
          disabled={pdfAction !== null}
          activeOpacity={0.85}
        >
          {pdfAction === 'share' ? (
            <>
              <ActivityIndicator size="small" color={COLORS.Surface} />
              <Text style={styles.primaryButtonText}>Generating PDF…</Text>
            </>
          ) : (
            <>
              <Ionicons name="share-social-outline" size={20} color={COLORS.Surface} />
              <Text style={styles.primaryButtonText}>Share PDF</Text>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.primaryButton, pdfAction !== null && styles.buttonDisabled]}
          onPress={handleDownloadPdf}
          disabled={pdfAction !== null}
          activeOpacity={0.85}
        >
          {pdfAction === 'download' ? (
            <>
              <ActivityIndicator size="small" color={COLORS.Surface} />
              <Text style={styles.primaryButtonText}>Generating PDF…</Text>
            </>
          ) : (
            <>
              <Ionicons name="download-outline" size={20} color={COLORS.Surface} />
              <Text style={styles.primaryButtonText}>Download PDF</Text>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.secondaryButton, isRepeating && styles.buttonDisabled]}
          onPress={handleRepeatOrder}
          disabled={isRepeating}
          activeOpacity={0.85}
        >
          {isRepeating ? (
            <ActivityIndicator size="small" color={COLORS.Primary} />
          ) : (
            <>
              <Ionicons name="repeat-outline" size={20} color={COLORS.Primary} />
              <Text style={styles.secondaryButtonText}>Repeat Order</Text>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() =>
            navigation.navigate('BusinessOrderTrackingScreen', {
              orderId: order.id,
              orderNumber: order.order_number,
            })
          }
          activeOpacity={0.85}
        >
          <Ionicons name="navigate-outline" size={20} color={COLORS.Primary} />
          <Text style={styles.secondaryButtonText}>Track Order</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.Background },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, padding: SPACING.xl },
  scroll: { padding: SPACING.md, paddingBottom: SPACING.xxl },
  brand: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xl,
    fontWeight: 'bold',
    letterSpacing: 1.5,
    color: COLORS.PrimaryDark,
    marginBottom: SPACING.sm,
  },
  card: {
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.md,
    marginBottom: SPACING.md,
    ...SHADOWS.light,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: 'bold',
    color: COLORS.TextPrimary,
    marginBottom: SPACING.xs,
  },
  statusPill: {
    backgroundColor: COLORS.Accent + '40',
    borderRadius: BORDER_RADIUS.full,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 2,
  },
  statusText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.PrimaryDark,
    textTransform: 'capitalize',
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5, gap: SPACING.md },
  rowLabel: { fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm, color: COLORS.TextSecondary },
  rowValue: {
    flex: 1,
    textAlign: 'right',
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '600',
    color: COLORS.TextPrimary,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: SPACING.sm,
    borderTopWidth: 1,
    borderTopColor: COLORS.Border,
  },
  itemImage: {
    width: 42,
    height: 42,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: COLORS.Background,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  itemImageInner: { width: '100%', height: '100%' },
  itemName: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '600',
    color: COLORS.TextPrimary,
  },
  itemMeta: { fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm, color: COLORS.TextSecondary },
  /* The defective adjustment line under an item. Coloured, because a
     quantity that changed after the order was placed is worth noticing. */
  itemAdjust: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.Error,
    fontWeight: '600',
    marginTop: 2,
  },
  /* An item the order is still waiting on. */
  itemPending: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: '#8A5200',
    fontWeight: '600',
    marginTop: 2,
  },
  itemWeight: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '600',
    color: COLORS.PrimaryDark,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: SPACING.sm,
    paddingTop: SPACING.sm,
    borderTopWidth: 2,
    borderTopColor: COLORS.Border,
  },
  summaryLabel: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: 'bold',
    color: COLORS.TextPrimary,
  },
  summaryValue: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: 'bold',
    color: COLORS.Primary,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    height: 52,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Primary,
    ...SHADOWS.medium,
    marginBottom: SPACING.md,
  },
  primaryButtonText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: 'bold',
    color: COLORS.Surface,
  },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    height: 52,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Surface,
    borderWidth: 2,
    borderColor: COLORS.Primary,
  },
  secondaryButtonText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: 'bold',
    color: COLORS.Primary,
  },
  buttonDisabled: { opacity: 0.6 },
  errorText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.Error,
    textAlign: 'center',
    marginBottom: SPACING.sm,
  },
  retryButton: {
    backgroundColor: COLORS.Primary,
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
  },
  retryButtonText: { color: COLORS.Surface, fontFamily: TYPOGRAPHY.fontFamily, fontWeight: '600' },
});
