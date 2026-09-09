import React, { useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  ActivityIndicator,
  ScrollView,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS, SHADOWS } from '../../constants/theme';
import sorterApi, {
  DefectRecord,
  defectCopies,
  defectFullyDelivered,
} from '../../services/sorterApi';
import { extractErrorMessage } from '../../services/api';

/**
 * Defective-piece capture.
 *
 * Camera -> preview -> send. Nothing leaves the device until the Sorter taps
 * SEND, and a photo that has been taken is never thrown away by a failed
 * send: it stays on screen with a retry, so evidence is not lost to a bad
 * network moment.
 *
 * REACHED ONLY FROM MARK AS DEFECTIVE, which is what lets the report say what
 * it is about: the line, its name, its service, the pieces the order was
 * placed for and the pieces found damaged all arrive as route params and go
 * up with the photo, so the WhatsApp message names them instead of describing
 * the order in general. They are all OPTIONAL — a screen opened without them
 * still files a report against the order, exactly as it always did.
 *
 * Camera permission is requested here and nowhere else, so opening the
 * dashboard or an order never prompts for the camera. A Sorter who does not
 * report a defect is never asked.
 */

type Phase = 'camera' | 'preview' | 'sent';

/**
 * Client-side ceiling for a captured photo, comfortably under the server's
 * 12 MB body limit for this route. Base64 inflates bytes by about a third,
 * and that overhead is already accounted for at the point of the check.
 */
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

export default function SorterDefectCaptureScreen({ route, navigation }: any) {
  const {
    orderId,
    orderNumber,
    orderItemId = null,
    itemName = null,
    serviceType = null,
    totalQuantity = null,
    defectiveQuantity = null,
    // Carried from Mark Defective so the report records the same division the
    // Sorter typed, against the same line.
    whiteDefectiveQuantity = null,
    colorDefectiveQuantity = null,
    reason = '',
  } = route.params || {};

  /**
   * What goes up with the photo, and what the summary shows.
   *
   * Read straight from the params — the figures the server just stored — so
   * the screen, the request and the WhatsApp message all quote one set of
   * numbers rather than three that could drift.
   */
  const hasItemContext = Boolean(orderItemId);

  const cameraRef = useRef<CameraView | null>(null);
  const [permission, requestPermission] = useCameraPermissions();

  const [phase, setPhase] = useState<Phase>('camera');
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [photoBase64, setPhotoBase64] = useState<string | null>(null);

  const [isCapturing, setIsCapturing] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState('');
  const [defect, setDefect] = useState<DefectRecord | null>(null);

  /** Guards against a double tap firing two captures or two sends. */
  const busyRef = useRef(false);

  const capture = async () => {
    if (busyRef.current || !cameraRef.current) return;
    busyRef.current = true;
    try {
      setIsCapturing(true);
      setError('');
      // base64 comes straight back from the capture, so the file never has to
      // be read a second time. Quality is dialled down because the photo only
      // has to show the damage, and it still has to travel over shop-floor wifi.
      //
      // skipProcessing is deliberately NOT set: it bypasses the compression
      // step on Android, which produces a much larger file and ignores
      // `quality` entirely.
      const shot = await cameraRef.current.takePictureAsync({
        quality: 0.4,
        base64: true,
        imageType: 'jpg',
      });
      if (!shot?.base64) {
        setError('The photo could not be captured. Please try again.');
        return;
      }

      // Caught here rather than as a raw 413 from the server, so an unusually
      // large photo reads as something the Sorter can act on.
      const approxBytes = Math.floor((shot.base64.length * 3) / 4);
      if (approxBytes > MAX_PHOTO_BYTES) {
        setError(
          `That photo is ${(approxBytes / 1024 / 1024).toFixed(1)} MB, which is too large to send. ` +
            'Please retake it from a little further back.'
        );
        return;
      }
      setPhotoUri(shot.uri);
      setPhotoBase64(shot.base64);
      setPhase('preview');
    } catch (err: any) {
      setError(extractErrorMessage(err, 'Could not take the photo'));
    } finally {
      setIsCapturing(false);
      busyRef.current = false;
    }
  };

  const retake = () => {
    setPhotoUri(null);
    setPhotoBase64(null);
    setDefect(null);
    setError('');
    setPhase('camera');
  };

  const send = async () => {
    if (busyRef.current || !photoBase64) return;
    busyRef.current = true;
    try {
      setIsSending(true);
      setError('');
      const response = await sorterApi.reportDefect(String(orderId), {
        photoBase64,
        mimeType: 'image/jpeg',
        // The line and the count the report is about. Both optional on the
        // server, so a screen opened without them still files a report.
        orderItemId: orderItemId ? String(orderItemId) : null,
        whiteDefectiveQuantity:
          whiteDefectiveQuantity === null || whiteDefectiveQuantity === undefined
            ? null
            : Number(whiteDefectiveQuantity),
        colorDefectiveQuantity:
          colorDefectiveQuantity === null || colorDefectiveQuantity === undefined
            ? null
            : Number(colorDefectiveQuantity),
        defectiveQuantity:
          defectiveQuantity === null || defectiveQuantity === undefined
            ? null
            : Number(defectiveQuantity),
        description: reason ? String(reason) : undefined,
      });
      setDefect(response.data);
      setPhase('sent');
    } catch (err: any) {
      // The photo stays in state, so SEND can simply be pressed again.
      setError(extractErrorMessage(err, 'Could not send the defect report'));
    } finally {
      setIsSending(false);
      busyRef.current = false;
    }
  };

  /** Re-sends only the WhatsApp message; the photo is already stored. */
  const retryWhatsApp = async () => {
    if (busyRef.current || !defect) return;
    busyRef.current = true;
    try {
      setIsSending(true);
      setError('');
      const response = await sorterApi.retryDefectWhatsApp(String(orderId), defect.id);
      setDefect(response.data);
    } catch (err: any) {
      setError(extractErrorMessage(err, 'WhatsApp retry failed'));
    } finally {
      setIsSending(false);
      busyRef.current = false;
    }
  };

  const done = () => navigation.goBack();

  // ---- Permission states ----

  if (!permission) {
    return (
      <Screen title="Report Defect" onBack={() => navigation.goBack()}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={COLORS.Primary} />
        </View>
      </Screen>
    );
  }

  if (!permission.granted) {
    return (
      <Screen title="Report Defect" onBack={() => navigation.goBack()}>
        <View style={styles.permissionBlock}>
          <Ionicons name="camera-outline" size={56} color={COLORS.TextSecondary} />
          <Text style={styles.permissionTitle}>Camera access needed</Text>
          <Text style={styles.permissionText}>
            The camera is used only to photograph the damaged piece for order #{orderNumber}.
          </Text>

          {permission.canAskAgain ? (
            <TouchableOpacity style={styles.bigButton} onPress={requestPermission} activeOpacity={0.85}>
              <Ionicons name="camera" size={24} color={COLORS.Surface} />
              <Text style={styles.bigButtonText}>ALLOW CAMERA</Text>
            </TouchableOpacity>
          ) : (
            // Denied permanently: say so plainly instead of a button that
            // silently does nothing.
            <Text style={styles.permissionDenied}>
              Camera permission was denied. Enable it for Swachham in your phone's
              Settings, then come back to this screen.
            </Text>
          )}

          <TouchableOpacity style={styles.linkButton} onPress={() => navigation.goBack()}>
            <Text style={styles.linkText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </Screen>
    );
  }

  // ---- Camera ----

  if (phase === 'camera') {
    return (
      <Screen title="Report Defect" onBack={() => navigation.goBack()}>
        <View style={styles.cameraWrap}>
          <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />
          <View style={styles.cameraHint}>
            <Text style={styles.cameraHintText}>
              Frame the damaged piece for order #{orderNumber}
            </Text>
          </View>
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <View style={styles.actionBar}>
          <TouchableOpacity
            style={[styles.captureButton, isCapturing && styles.buttonDisabled]}
            onPress={capture}
            disabled={isCapturing}
            activeOpacity={0.85}
            accessibilityLabel="Capture photo"
          >
            {isCapturing ? (
              <ActivityIndicator size="small" color={COLORS.Surface} />
            ) : (
              <>
                <Ionicons name="camera" size={28} color={COLORS.Surface} />
                <Text style={styles.bigButtonText}>CAPTURE PHOTO</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </Screen>
    );
  }

  // ---- Preview and result ----

  // Retry stays offered until every copy that has a recipient is accepted by
  // Meta. A copy with nobody to send to is not a failure and no retry can
  // change it — see defectCopies.
  const allWhatsappSent = defect ? defectFullyDelivered(defect) : false;

  return (
    <Screen title="Report Defect" onBack={() => navigation.goBack()}>
      <ScrollView contentContainerStyle={styles.scroll}>
        {/* WHAT THIS REPORT IS ABOUT — the same figures that go up with the
            photo and into the WhatsApp message, shown before it is sent so
            the Sorter can see them rather than trust them. */}
        {hasItemContext ? (
          <View style={styles.detailsBlock}>
            <Text style={styles.sectionLabel}>DEFECTIVE PIECE DETAILS</Text>
            <DetailRow label="Order ID" value={`#${orderNumber}`} />
            <DetailRow label="Item" value={itemName || '—'} />
            <DetailRow label="Service Type" value={serviceType || '—'} />
            <DetailRow
              label="Total Quantity"
              value={totalQuantity === null ? '—' : String(totalQuantity)}
            />
            <DetailRow
              label="Defective Quantity"
              value={defectiveQuantity === null ? '—' : String(defectiveQuantity)}
              strong
            />
            {reason ? <DetailRow label="Reason" value={String(reason)} /> : null}
          </View>
        ) : null}

        <Text style={styles.sectionLabel}>PHOTO PREVIEW</Text>
        {photoUri ? (
          <Image source={{ uri: photoUri }} style={styles.preview} resizeMode="contain" />
        ) : null}

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        {phase === 'sent' && defect ? (
          <View style={styles.resultBlock}>
            <View style={styles.resultRow}>
              <Ionicons name="checkmark-circle" size={22} color={COLORS.Success} />
              <Text style={styles.resultText}>Photo saved against order #{orderNumber}</Text>
            </View>

            {/* One copy per recipient, each reported independently: one
                failing says nothing about the others. */}
            {defectCopies(defect).map((copy) => {
              const ok = copy.status === 'SENT';
              // No recipient at all — neither sent nor failed.
              const absent = copy.status === null;
              const color = ok
                ? COLORS.Success
                : absent
                ? COLORS.TextSecondary
                : COLORS.Error;
              return (
                <View key={copy.role}>
                  <View style={styles.resultRow}>
                    <Ionicons
                      name={
                        ok ? 'checkmark-circle' : absent ? 'remove-circle-outline' : 'alert-circle'
                      }
                      size={22}
                      color={color}
                    />
                    <Text style={[styles.resultText, { color }]}>
                      {copy.label} WhatsApp:{' '}
                      {ok
                        ? `sent${copy.to ? ` (${copy.to})` : ''}`
                        : absent
                        ? 'no recipient'
                        : 'failed to send'}
                    </Text>
                  </View>
                  {!ok && copy.error ? (
                    <Text style={styles.whatsappError}>{copy.error}</Text>
                  ) : null}
                </View>
              );
            })}
          </View>
        ) : null}

        <View style={styles.buttonColumn}>
          {phase === 'preview' ? (
            <>
              <TouchableOpacity
                style={[styles.bigButton, isSending && styles.buttonDisabled]}
                onPress={send}
                disabled={isSending}
                activeOpacity={0.85}
              >
                {isSending ? (
                  <ActivityIndicator size="small" color={COLORS.Surface} />
                ) : (
                  <>
                    <Ionicons name="logo-whatsapp" size={24} color={COLORS.Surface} />
                    <Text style={styles.bigButtonText}>SEND DEFECT REPORT</Text>
                  </>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.outlineButton, isSending && styles.buttonDisabled]}
                onPress={retake}
                disabled={isSending}
                activeOpacity={0.85}
              >
                <Ionicons name="refresh" size={22} color={COLORS.Primary} />
                <Text style={styles.outlineButtonText}>RETAKE</Text>
              </TouchableOpacity>
            </>
          ) : null}

          {phase === 'sent' && !allWhatsappSent ? (
            <TouchableOpacity
              style={[styles.bigButton, isSending && styles.buttonDisabled]}
              onPress={retryWhatsApp}
              disabled={isSending}
              activeOpacity={0.85}
            >
              {isSending ? (
                <ActivityIndicator size="small" color={COLORS.Surface} />
              ) : (
                <>
                  <Ionicons name="refresh" size={24} color={COLORS.Surface} />
                  <Text style={styles.bigButtonText}>RETRY WHATSAPP</Text>
                </>
              )}
            </TouchableOpacity>
          ) : null}

          {phase === 'sent' ? (
            <>
              <TouchableOpacity
                style={styles.outlineButton}
                onPress={() => {
                  // A second photo is a second defect report, so confirm it
                  // rather than letting a stray tap message the customer again.
                  Alert.alert(
                    'Report another defect?',
                    'This creates a new defect report and sends another WhatsApp message to ' +
                      'every recipient.',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Continue', onPress: retake },
                    ]
                  );
                }}
                activeOpacity={0.85}
              >
                <Ionicons name="camera-outline" size={22} color={COLORS.Primary} />
                <Text style={styles.outlineButtonText}>REPORT ANOTHER</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.doneButton} onPress={done} activeOpacity={0.85}>
                <Text style={styles.doneButtonText}>DONE</Text>
              </TouchableOpacity>
            </>
          ) : null}
        </View>
      </ScrollView>
    </Screen>
  );
}

/** One line of the details summary. */
function DetailRow({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={[styles.detailValue, strong && styles.detailValueStrong]} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

/** Shared frame so every phase keeps the same header and background. */
function Screen({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children: React.ReactNode;
}) {
  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={onBack} accessibilityLabel="Go back">
          <Ionicons name="arrow-back" size={22} color={COLORS.TextPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{title}</Text>
      </View>
      {children}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.Background },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    backgroundColor: COLORS.Surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.Border,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: 'bold',
    color: COLORS.TextPrimary,
  },

  // ---- camera ----
  cameraWrap: { flex: 1, backgroundColor: '#000', overflow: 'hidden' },
  cameraHint: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.md,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  cameraHintText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: '#FFFFFF',
    textAlign: 'center',
  },

  actionBar: {
    padding: SPACING.md,
    backgroundColor: COLORS.Surface,
    borderTopWidth: 1,
    borderTopColor: COLORS.Border,
  },

  // Deliberately tall: this is tapped with a thumb, often in a hurry.
  captureButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    minHeight: 62,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Primary,
    ...SHADOWS.light,
  },

  // ---- preview ----
  scroll: { padding: SPACING.md, paddingBottom: SPACING.xxl },
  sectionLabel: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '700',
    color: COLORS.TextSecondary,
    letterSpacing: 1,
    marginBottom: SPACING.sm,
  },
  preview: {
    width: '100%',
    height: 320,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: '#000',
    marginBottom: SPACING.md,
  },

  detailsBlock: {
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
    gap: SPACING.xs,
    marginBottom: SPACING.md,
    ...SHADOWS.light,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: SPACING.md,
  },
  detailLabel: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
  },
  detailValue: {
    flex: 1,
    textAlign: 'right',
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextPrimary,
  },
  detailValueStrong: { fontWeight: '700', color: COLORS.Error },

  resultBlock: {
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
    gap: SPACING.sm,
    marginBottom: SPACING.md,
    ...SHADOWS.light,
  },
  resultRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  resultText: {
    flex: 1,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.TextPrimary,
  },
  whatsappError: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.Error,
  },

  buttonColumn: { gap: SPACING.sm },

  bigButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    minHeight: 60,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Primary,
    ...SHADOWS.light,
  },
  bigButtonText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: 'bold',
    color: COLORS.Surface,
    letterSpacing: 0.5,
  },

  outlineButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    minHeight: 56,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 2,
    borderColor: COLORS.Primary,
    backgroundColor: COLORS.Surface,
  },
  outlineButtonText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: 'bold',
    color: COLORS.Primary,
    letterSpacing: 0.5,
  },

  doneButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Background,
  },
  doneButtonText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: 'bold',
    color: COLORS.TextSecondary,
  },

  buttonDisabled: { opacity: 0.6 },

  errorText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.Error,
    marginVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
  },

  // ---- permission ----
  permissionBlock: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.lg,
    gap: SPACING.md,
  },
  permissionTitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xl,
    fontWeight: 'bold',
    color: COLORS.TextPrimary,
  },
  permissionText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.TextSecondary,
    textAlign: 'center',
  },
  permissionDenied: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.Error,
    textAlign: 'center',
  },
  linkButton: { paddingVertical: SPACING.sm },
  linkText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    color: COLORS.TextSecondary,
  },
});
