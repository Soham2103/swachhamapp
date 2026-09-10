import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  Linking,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import { openPdfInDeviceViewer } from '../../utils/openPdf';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS, SHADOWS } from '../../constants/theme';
import sorterApi, {
  SorterOrderDetail,
  SorterOrderItem,
  SorterStage,
  ScanStatus,
  ScanStageName,
  DefectRecord,
  PendingItemRecord,
  defectCopies,
  defectFullyDelivered,
} from '../../services/sorterApi';
import MarkDefectiveModal, { DefectiveSplit } from './MarkDefectiveModal';
import PendingItemsModal from './PendingItemsModal';
import { API_BASE_URL } from '../../constants/api';
import { extractErrorMessage } from '../../services/api';
import { BusinessOrderDetail } from '../../services/businessOrderApi';
import {
  generateOrderPdf,
  formatWeightKg,
  formatDateTime,
  LAUNDRY_LABEL,
  ORDER_LABEL,
} from '../../utils/businessOrderPdf';
import { generateSockedDetailsPdf } from '../../utils/sockedDetailsPdf';
import { STAGE_META } from './SorterDashboardScreen';

/**
 * The one step available from each stage, the label it carries, and which
 * scan session it offers. Scanning is optional — a step is never blocked by
 * it; the `scan` field only decides which scan screen the button opens.
 */
const NEXT_ACTION: Record<
  SorterStage,
  { target: 'accepted' | 'ready' | 'out_for_delivery'; label: string; scan?: ScanStageName } | null
> = {
  confirmed: { target: 'accepted', label: 'ACCEPT ORDER', scan: 'acceptance' },
  accepted: { target: 'ready', label: 'MARK AS READY' },
  ready: { target: 'out_for_delivery', label: 'OUT FOR DELIVERY', scan: 'delivery' },
  /*
   * A PART-FINISHED ORDER STILL MOVES. Its ready items go with this dispatch
   * and the pending ones stay behind — holding the whole order because one
   * item needs more time is exactly what this must not do.
   */
  partially_completed: {
    target: 'out_for_delivery',
    label: 'SEND READY ITEMS',
    scan: 'delivery',
  },
  out_for_delivery: null,
};

/**
 * Sorter order detail.
 *
 * Shows the job, the confirmation document and exactly one forward action.
 * The action the screen offers is derived from the current status, and the
 * server re-validates the transition, so the UI can never talk it into a skip.
 */
/**
 * THE ORDER-LEVEL CLOTH COUNTS.
 *
 * Counted off the pile ONCE for the whole order, which is why they sit above
 * the Items card rather than inside it: the pile is the order, and the lines
 * it breaks down into are not what gets counted here.
 */
/**
 * The Cloth Count card's boxes.
 *
 * These two, and only these two, are what the line's quantity is checked
 * against. Socked cloth is counted separately below and takes no part in it.
 */
const CLOTH_COUNT_FIELDS = [
  { key: 'white', label: 'White Cloths' },
  { key: 'color', label: 'Color Cloths' },
] as const;

/**
 * The Socked Cloth card's boxes.
 *
 * A SEPARATE COUNT, stored in its own two columns and deliberately outside the
 * quantity check: socked cloth is counted alongside the pile, not out of it.
 */
const SOCKED_FIELDS = [
  { key: 'whiteSocked', label: 'White Socked' },
  { key: 'colorSocked', label: 'Color Socked' },
] as const;

type ClothCountKey =
  | (typeof CLOTH_COUNT_FIELDS)[number]['key']
  | (typeof SOCKED_FIELDS)[number]['key'];

/** What a line's boxes hold before anything has been counted or loaded. */
const EMPTY_CLOTH_COUNTS: Record<ClothCountKey, string> = {
  white: '',
  color: '',
  whiteSocked: '',
  colorSocked: '',
};

/** Every line's boxes, keyed by order item id. */
type ClothCountsByItem = Record<string, Record<ClothCountKey, string>>;

/**
 * One line's socked total, for the Socked Details document.
 *
 * `white_socked + color_socked` when either was counted — those are the two
 * boxes the screen writes. `socked_cloth_count` is the fallback for a row
 * counted before migration 061 split that single box in two.
 *
 * NULL when nothing was counted at all, which the document prints as "—".
 * That is a different fact from 0 ("counted, and there were none"), and the
 * document is careful to keep them apart.
 */
function sockedTotalOf(record: PendingItemRecord | undefined): number | null {
  if (!record) return null;

  const white = record.white_socked;
  const colour = record.color_socked;

  if (white !== null || colour !== null) return (white || 0) + (colour || 0);

  return record.socked_cloth_count;
}

/**
 * A saved record as its line's boxes show it.
 *
 * NULL BECOMES AN EMPTY BOX, never "0". The line has no count recorded, and
 * printing a zero would state one that was never taken.
 *
 * `socked_cloth_count` is not read here: the older single Socked Cloths box is
 * gone from the screen, and the two socked columns are what these boxes show.
 */
function boxesOf(record: PendingItemRecord | undefined): Record<ClothCountKey, string> {
  if (!record) return EMPTY_CLOTH_COUNTS;
  const show = (value: number | null) => (value === null ? '' : String(value));
  return {
    white: show(record.white_cloth_count),
    color: show(record.color_cloth_count),
    whiteSocked: show(record.white_socked),
    colorSocked: show(record.color_socked),
  };
}

/**
 * Every line's boxes, from what the order came back carrying.
 *
 * Driven by the ORDER'S items and not by the saved records, so a line that has
 * never been counted still gets its own empty set of boxes.
 */
function boxesForOrder(order: SorterOrderDetail): ClothCountsByItem {
  // Defended rather than assumed: a backend that has not been restarted onto
  // this version sends no pending_items at all, and a screen that threw on
  // that would fail to load the order instead of simply showing empty boxes.
  const saved = new Map(
    (order.pending_items ?? []).map((record) => [record.order_item_id, record])
  );
  const next: ClothCountsByItem = {};
  for (const item of order.items) next[item.id] = boxesOf(saved.get(item.id));
  return next;
}

/**
 * A box's contents as the endpoint wants them.
 *
 * An emptied box is null — "not counted" — and not 0, so clearing a count and
 * counting none stay the two different facts they are.
 */
function clothCountPayload(raw: string): number | null {
  return raw.trim() === '' ? null : Number(raw);
}

/**
 * One box as a number for the purpose of the total.
 *
 * AN EMPTY BOX IS 0 HERE, and only here. What is SAVED still distinguishes an
 * empty box from a typed zero -- empty is "not counted" -- but a line cannot
 * be part-counted for the purpose of checking it against the quantity, so an
 * empty box weighs nothing in the sum.
 */
function clothCountValue(raw: string): number {
  return raw.trim() === '' ? 0 : Number(raw);
}

/**
 * The line total, worked out the way the count is taken.
 *
 *   (White Cloth - White Socked) + (Color Cloth - Color Socked)
 *     + White Socked + Color Socked
 *
 * SOCKED CLOTH COMES OUT OF THE CLOTH COUNTED FOR ITS COLOUR and is then put
 * back as its own figure, so the pile is neither double counted nor lost.
 *
 * Written out in full rather than reduced. The two socked terms cancel, so
 * this always equals White Cloth + Color Cloth -- but the form above is the
 * rule as the shop floor states it, and a reader checking the code against
 * the rule should not have to re-derive it. What the socked boxes actually
 * constrain is enforced by clothCountsWithinSocked below.
 */
function clothCountTotalOf(boxes: Record<ClothCountKey, string> = EMPTY_CLOTH_COUNTS) {
  const white = clothCountValue(boxes.white);
  const color = clothCountValue(boxes.color);
  const whiteSocked = clothCountValue(boxes.whiteSocked);
  const colorSocked = clothCountValue(boxes.colorSocked);
  const remainingWhite = white - whiteSocked;
  const remainingColor = color - colorSocked;
  return remainingWhite + remainingColor + whiteSocked + colorSocked;
}

/**
 * Neither remainder may go negative.
 *
 * Socked cloth is taken OUT OF the cloth counted for that colour, so it can
 * never exceed it. A line claiming more socked than cloth has been miscounted,
 * and the total alone would not catch it: the socked terms cancel, so 40/10
 * with 99 white socked still sums to 50.
 */
function clothCountsWithinSocked(boxes: Record<ClothCountKey, string> = EMPTY_CLOTH_COUNTS) {
  return (
    clothCountValue(boxes.whiteSocked) <= clothCountValue(boxes.white) &&
    clothCountValue(boxes.colorSocked) <= clothCountValue(boxes.color)
  );
}

function sameBoxes(
  a: Record<ClothCountKey, string> = EMPTY_CLOTH_COUNTS,
  b: Record<ClothCountKey, string> = EMPTY_CLOTH_COUNTS
) {
  return (
    a.white === b.white &&
    a.color === b.color &&
    a.whiteSocked === b.whiteSocked &&
    a.colorSocked === b.colorSocked
  );
}

export default function SorterOrderDetailsScreen({ navigation, route }: any) {
  const { orderId } = route.params || {};
  const [order, setOrder] = useState<SorterOrderDetail | null>(null);
  const [scan, setScan] = useState<ScanStatus | null>(null);
  const [retryingDefectId, setRetryingDefectId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isBuildingPdf, setIsBuildingPdf] = useState(false);
  const [error, setError] = useState('');
  /*
   * ONCE ACCEPTED, DEFECTIVE PIECES ARE LOCKED.
   *
   * Read from the ORDER'S OWN RECORD (`accepted_at`), not from which screen
   * this is or what the sorter last tapped — so the button matches what the
   * API will actually allow. The server refuses an adjustment after
   * acceptance regardless; this stops the sorter being offered an action
   * that can only fail.
   *
   * Defects recorded BEFORE acceptance stay visible either way: this hides
   * the action, never the data.
   */
  /** The line whose Mark Defective form is open, or null. */
  const [defectiveFor, setDefectiveFor] = useState<SorterOrderItem | null>(null);
  const [savingAdjustment, setSavingAdjustment] = useState(false);
  const [sendingAdjustmentWhatsApp, setSendingAdjustmentWhatsApp] = useState(false);
  /** The item whose status is being changed, so only its own row spins. */
  const [itemBusyId, setItemBusyId] = useState<string | null>(null);
  /** Open while the Sorter answers the pending-items question. */
  const [pendingPrompt, setPendingPrompt] = useState(false);
  /** True while the Socked Details document is being produced. */
  const [isBuildingSockedPdf, setIsBuildingSockedPdf] = useState(false);
  /**
   * The three counts, held against the order being viewed.
   *
   * KEYED TO THE ORDER, and cleared whenever a different one is opened, so a
   * number typed against one order can never be read as another's. The screen
   * already mounts per order; the reset is what makes that a guarantee rather
   * than a consequence of how navigation happens to work today.
   *
   * Held for as long as the screen is open and sent nowhere: the order has no
   * field for these and no endpoint accepts them, so storing them would be a
   * change to the workflow rather than an addition to the page.
   */
  /** What is typed in each line's boxes, keyed by order item id. */
  const [clothCounts, setClothCounts] = useState<ClothCountsByItem>({});
  /**
   * What each line's boxes held when last read from or written to the server.
   *
   * Kept beside what is typed so the two can be compared per line: that is
   * what makes one line's Save light up without lighting up every other, and
   * what tells a reload whether it may refresh a line's boxes.
   */
  const [savedClothCounts, setSavedClothCounts] = useState<ClothCountsByItem>({});
  /** The line whose counts are being written, so only its own button spins. */
  const [clothCountBusyId, setClothCountBusyId] = useState<string | null>(null);
  /**
   * Read by `load`, which must not depend on either piece of state.
   *
   * The screen reloads on every focus and after every action, and a reload
   * that overwrote half-typed counts would lose a number somebody had just
   * read off a pile. So a reload refreshes only the lines that are untouched,
   * and unsaved typing survives it.
   */
  const clothCountsRef = useRef<ClothCountsByItem>({});
  const savedClothCountsRef = useRef<ClothCountsByItem>({});
  useEffect(() => {
    clothCountsRef.current = clothCounts;
  }, [clothCounts]);
  useEffect(() => {
    savedClothCountsRef.current = savedClothCounts;
  }, [savedClothCounts]);
  useEffect(() => {
    setClothCounts({});
    setSavedClothCounts({});
    clothCountsRef.current = {};
    savedClothCountsRef.current = {};
  }, [orderId]);

  /** Synchronous lock: two taps in one frame cannot both fire a transition. */
  const busyRef = useRef(false);

  /**
   * Releases one held-back item once the Sorter has finished it.
   *
   * The server re-derives the ORDER's status from its items afterwards, so
   * the order returns to READY_FOR_DELIVERY as soon as nothing is pending —
   * which is why this reloads rather than patching state locally.
   *
   * Nothing financial moves: an item needing more time is not a defect, and
   * releasing it changes no quantity, price, invoice or payment.
   */
  const setItemReady = async (item: SorterOrderItem) => {
    if (itemBusyId) return;
    setItemBusyId(item.id);
    setError('');
    try {
      // 0 held = the whole line is finished and goes with the next dispatch.
      const response = await sorterApi.setItemPendingQuantity(String(orderId), item.id, 0);
      await load();
      const left = response.data.pending_quantity;
      Alert.alert(
        'Item completed',
        `All ${item.original_quantity} piece(s) of ${item.item_name} are ready.` +
          (left > 0
            ? `\n\n${left} piece(s) still pending on this order.`
            : '\n\nEvery piece on this order is now ready.')
      );
    } catch (err: any) {
      Alert.alert('Not saved', extractErrorMessage(err, 'Could not update the item'));
    } finally {
      setItemBusyId(null);
    }
  };

  /**
   * The pending-items answer, then the `ready` step.
   *
   * `itemIds` empty is "No, all items completed" and is NOT the same as not
   * asking: it marks every line READY explicitly. The distinction is the
   * server's, and it is what keeps every other caller's behaviour unchanged.
   */
  const finishWithPending = async (
    pendingItems: Array<{ orderItemId: string; pendingQuantity: number }>,
    reason: string
  ) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setIsUpdating(true);
    setError('');
    try {
      const response = await sorterApi.updateStatus(String(orderId), 'ready', {
        items: pendingItems,
        reason: reason || undefined,
      });
      setPendingPrompt(false);
      await load();
      const { pending_quantity: held, delivery_quantity: going } = response.data;
      Alert.alert(
        held > 0 ? 'Ready pieces sent forward' : 'Order marked ready',
        held > 0
          ? `${going} piece(s) go out for delivery.\n` +
            `${held} piece(s) stay with Swachham for further processing.`
          : 'Every piece on this order is ready.'
      );
    } catch (err: any) {
      // The sheet stays open on failure, so the figures the Sorter typed are
      // still there to correct rather than having to be entered again.
      setError(extractErrorMessage(err, 'Could not update the order'));
      Alert.alert('Not saved', extractErrorMessage(err, 'Could not update the order'));
    } finally {
      setIsUpdating(false);
      busyRef.current = false;
    }
  };

  /**
   * Saves a defective quantity, then RELOADS the order from the server.
   *
   * The reload is the point: the server re-prices the line, the order total
   * and the weights inside its transaction, so the screen shows what was
   * actually stored rather than a locally patched copy that could drift from
   * it — particularly if another Sorter adjusted the same order meanwhile.
   */
  /**
   * The API call both defective actions share.
   *
   * Returns the saved line, or null when the server refused it — the caller
   * then knows not to move on. The error is surfaced here, so neither caller
   * has to repeat that.
   */
  const persistAdjustment = async (
    item: SorterOrderItem,
    defectiveQuantity: number,
    reason: string,
    split: DefectiveSplit
  ) => {
    try {
      const response = await sorterApi.adjustDefectiveQuantity(
        String(orderId),
        item.id,
        defectiveQuantity,
        reason,
        // The two boxes travel with the total. The server takes the total
        // from their sum and checks each against its own cloth count.
        split
      );
      await applyDefectToClothCounts(item, split);
      setDefectiveFor(null);
      await load();
      return response.data.item;
    } catch (err: any) {
      // The server's message is the useful one — it names which rule was
      // broken, or why the order can no longer be adjusted.
      setError(extractErrorMessage(err, 'Could not save the defective quantity'));
      Alert.alert(
        'Not saved',
        extractErrorMessage(err, 'Could not save the defective quantity')
      );
      return null;
    }
  };

  /**
   * TAKES THE DEFECTIVE PIECES OFF THE CLOTH COUNT, and stores what is left.
   *
   * The boxes hold what remains on the line, so recording 2 white defective
   * against a count of 10 leaves 8 in the White Cloths box, saved.
   *
   * BY THE DIFFERENCE, NOT THE WHOLE FIGURE. Edit Defective re-states the
   * defect for the line rather than adding to it, so what comes off the count
   * is the CHANGE since the last save: correcting 2 to 3 takes one more piece,
   * and correcting 3 back to 1 puts two back. Subtracting the new figure
   * outright would compound on every correction, taking 2 then 3 then 1 off
   * the same count until nothing was left of it.
   *
   * Called with the line as it stood BEFORE the save, which is what makes the
   * previous figure available to difference against.
   *
   * A line with no count recorded is left alone: there is nothing to subtract
   * from, and writing a count here would invent one the Sorter never took.
   */
  const applyDefectToClothCounts = async (
    item: SorterOrderItem,
    split: DefectiveSplit
  ) => {
    const record = (order?.pending_items ?? []).find((r) => r.order_item_id === item.id);
    if (!record) return;

    const whiteDelta = split.white - (item.white_defective_quantity || 0);
    const colorDelta = split.color - (item.color_defective_quantity || 0);
    if (whiteDelta === 0 && colorDelta === 0) return;

    // Never below zero: a count cannot go negative, and the server refuses a
    // defect larger than the count in any case.
    const next = (counted: number | null, delta: number) =>
      counted === null ? null : Math.max(0, counted - delta);

    const white = next(record.white_cloth_count, whiteDelta);
    const color = next(record.color_cloth_count, colorDelta);

    try {
      /*
       * Only the two cloth counts are sent. The socked boxes are omitted, so
       * the endpoint leaves those columns exactly as they are — defective
       * pieces are not socked cloth.
       */
      await sorterApi.savePendingItemCounts(String(orderId), item.id, { white, color });
    } catch (err: any) {
      // The defect itself is already saved and is the record that matters, so
      // this is surfaced rather than thrown: the reload that follows shows the
      // counts as they actually stand.
      setError(
        extractErrorMessage(err, `Saved the defect, but could not update the cloth count for ${item.item_name}`)
      );
    }
  };

  const saveAdjustment = async (
    defectiveQuantity: number,
    reason: string,
    split: DefectiveSplit
  ) => {
    if (!defectiveFor || savingAdjustment) return;
    setSavingAdjustment(true);
    setError('');
    try {
      const saved = await persistAdjustment(defectiveFor, defectiveQuantity, reason, split);
      if (!saved) return;

      // Pieces only. No amount is shown, and none is sent — see the note at
      // the top of MarkDefectiveModal.
      Alert.alert(
        'Defective adjustment saved',
        `${saved.item_name}

` +
          `Original: ${saved.original_quantity}
` +
          `Defective: ${saved.defective_quantity}
` +
          `Final: ${saved.final_quantity}`,
        [
          { text: 'Done', style: 'cancel' },
          { text: 'Send WhatsApp', onPress: sendAdjustmentWhatsApp },
        ]
      );
    } finally {
      setSavingAdjustment(false);
    }
  };

  /**
   * MARK AS DEFECTIVE -> REPORT THE DEFECTIVE PIECE.
   *
   * The figures are saved first and the camera opens second, so the photo and
   * the count it belongs to are always the same submission. The capture
   * screen is handed the LINE — its id, name and quantities — which is what
   * lets the WhatsApp message name the item, its service and both quantities
   * instead of describing the order in general.
   *
   * This is the only way into the defect camera now: a standalone button
   * could be tapped without any of this context, and the report it produced
   * was the one that could not say what was wrong with what.
   */
  const reportDefectivePiece = async (
    defectiveQuantity: number,
    reason: string,
    split: DefectiveSplit
  ) => {
    if (!defectiveFor || savingAdjustment || !order) return;
    const item = defectiveFor;
    setSavingAdjustment(true);
    setError('');
    try {
      const saved = await persistAdjustment(item, defectiveQuantity, reason, split);
      if (!saved) return;

      navigation.navigate('SorterDefectCaptureScreen', {
        orderId,
        orderNumber: order.order_number,
        orderItemId: item.id,
        itemName: saved.item_name,
        // The server's own figures, not the ones typed — it is the authority
        // on what was stored, and the message quotes what was stored.
        totalQuantity: saved.original_quantity,
        defectiveQuantity: saved.defective_quantity,
        serviceType: item.laundry_service_name,
        // The two figures as typed. The total above comes from the server,
        // which is the authority on what was stored; the split is not stored
        // on the line, so it travels from here.
        whiteDefectiveQuantity: split.white,
        colorDefectiveQuantity: split.color,
        reason,
      });
    } finally {
      setSavingAdjustment(false);
    }
  };

  /**
   * Tells the customer or business about the adjustment.
   *
   * A DELIBERATE, separate action: saving never sends, so correcting a figure
   * three times does not send three messages. The server refuses a second
   * send for the same adjustment, which is what makes a stray tap harmless.
   */
  const sendAdjustmentWhatsApp = async () => {
    if (sendingAdjustmentWhatsApp) return;
    setSendingAdjustmentWhatsApp(true);
    setError('');
    try {
      const response = await sorterApi.sendAdjustmentWhatsApp(String(orderId));
      await load();
      if (response.data?.status === 'SENT') {
        Alert.alert('Sent', `The adjustment was sent to ${response.data.sent_to || 'the customer'}.`);
      } else {
        // Meta refused it. The reason is shown as it came back, never softened
        // into a success.
        Alert.alert('Not sent', response.data?.error || 'WhatsApp did not accept the message.');
      }
    } catch (err: any) {
      Alert.alert('Not sent', extractErrorMessage(err, 'Could not send the notification'));
    } finally {
      setSendingAdjustmentWhatsApp(false);
    }
  };

  const load = useCallback(async () => {
    try {
      setError('');
      setIsLoading(true);
      const [detail, scanStatus] = await Promise.all([
        sorterApi.getOrderById(String(orderId)),
        sorterApi.getScanStatus(String(orderId)),
      ]);
      setOrder(detail.data);
      /*
       * The saved counts, line by line, and the boxes with them — except on a
       * line whose boxes differ from what was last saved, which is somebody
       * mid-count and is left exactly as they typed it.
       */
      const stored = boxesForOrder(detail.data);
      setSavedClothCounts(stored);
      setClothCounts((current) => {
        const next: ClothCountsByItem = {};
        for (const [itemId, boxes] of Object.entries(stored)) {
          const typed = current[itemId];
          const wasSaved = savedClothCountsRef.current[itemId];
          next[itemId] = typed && !sameBoxes(typed, wasSaved) ? typed : boxes;
        }
        return next;
      });
      setScan(scanStatus.data);
    } catch (err: any) {
      setError(extractErrorMessage(err, 'Failed to load order'));
    } finally {
      setIsLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', load);
    load();
    return unsubscribe;
  }, [navigation, load]);

  /**
   * The confirmation document.
   *
   * A stored URL wins when the order has one. Otherwise the same PDF template
   * the Business app uses renders it from the order data — one generator, one
   * layout, and no second copy of the document anywhere.
   */
  const handleViewPdf = async () => {
    if (isBuildingPdf || !order) return;
    try {
      setIsBuildingPdf(true);
      setError('');

      const response = await sorterApi.getConfirmationPdf(String(orderId));

      /*
       * THE FILE IS ON THE DEVICE BEFORE ANYTHING IS OPENED.
       *
       * A stored URL is DOWNLOADED first rather than handed to
       * `Linking.openURL`, which gives the address to a browser — the
       * browser then renders or re-downloads it, which is the "opens as a
       * webpage" behaviour rather than the phone's PDF viewer. With the file
       * local, `openPdfInDeviceViewer` can hand the OS a real content:// URI
       * and let it choose a viewer.
       */
      let uri: string;
      let fileName: string;

      if (response.data.url) {
        fileName = `order-${orderId}.pdf`;
        const target = `${FileSystem.cacheDirectory}${fileName}`;
        const downloaded = await FileSystem.downloadAsync(response.data.url, target);
        uri = downloaded.uri;
      } else {
        const generated = await generateOrderPdf(toPdfShape(response.data.order));
        uri = generated.uri;
        fileName = generated.fileName;
      }

      const outcome = await openPdfInDeviceViewer(uri, fileName);
      if (outcome === 'unavailable') {
        Alert.alert(
          'No PDF viewer',
          `This device has no app that can open a PDF. The file is saved as ${fileName}.`
        );
      }
    } catch (err: any) {
      if (__DEV__) console.error('[Sorter] PDF failed', err);
      setError('Unable to open the confirmation PDF. Please try again.');
    } finally {
      setIsBuildingPdf(false);
    }
  };

  /**
   * Writes ONE LINE'S cloth counts to `pending_item`.
   *
   * All three of that line's boxes go together because the line saves as one,
   * and the server's reply — not what was typed — is what its boxes are then
   * set from, so the screen shows what the row actually holds.
   *
   * No status moves and nothing is re-derived: this records a count taken
   * during sorting and is not a step in the workflow.
   */
  const saveClothCounts = async (item: SorterOrderItem) => {
    if (clothCountBusyId) return;
    const boxes = clothCounts[item.id] || EMPTY_CLOTH_COUNTS;
    setClothCountBusyId(item.id);
    setError('');
    try {
      const response = await sorterApi.savePendingItemCounts(String(orderId), item.id, {
        white: clothCountPayload(boxes.white),
        color: clothCountPayload(boxes.color),
        // Its own two columns, written on the same row as the cloth counts:
        // one line has one record, and this is more of what is known about it.
        // `socked` is not sent — the older single box no longer exists, and
        // omitting it leaves whatever that column already holds untouched.
        whiteSocked: clothCountPayload(boxes.whiteSocked),
        colorSocked: clothCountPayload(boxes.colorSocked),
      });
      const shown = boxesOf(response.data);
      setClothCounts((current) => ({ ...current, [item.id]: shown }));
      setSavedClothCounts((current) => ({ ...current, [item.id]: shown }));
      /*
       * The order's own copy of the records is kept in step, so the Socked
       * Details document can be produced straight after a save without
       * waiting for the next reload.
       */
      setOrder((current) =>
        current
          ? {
              ...current,
              pending_items: [
                ...(current.pending_items ?? []).filter((r) => r.order_item_id !== item.id),
                response.data,
              ],
            }
          : current
      );
    } catch (err: any) {
      setError(extractErrorMessage(err, `Failed to save the cloth counts for ${item.item_name}`));
    } finally {
      setClothCountBusyId(null);
    }
  };

  /**
   * THE SOCKED DETAILS DOCUMENT.
   *
   * Built from what is SAVED in `pending_item` and carried on the order — not
   * from what happens to be typed in the boxes — so the document reports
   * counts that were actually recorded. A line with nothing saved still gets a
   * row, marked as not counted, rather than being dropped.
   *
   * Entirely separate from the confirmation PDF: its own template, its own
   * generator and its own file name.
   */
  const handleSockedDetailsPdf = async () => {
    if (isBuildingSockedPdf || !order) return;
    try {
      setIsBuildingSockedPdf(true);
      setError('');

      const saved = new Map((order.pending_items ?? []).map((r) => [r.order_item_id, r]));
      const { uri, fileName } = await generateSockedDetailsPdf({
        order_number: order.order_number,
        business_name: order.customer_name,
        rows: order.items.map((item) => ({
          item_name: item.item_name,
          /*
           * THE SOCKED FIGURE, FROM THE COLUMNS THAT ARE ACTUALLY WRITTEN.
           *
           * This read `socked_cloth_count` — the older single "Socked Cloths"
           * box, which migration 061 replaced with `white_socked` and
           * `color_socked` and which THIS SCREEN NO LONGER WRITES. Every row
           * counted since then has NULL there, so the document printed "—"
           * on every line: it generated a valid PDF containing nothing.
           *
           * The two current columns are summed, because the column on the
           * document is one total. The legacy column is the fallback so a row
           * counted before 061 still prints the figure it does hold, and a
           * line with no counts at all still prints "—" rather than a zero
           * nobody counted.
           */
          socked_quantity: sockedTotalOf(saved.get(item.id)),
        })),
      });

      const outcome = await openPdfInDeviceViewer(uri, fileName);
      if (outcome === 'unavailable') {
        Alert.alert(
          'No PDF viewer',
          `This device has no app that can open a PDF. The file is saved as ${fileName}.`
        );
      }
    } catch (err: any) {
      if (__DEV__) console.error('[Sorter] socked details PDF failed', err);
      setError('Unable to open the socked details PDF. Please try again.');
    } finally {
      setIsBuildingSockedPdf(false);
    }
  };

  /** Confirmed first — a status change on the shop floor is hard to walk back. */
  const handleAdvance = () => {
    if (!order || !order.stage) return;
    const action = NEXT_ACTION[order.stage];
    if (!action || busyRef.current) return;

    /*
     * THE PENDING-ITEMS QUESTION, asked at the step where the shop floor
     * finishes with an order.
     *
     * It is ASKED, never assumed, because assuming "all done" is precisely
     * how a half-finished order gets marked complete. Both answers are a
     * deliberate tap, and neither is the default.
     */
    if (action.target === 'ready') {
      Alert.alert(
        'Pending items',
        `Order #${order.order_number}\n\nAre there any pending items in this order?`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'YES, PENDING ITEMS', onPress: () => setPendingPrompt(true) },
          {
            // The explicit "no": every line is marked READY and the order
            // completes exactly as it always has.
            text: 'NO, ALL COMPLETED',
            onPress: () => finishWithPending([], ''),
          },
        ]
      );
      return;
    }

    Alert.alert(
      action.label === 'ACCEPT ORDER' ? 'Accept order' : 'Confirm',
      `Order #${order.order_number}\n\nSet this order to "${action.target}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Confirm', onPress: () => advance(action.target) },
      ]
    );
  };

  const advance = async (target: 'accepted' | 'ready' | 'out_for_delivery') => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      setIsUpdating(true);
      setError('');
      const response = await sorterApi.updateStatus(String(orderId), target);
      Alert.alert('Status updated', `Order #${response.data.order_number} is now ${target}.`);
      await load();
    } catch (err: any) {
      setError(extractErrorMessage(err, 'Failed to update status'));
    } finally {
      setIsUpdating(false);
      busyRef.current = false;
    }
  };

  /**
   * Re-sends a defect notification that Meta rejected.
   *
   * A defect already marked SENT is refused by the server, so a stray tap
   * cannot message the customer twice; that 409 is surfaced as a normal
   * error rather than being retried behind the Sorter's back.
   */
  const retryDefectWhatsApp = async (defect: DefectRecord) => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      setRetryingDefectId(defect.id);
      setError('');
      const response = await sorterApi.retryDefectWhatsApp(String(orderId), defect.id);
      if (defectFullyDelivered(response.data)) {
        Alert.alert('WhatsApp sent', 'Every recipient of this report has been notified.');
      } else {
        // Say which copy is still outstanding rather than a blanket failure.
        Alert.alert(
          'WhatsApp not fully delivered',
          defectCopies(response.data)
            .map((copy) =>
              copy.status === 'SENT'
                ? `${copy.label}: sent`
                : copy.status === null
                ? `${copy.label}: no recipient`
                : `${copy.label}: ${copy.error || 'failed'}`
            )
            .join('\n')
        );
      }
      await load();
    } catch (err: any) {
      setError(extractErrorMessage(err, 'WhatsApp retry failed'));
    } finally {
      setRetryingDefectId(null);
      busyRef.current = false;
    }
  };

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <Header onBack={() => navigation.goBack()} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={COLORS.Primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (!order) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <Header onBack={() => navigation.goBack()} />
        <View style={styles.centered}>
          <Ionicons name="alert-circle-outline" size={44} color={COLORS.Error} />
          <Text style={styles.errorText}>{error || 'Order not found'}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={load}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const meta = order.stage ? STAGE_META[order.stage] : null;
  const action = order.stage ? NEXT_ACTION[order.stage] : null;

  /*
   * ONCE ACCEPTED, DEFECTIVE PIECES ARE LOCKED.
   *
   * From the ORDER'S OWN RECORD (`accepted_at`), not from which screen this
   * is — so the button matches what the API will allow. The server refuses an
   * adjustment after acceptance regardless; this stops the sorter being
   * offered an action that can only fail.
   *
   * Defects recorded BEFORE acceptance stay visible: this hides the action,
   * never the data.
   */
  const defectsLocked = Boolean(order.accepted_at);

  /**
   * The cloth counts are a BEFORE-ACCEPTANCE decision.
   *
   * White/Colour and the two Socked figures are what the Sorter works out
   * while deciding what to accept. Once the order is accepted it belongs to
   * batching, and these boxes are gone from every later stage — the same
   * moment `defectsLocked` uses, because it is the same acceptance.
   *
   * The server stops sending `pending_items` at that point too, so this is
   * not a UI-only hide that another screen could undo: after acceptance there
   * is nothing to show. The stored counts are untouched and are still what
   * the batch weight calculation reads.
   */
  const showClothCounts = !order.accepted_at;

  /**
   * THE CARDS THAT ARE THE SORTER'S WORKING SURFACE.
   *
   * Items, Garment verification and Defective piece are how an order is
   * WORKED — counted, scanned, and inspected for damage. Once it has been
   * accepted that work is finished and its figures are settled, so the three
   * go and the screen stops inviting an edit it would refuse anyway
   * (`defectsLocked` already blocks the defect path, and the server refuses
   * it too).
   *
   * DEFECTIVE ADJUSTMENT IS NOT ONE OF THEM AND MUST STAY. It is the RECORD
   * of what was decided rather than a place to decide it — the history, and
   * the notification the customer is sent — and that is exactly what someone
   * needs to look at after acceptance. It is rendered on
   * `order.has_adjustment` alone and no acceptance check may be added to it.
   *
   * Gated on `accepted_at`, which is server state, so the cards stay hidden
   * across a refresh and on any device. Nothing is deleted: every figure
   * these cards showed is still stored and still returned by the endpoints
   * that own it.
   */
  const showWorkingCards = !order.accepted_at;

  /**
   * The counted white and colour cloth on the line the defect form is open
   * for, or nulls when that line has never been counted.
   *
   * Read from `pending_items` rather than from the item, because that is
   * where the counts live. The server sends them net of the defect already
   * recorded, which is what the modal expects.
   */
  const countsForDefectiveLine = (() => {
    if (!defectiveFor) return { white: null, colour: null };
    const record = (order.pending_items ?? []).find(
      (r) => r.order_item_id === defectiveFor.id
    );
    return {
      white: record?.white_cloth_count ?? null,
      colour: record?.color_cloth_count ?? null,
    };
  })();

  // Which scan session this stage needs, and whether it is complete.
  const scanStage = action?.scan ?? null;
  const scanScanned = scanStage === 'delivery' ? scan?.delivery_scanned ?? 0 : scan?.acceptance_scanned ?? 0;
  const scanMatched = scanStage === 'delivery' ? scan?.delivery_matched ?? false : scan?.acceptance_matched ?? false;
  const scanRemaining = Math.max((scan?.expected_count ?? 0) - scanScanned, 0);
  /**
   * Scanning is an optional aid, never a gate: the action button is enabled
   * whatever the scan counts say. The server no longer blocks the transition
   * either, so this is not a UI-only relaxation.
   */
  const actionBlocked = false;
  const { date, time } = formatDateTime(order.created_at);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Header onBack={() => navigation.goBack()} />

      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.headlineRow}>
          <Text style={styles.orderNumber}>#{order.order_number}</Text>
          {meta ? (
            <View style={[styles.statusPill, { backgroundColor: meta.color }]}>
              <Text style={styles.statusText}>{meta.label}</Text>
            </View>
          ) : null}
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Customer</Text>
          <Row label="Name" value={order.customer_name} />
          <Row label="Contact" value={order.customer_contact || '—'} />
          <Row label="Order Date" value={`${date} ${time}`} />
          <Row label="Laundry Type" value={LAUNDRY_LABEL[order.laundry_type || ''] || '—'} />
          <Row label="Order Type" value={ORDER_LABEL[order.order_type || ''] || '—'} />
        </View>

        {/*
          * ITEMS — gone once the order is accepted. See showWorkingCards.
          */}
        {showWorkingCards ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Items ({order.item_count})</Text>
          {order.items.map((item) => {
            const isAdjusted = item.defective_quantity > 0;
            /*
             * MARK DEFECTIVE IS GATED ON THE COUNT BEING SAVED.
             *
             * Disabled until this line's cloth counts have been written, so a
             * defect is never recorded against a line whose pile has not been
             * counted — the defect comes off the white or colour figure, and
             * there has to be a figure for it to come off.
             *
             * Read from what was SAVED rather than from what is typed, and
             * per line: the boxes are hydrated from the stored record on every
             * load, so this survives leaving the screen and coming back, and
             * one line being counted says nothing about any other.
             */
            const savedBoxes = savedClothCounts[item.id];
            const clothCountsSaved = Boolean(
              savedBoxes && (savedBoxes.white !== '' || savedBoxes.color !== '')
            );
            /*
             * THE THREE COUNTS MUST ACCOUNT FOR THE WHOLE LINE.
             *
             * Save is offered only when White + Color + Socked comes to
             * exactly this item's quantity. Short means pieces are still
             * unaccounted for; over means more were counted than the line
             * holds. Neither is a count worth recording, so neither can be
             * saved.
             *
             * PER LINE. Each item is checked against its own quantity, so one
             * line balancing says nothing about any other.
             */
            const clothCountTotal = clothCountTotalOf(clothCounts[item.id]);
            /*
             * CHECKED AGAINST `original_quantity`, NOT `quantity`.
             *
             * The boxes hold the count as counted off the pile, and the pile
             * is the whole line — defective pieces included, because a torn
             * sheet was still counted before it was found torn.
             * `item.quantity` is the BILLABLE figure, already reduced by the
             * defect, so checking against it would demand the counts fall
             * short by exactly the number of defective pieces and would
             * refuse to save an honest count.
             *
             * The two are equal on any line with no defect, so this is the
             * same rule as before wherever nothing has been marked.
             */
            const clothCountBalances =
              clothCountTotal === item.original_quantity &&
              clothCountsWithinSocked(clothCounts[item.id]);
            const canSaveClothCounts =
              clothCountBalances &&
              // Unchanged since the last save means there is nothing to save,
              // which is the existing rule and still applies.
              !sameBoxes(clothCounts[item.id], savedClothCounts[item.id]) &&
              clothCountBusyId === null;
            return (
              <View key={item.id} style={styles.itemBlock}>
                <View style={styles.itemRow}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.itemName}>{item.item_name}</Text>
                    <Text style={styles.itemMeta}>
                      Service: {item.laundry_service_name || '—'}
                    </Text>
                    <Text style={styles.itemMeta}>
                      {item.category_name || '—'} · {formatWeightKg(item.weight_kg)} each
                    </Text>
                  </View>
                  <View style={styles.itemRight}>
                    <Text style={styles.itemQty}>× {item.quantity}</Text>
                    <Text style={styles.itemWeight}>
                      {formatWeightKg(item.total_weight_kg)}
                    </Text>
                    {/* WHERE THIS LINE STANDS, on its own. This is what makes
                        one item able to lag behind the rest of the order. */}
                    <View
                      style={[
                        styles.itemStatusPill,
                        item.pending_quantity > 0 && styles.itemStatusPending,
                        item.item_status === 'READY' && styles.itemStatusReady,
                      ]}
                    >
                      <Text
                        style={[
                          styles.itemStatusText,
                          item.pending_quantity > 0 && styles.itemStatusTextPending,
                          item.item_status === 'READY' && styles.itemStatusTextReady,
                        ]}
                      >
                        {item.item_status === 'PARTIALLY_PENDING'
                          ? `${item.delivery_quantity} GOING · ${item.pending_quantity} HELD`
                          : item.item_status}
                      </Text>
                    </View>
                  </View>
                </View>

                {/* THE COUNTS FOR THIS LINE. One card per item: each line is
                    counted on its own and saved on its own.

                    Both cards disappear once the order is accepted — see
                    showClothCounts. */}
                {showClothCounts ? (
                <>
                <View style={styles.clothCountBlock}>
                  <Text style={styles.clothCountTitle}>Cloth Count</Text>
                  {CLOTH_COUNT_FIELDS.map((field) => (
                    <View key={field.key} style={styles.clothCountRow}>
                      <Text style={styles.clothCountLabel}>{field.label}</Text>
                      <TextInput
                        style={styles.clothCountInput}
                        value={(clothCounts[item.id] || EMPTY_CLOTH_COUNTS)[field.key]}
                        onChangeText={(next) =>
                          setClothCounts((current) => ({
                            ...current,
                            [item.id]: {
                              ...(current[item.id] || EMPTY_CLOTH_COUNTS),
                              // Digits only: the box is a piece count, so
                              // anything that is not one is dropped as it is
                              // typed rather than left to be read as a
                              // quantity later.
                              [field.key]: next.replace(/[^0-9]/g, ''),
                            },
                          }))
                        }
                        keyboardType="number-pad"
                        placeholder="0"
                        placeholderTextColor={COLORS.TextSecondary}
                        selectTextOnFocus
                        maxLength={4}
                        editable={clothCountBusyId !== item.id}
                        accessibilityLabel={`${field.label} count for ${item.item_name} on order ${order.order_number}`}
                      />
                    </View>
                  ))}

                  {/* NO "after defective pieces" LINE ANY MORE. The boxes
                      above now hold what is left: the defect comes off the
                      count when it is recorded, so subtracting again here
                      would take the same pieces off twice. */}
                </View>

                {/* SOCKED CLOTH FOR THIS LINE. Counted separately from the
                    pile, and saved on the same row by the button below. */}
                <View style={styles.clothCountBlock}>
                  <Text style={styles.clothCountTitle}>Socked Cloth</Text>
                  {SOCKED_FIELDS.map((field) => (
                    <View key={field.key} style={styles.clothCountRow}>
                      <Text style={styles.clothCountLabel}>{field.label}</Text>
                      <TextInput
                        style={styles.clothCountInput}
                        value={(clothCounts[item.id] || EMPTY_CLOTH_COUNTS)[field.key]}
                        onChangeText={(next) =>
                          setClothCounts((current) => ({
                            ...current,
                            [item.id]: {
                              ...(current[item.id] || EMPTY_CLOTH_COUNTS),
                              // Digits only, as in the card above.
                              [field.key]: next.replace(/[^0-9]/g, ''),
                            },
                          }))
                        }
                        keyboardType="number-pad"
                        placeholder="0"
                        placeholderTextColor={COLORS.TextSecondary}
                        selectTextOnFocus
                        maxLength={4}
                        editable={clothCountBusyId !== item.id}
                        accessibilityLabel={`${field.label} count for ${item.item_name} on order ${order.order_number}`}
                      />
                    </View>
                  ))}
                </View>
                </>
                ) : null}

                {/* Held pieces, and the one action that releases them. */}
                {item.pending_quantity > 0 ? (
                  <View style={styles.pendingBox}>
                    <Text style={styles.pendingText}>
                      {item.pending_quantity} of {item.original_quantity} held at Swachham
                      {item.delivery_quantity > 0
                        ? ` · ${item.delivery_quantity} out for delivery`
                        : ''}
                      {item.pending_reason ? ` · ${item.pending_reason}` : ''}
                    </Text>
                    <TouchableOpacity
                      style={[
                        styles.markReadyButton,
                        itemBusyId === item.id && styles.buttonDisabled,
                      ]}
                      onPress={() => setItemReady(item)}
                      disabled={itemBusyId !== null}
                      accessibilityRole="button"
                      accessibilityLabel={`Mark ${item.item_name} completed`}
                    >
                      {itemBusyId === item.id ? (
                        <ActivityIndicator size="small" color={COLORS.Surface} />
                      ) : (
                        <>
                          <Ionicons
                            name="checkmark-circle-outline"
                            size={16}
                            color={COLORS.Surface}
                          />
                          <Text style={styles.markReadyText}>MARK COMPLETED</Text>
                        </>
                      )}
                    </TouchableOpacity>
                  </View>
                ) : null}

                {/* The adjustment, spelled out. Only on a line that has one, so
                    an unadjusted line reads exactly as it always did. */}
                {isAdjusted ? (
                  <View style={styles.adjustBox}>
                    <Text style={styles.adjustText}>
                      Ordered {item.original_quantity} · Defective{' '}
                      <Text style={styles.adjustDefect}>{item.defective_quantity}</Text> ·
                      Final <Text style={styles.adjustFinal}>{item.quantity}</Text>
                    </Text>

                  </View>
                ) : null}

                {/*
                  * SAVE COUNTS SITS ABOVE MARK DEFECTIVE.
                  *
                  * Above, because it now GATES it: the counts are saved first
                  * and the defect is recorded second, so the order of the two
                  * controls is the order the work is done in.
                  *
                  * Unchanged in every other respect: same handler, same
                  * enable rule, and still gone once accepted along with the
                  * boxes it saves.
                  */}
                {showClothCounts ? (
                <TouchableOpacity
                  style={[
                    styles.clothCountSave,
                    !canSaveClothCounts && styles.buttonDisabled,
                  ]}
                  onPress={() => saveClothCounts(item)}
                  disabled={!canSaveClothCounts}
                  accessibilityRole="button"
                  accessibilityLabel={`Save cloth counts for ${item.item_name}`}
                >
                  {clothCountBusyId === item.id ? (
                    <ActivityIndicator size="small" color={COLORS.Surface} />
                  ) : (
                    <Text style={styles.clothCountSaveText}>SAVE COUNTS</Text>
                  )}
                </TouchableOpacity>
                ) : null}

                {defectsLocked ? (
                  /* Accepted: the action is gone, the figure stays. */
                  isAdjusted ? (
                    <View style={styles.markDefectiveButton}>
                      <Ionicons name="lock-closed-outline" size={14} color={COLORS.TextSecondary} />
                      <Text style={[styles.markDefectiveText, { color: COLORS.TextSecondary }]}>
                        DEFECTIVE LOCKED
                      </Text>
                    </View>
                  ) : null
                ) : (
                  <TouchableOpacity
                    style={[
                      styles.markDefectiveButton,
                      !clothCountsSaved && styles.buttonDisabled,
                    ]}
                    onPress={() => setDefectiveFor(item)}
                    disabled={!clothCountsSaved}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !clothCountsSaved }}
                    accessibilityLabel={
                      clothCountsSaved
                        ? `Mark defective pieces for ${item.item_name}`
                        : `Save the cloth counts for ${item.item_name} before marking defective pieces`
                    }
                  >
                    <Ionicons name="alert-circle-outline" size={16} color={COLORS.Error} />
                    <Text style={styles.markDefectiveText}>
                      {isAdjusted ? 'EDIT DEFECTIVE' : 'MARK DEFECTIVE'}
                    </Text>
                  </TouchableOpacity>
                )}

              </View>
            );
          })}

          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Total Weight</Text>
            <Text style={styles.totalValue}>{formatWeightKg(order.total_weight_kg)}</Text>
          </View>
          {/* NO ORDER TOTAL. The Sorter is never sent one — see the note at
              the top of MarkDefectiveModal. Pieces and weight are the shop
              floor's units. */}
          {order.has_pending_items ? (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Pieces</Text>
              <Text style={styles.totalValue}>
                {order.delivery_quantity} out for delivery · {order.pending_quantity} pending
              </Text>
            </View>
          ) : null}
        </View>
        ) : null}

        {/*
          * ---- CLOTH COUNT ---- the card that OUTLIVES acceptance.
          *
          * Before acceptance the counts are edited in their boxes inside the
          * Items card above, beside the line each belongs to. That card is
          * hidden once the order is accepted, but the COUNTS are required to
          * stay on screen — so they reappear here, read-only, as a summary of
          * every line.
          *
          * Rendered only after acceptance, so before it there is exactly one
          * place showing a count and no chance of two disagreeing.
          *
          * The figures are already net of defective pieces: the server
          * subtracts them (see listPendingItemsForOrder), which is what makes
          * "White 20, 3 defective, shows 17" true here without this card
          * doing any arithmetic of its own.
          */}
        {!showWorkingCards && (order.pending_items ?? []).length > 0 ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Cloth Count</Text>

            {order.items.map((item) => {
              const record = (order.pending_items ?? []).find(
                (r) => r.order_item_id === item.id
              );
              // A line nobody counted is skipped rather than shown as zeros:
              // "not counted" and "counted, none" are different facts and the
              // rest of this screen is careful to keep them apart.
              if (!record) return null;

              const show = (value: number | null) => (value === null ? '—' : String(value));

              /*
               * The UPDATED figure — counted less defective. Computed here
               * because the stored count is the original; the same
               * subtraction the boxes show before acceptance, so the number
               * does not change the moment the order is accepted.
               */
              /*
               * The stored figure, shown as it stands.
               *
               * It is ALREADY net of the defective pieces -- they come off the
               * count when the defect is recorded -- so nothing is subtracted
               * here. This used to do that subtraction, and doing it now would
               * take the same pieces off a second time.
               */
              const net = (counted: number | null, _defective: number | null) =>
                counted === null ? '—' : String(counted);

              return (
                <View key={item.id} style={styles.clothSummaryBlock}>
                  <Text style={styles.clothSummaryName}>{item.item_name}</Text>

                  <View style={styles.clothSummaryRow}>
                    <Text style={styles.clothSummaryLabel}>White Cloths</Text>
                    <Text style={styles.clothSummaryValue}>
                      {net(record.white_cloth_count, item.white_defective_quantity)}
                    </Text>
                  </View>
                  <View style={styles.clothSummaryRow}>
                    <Text style={styles.clothSummaryLabel}>Color Cloths</Text>
                    <Text style={styles.clothSummaryValue}>
                      {net(record.color_cloth_count, item.color_defective_quantity)}
                    </Text>
                  </View>
                  <View style={styles.clothSummaryRow}>
                    <Text style={styles.clothSummaryLabel}>White Socked</Text>
                    <Text style={styles.clothSummaryValue}>{show(record.white_socked)}</Text>
                  </View>
                  <View style={styles.clothSummaryRow}>
                    <Text style={styles.clothSummaryLabel}>Color Socked</Text>
                    <Text style={styles.clothSummaryValue}>{show(record.color_socked)}</Text>
                  </View>
                </View>
              );
            })}

            <Text style={styles.defectHint}>
              These counts are final — the order has been accepted. Defective pieces have
              already been taken off.
            </Text>
          </View>
        ) : null}

        {/* ---- DEFECTIVE ADJUSTMENT: history, money position, notify ----

            HIDDEN ONCE THE PIECE HAS BEEN REPORTED WITH A PHOTO.

            The report is the fuller account of the same event: it carries the
            photo, both quantities and the reason, and it has already gone to
            the customer on WhatsApp. Leaving this card up beside it offered a
            SECOND notify button for the same damage, which is how a customer
            ends up told twice about one torn sheet.

            `defects.length` rather than a flag: a defect row exists only
            because someone photographed the piece, which is exactly the
            condition being asked about. */}
        {order.has_adjustment && order.defects.length === 0 ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Defective adjustment</Text>

            {order.adjustments.map((adjustment) => (
              <View key={adjustment.id} style={styles.adjustRow}>
                <Text style={styles.adjustRowTitle}>{adjustment.item_name}</Text>
                <Text style={styles.itemMeta}>
                  {adjustment.original_quantity} ordered · {adjustment.defective_quantity}{' '}
                  defective · {adjustment.final_quantity} final
                </Text>
                {adjustment.previous_defective_quantity > 0 &&
                adjustment.previous_defective_quantity !== adjustment.defective_quantity ? (
                  <Text style={styles.itemMeta}>
                    Corrected from {adjustment.previous_defective_quantity}
                  </Text>
                ) : null}
                {adjustment.reason ? (
                  <Text style={styles.itemMeta}>Reason: {adjustment.reason}</Text>
                ) : null}
                <Text style={styles.adjustMetaFaint}>
                  {adjustment.adjusted_by_name || 'Sorter'} ·{' '}
                  {formatDateTime(adjustment.adjusted_at).date}{' '}
                  {formatDateTime(adjustment.adjusted_at).time}
                </Text>
              </View>
            ))}

            {order.adjustment_notifications.length > 0 ? (
              <Text style={styles.adjustMetaFaint}>
                Last notification:{' '}
                {order.adjustment_notifications[0].status === 'SENT'
                  ? `sent to ${order.adjustment_notifications[0].sent_to || 'the customer'}`
                  : order.adjustment_notifications[0].error || 'not sent'}
              </Text>
            ) : null}

            {/*
              SEND WHATSAPP WAS REMOVED FROM THIS CARD.

              It sent the ADJUSTMENT template, which is empty by default
              (`WHATSAPP_ADJUSTMENT_TEMPLATE`) because no such template is
              approved on the account — so the button reported a send that
              Meta had refused, or fell back to a defect template describing
              something else. It was a button that looked connected and was
              not.

              The defect report is the path that works: it carries the photo,
              both quantities and the reason, and it goes to the customer and
              the sorting desk. Nothing is lost by removing this.
            */}
          </View>
        ) : null}

        {/* Garment verification. The counts come from the server, and the
            forward action stays locked until it reports a match — the server
            re-checks the same rule when the button is pressed.

            Gone once accepted, with the other working cards. */}
        {showWorkingCards && scan ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Garment verification</Text>
            <Row label="Expected garments" value={String(scan.expected_count)} />
            <Row
              label="Acceptance scanned"
              value={`${scan.acceptance_scanned} / ${scan.expected_count}`}
            />
            <Row
              label="Delivery scanned"
              value={`${scan.delivery_scanned} / ${scan.expected_count}`}
            />

            {scanStage && scanMatched ? (
              <View style={styles.matchBanner}>
                <Ionicons name="checkmark-circle" size={20} color={COLORS.Surface} />
                <Text style={styles.matchText}>
                  ✓ QUANTITY MATCH — all garments{' '}
                  {scanStage === 'acceptance' ? 'scanned' : 'verified for delivery'}.
                </Text>
              </View>
            ) : null}

            {scanStage && !scanMatched ? (
              <Text style={styles.mismatchText}>
                {scanRemaining} garment{scanRemaining === 1 ? '' : 's'} not yet scanned.
                Scanning is optional — you can continue without it.
              </Text>
            ) : null}

            {scanStage ? (
              <TouchableOpacity
                style={styles.scanButton}
                onPress={() =>
                  navigation.navigate('SorterScanScreen', { orderId, stage: scanStage })
                }
                activeOpacity={0.85}
              >
                <Ionicons name="barcode-outline" size={22} color={COLORS.Surface} />
                <Text style={styles.scanButtonText}>
                  {scanStage === 'acceptance'
                    ? 'SCAN BARCODE (OPTIONAL)'
                    : 'DELIVERY VERIFICATION (OPTIONAL)'}
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}

        {/* ---- Defective piece ---- Gone once accepted. The RECORD of what
             was adjusted lives in the Defective adjustment card above, which
             deliberately stays. */}
        {showWorkingCards ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>DEFECTIVE PIECE</Text>

          {order.defects && order.defects.length > 0 ? (
            order.defects.map((defect) => {
              const reported = formatDateTime(defect.reported_at);
              // Retry stays available until every copy that HAS a recipient
              // is accepted. A copy with nobody to send to is not a failure
              // and no retry can change it — see defectCopies.
              const copies = defectCopies(defect);
              const allSent = defectFullyDelivered(defect);
              return (
                <View key={defect.id} style={styles.defectItem}>
                  <View style={styles.defectHeaderRow}>
                    <Ionicons name="warning" size={18} color={COLORS.Error} />
                    <Text style={styles.defectHeaderText}>Defect Reported</Text>
                  </View>

                  <Image
                    // Stored as a server-relative URL, so it is resolved
                    // against the same base the API client uses.
                    source={{ uri: `${API_BASE_URL}${defect.photo_url}` }}
                    style={styles.defectPhoto}
                    resizeMode="cover"
                  />

                  <Text style={styles.defectMeta}>
                    {reported.date} {reported.time}
                    {defect.defective_quantity
                      ? ` · ${defect.defective_quantity} piece(s) defective`
                      : ''}
                  </Text>
                  {defect.description ? (
                    <Text style={styles.defectMeta}>Reason: {defect.description}</Text>
                  ) : null}

                  {/* Every copy is reported separately: one failing says
                      nothing about the others. */}
                  {copies.map((copy) => {
                    const ok = copy.status === 'SENT';
                    // No recipient at all — neither sent nor failed, and
                    // shown as the plain fact it is rather than an alarm.
                    const absent = copy.status === null;
                    const color = ok
                      ? COLORS.Success
                      : absent
                      ? COLORS.TextSecondary
                      : COLORS.Error;
                    return (
                      <View key={copy.role}>
                        <View style={styles.defectStatusRow}>
                          <Ionicons
                            name={
                              ok
                                ? 'checkmark-circle'
                                : absent
                                ? 'remove-circle-outline'
                                : 'alert-circle'
                            }
                            size={18}
                            color={color}
                          />
                          <Text style={[styles.defectStatusText, { color }]}>
                            {copy.label} WhatsApp:{' '}
                            {ok ? 'Sent' : absent ? 'No recipient' : 'Failed to send'}
                          </Text>
                        </View>
                        {!ok && copy.error ? (
                          <Text style={styles.defectError}>{copy.error}</Text>
                        ) : null}
                      </View>
                    );
                  })}

                  {!allSent ? (
                    <TouchableOpacity
                      style={[
                        styles.retryButtonSmall,
                        retryingDefectId === defect.id && styles.buttonDisabled,
                      ]}
                      onPress={() => retryDefectWhatsApp(defect)}
                      disabled={retryingDefectId === defect.id}
                      activeOpacity={0.85}
                    >
                      {retryingDefectId === defect.id ? (
                        <ActivityIndicator size="small" color={COLORS.Surface} />
                      ) : (
                        <>
                          <Ionicons name="refresh" size={18} color={COLORS.Surface} />
                          <Text style={styles.retryButtonSmallText}>RETRY WHATSAPP</Text>
                        </>
                      )}
                    </TouchableOpacity>
                  ) : null}
                </View>
              );
            })
          ) : (
            <Text style={styles.defectEmpty}>No defect reported for this order.</Text>
          )}

          {/* NO BUTTON HERE ANY MORE. Reporting a defective piece starts from
              MARK DEFECTIVE on the item it concerns, so the report always
              knows which line, how many pieces and why — the things a
              standalone camera button could never supply. */}
          <Text style={styles.defectHint}>
            {defectsLocked
              ? 'This order has been accepted, so its defective pieces are locked.'
              : 'To report a defective piece, use MARK DEFECTIVE on the item above.'}
          </Text>
        </View>
        ) : null}

        {/*
          * AVAILABLE AT EVERY STAGE, acceptance included.
          *
          * This was hidden after acceptance only because the server stopped
          * sending `order.pending_items` then, which would have produced a
          * document of empty rows. The counts travel at every stage again, so
          * the button has real data to print and there is no reason to
          * withhold the document — a socked count is as worth reading after
          * acceptance as before it.
          */}
        <TouchableOpacity
          style={[styles.secondaryButton, isBuildingSockedPdf && styles.buttonDisabled]}
          onPress={handleSockedDetailsPdf}
          disabled={isBuildingSockedPdf}
          activeOpacity={0.85}
        >
          {isBuildingSockedPdf ? (
            <ActivityIndicator size="small" color={COLORS.Primary} />
          ) : (
            <>
              <Ionicons name="document-text-outline" size={20} color={COLORS.Primary} />
              <Text style={styles.secondaryButtonText}>SOCKED DETAILS PDF</Text>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.secondaryButton, isBuildingPdf && styles.buttonDisabled]}
          onPress={handleViewPdf}
          disabled={isBuildingPdf}
          activeOpacity={0.85}
        >
          {isBuildingPdf ? (
            <ActivityIndicator size="small" color={COLORS.Primary} />
          ) : (
            <>
              <Ionicons name="document-text-outline" size={20} color={COLORS.Primary} />
              <Text style={styles.secondaryButtonText}>VIEW CONFIRMATION PDF</Text>
            </>
          )}
        </TouchableOpacity>

        {action ? (
          <TouchableOpacity
            style={[styles.primaryButton, (isUpdating || actionBlocked) && styles.buttonDisabled]}
            onPress={handleAdvance}
            disabled={isUpdating || actionBlocked}
            activeOpacity={0.85}
          >
            {isUpdating ? (
              <ActivityIndicator size="small" color={COLORS.Surface} />
            ) : (
              <>
                <Ionicons name="arrow-forward-circle-outline" size={22} color={COLORS.Surface} />
                <Text style={styles.primaryButtonText}>{action.label}</Text>
              </>
            )}
          </TouchableOpacity>
        ) : (
          // Ready is the end of the Sorter's responsibility; delivery belongs
          // to the existing pipeline, so no further action is offered here.
          <View style={styles.doneBox}>
            <Ionicons name="checkmark-circle" size={22} color={COLORS.Success} />
            <Text style={styles.doneText}>
              This order is ready. Delivery is handled by the existing workflow.
            </Text>
          </View>
        )}
      </ScrollView>

      {/* The form is a controlled sheet over this screen rather than a route,
          so the order stays on screen behind it and no navigation state is
          involved in what is a single field and a save. */}
      <MarkDefectiveModal
        visible={defectiveFor !== null}
        item={defectiveFor}
        orderNumber={order.order_number}
        saving={savingAdjustment}
        onCancel={() => setDefectiveFor(null)}
        onReportPiece={reportDefectivePiece}
        /*
         * The cloth counted on the line being adjusted, so each box knows its
         * own ceiling. These are the counts AS COUNTED, so they are the
         * ceiling directly and a recorded defect can still be corrected
         * upwards without any adding back.
         *
         * NULL when the line has not been counted — the modal then enforces
         * no per-colour ceiling, exactly as the server does.
         */
        availableWhite={countsForDefectiveLine.white}
        availableColour={countsForDefectiveLine.colour}
      />

      {/* Which items are pending, asked only after the Sorter says some are. */}
      <PendingItemsModal
        visible={pendingPrompt}
        items={order.items}
        orderNumber={order.order_number}
        saving={isUpdating}
        onCancel={() => setPendingPrompt(false)}
        onSave={finishWithPending}
      />
    </SafeAreaView>
  );
}

/**
 * Adapts the Sorter payload to the shape the shared PDF template reads, so the
 * document the Sorter opens is the same one the Business app produces. Neither
 * shape carries amounts: a business order's price is an internal figure used
 * to raise the invoice, and no operational document prints it.
 */
function toPdfShape(order: SorterOrderDetail): BusinessOrderDetail {
  return {
    id: order.id,
    order_number: order.order_number,
    laundry_type: order.laundry_type,
    order_type: order.order_type,
    service_type: null,
    service_name: null,
    status: order.status,
    item_count: order.item_count,
    total_quantity: order.total_quantity,
    total_weight_kg: order.total_weight_kg,
    created_at: order.created_at,
    business_name: order.customer_name,
    // Nothing to carry: the Sorter payload has no contact person, and the
    // document's "Placed By" now reads placed_by_mobile directly rather than
    // this field.
    contact_person_name: null,
    // The PDF states the number the order was PLACED on, not the number the
    // shop floor calls -- so it is placed_by_mobile, and never the account's.
    placed_by_mobile: order.placed_by_mobile,
    // Drives whether the document splits Qty into Ordered / Defective / Final.
    has_adjustment: order.has_adjustment,
    // Drives the Status column, so a pending item is never printed as ready.
    has_pending_items: order.has_pending_items,
    business_email: null,
    business_address: null,
    items: order.items.map((item) => ({
      id: item.id,
      service_id: null,
      service_name: item.item_name,
      laundry_service_name: item.laundry_service_name,
      category_id: null,
      category_name: item.category_name,
      image_url: null,
      quantity: item.quantity,
      original_quantity: item.original_quantity,
      defective_quantity: item.defective_quantity,
      item_status: item.item_status,
      pending_quantity: item.pending_quantity,
      delivery_quantity: item.delivery_quantity,
      pending_reason: item.pending_reason,
      unit: item.unit,
      weight_kg: item.weight_kg,
      total_weight_kg: item.total_weight_kg,
    })),
  };
}

function Header({ onBack }: { onBack: () => void }) {
  return (
    <View style={styles.header}>
      <TouchableOpacity style={styles.backButton} onPress={onBack} accessibilityLabel="Back">
        <Ionicons name="arrow-back" size={22} color={COLORS.TextPrimary} />
      </TouchableOpacity>
      <Text style={styles.headerTitle}>Order Details</Text>
    </View>
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
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.Background,
  },
  headerTitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: 'bold',
    color: COLORS.TextPrimary,
  },

  headlineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.sm,
    marginBottom: SPACING.md,
  },
  orderNumber: {
    flex: 1,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xxl,
    fontWeight: '800',
    color: COLORS.PrimaryDark,
  },
  statusPill: { borderRadius: BORDER_RADIUS.full, paddingHorizontal: SPACING.md, paddingVertical: 6 },
  statusText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: 12,
    fontWeight: '800',
    color: COLORS.Surface,
    letterSpacing: 0.5,
  },

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
    marginBottom: SPACING.xs,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: SPACING.md, paddingVertical: 5 },
  rowLabel: { fontFamily: TYPOGRAPHY.fontFamily, fontSize: TYPOGRAPHY.sizes.sm, color: COLORS.TextSecondary },
  rowValue: {
    flex: 1,
    textAlign: 'right',
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '600',
    color: COLORS.TextPrimary,
  },

  clothCountBlock: {
    marginTop: SPACING.sm,
    paddingTop: SPACING.sm,
    borderTopWidth: 1,
    borderTopColor: COLORS.Border,
  },

  // ---- "After defective pieces": the visible subtraction under the boxes ----

  // ---- the read-only Cloth Count card shown after acceptance ----
  //
  // Deliberately NOT the input styles above: nothing here is editable, so
  // nothing here is drawn as a box that invites a tap.
  clothSummaryBlock: {
    marginTop: SPACING.sm,
    paddingTop: SPACING.sm,
    borderTopWidth: 1,
    borderTopColor: COLORS.Border,
  },
  clothSummaryName: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '700',
    color: COLORS.TextPrimary,
    marginBottom: SPACING.xs,
  },
  clothSummaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 3,
  },
  clothSummaryLabel: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
  },
  clothSummaryValue: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '700',
    color: COLORS.TextPrimary,
  },
  clothCountTitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '700',
    color: COLORS.TextPrimary,
    marginBottom: 2,
  },
  clothCountSave: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 40,
    marginTop: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Primary,
  },
  clothCountSaveText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '800',
    color: COLORS.Surface,
    letterSpacing: 0.5,
  },
  clothCountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.md,
    paddingVertical: 5,
  },
  clothCountLabel: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
  },
  clothCountInput: {
    minWidth: 76,
    textAlign: 'right',
    borderWidth: 1,
    borderColor: COLORS.Border,
    borderRadius: BORDER_RADIUS.sm,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '700',
    color: COLORS.TextPrimary,
    backgroundColor: COLORS.Surface,
  },

  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: SPACING.sm,
    borderTopWidth: 1,
    borderTopColor: COLORS.Border,
  },
  itemName: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '700',
    color: COLORS.TextPrimary,
  },
  itemMeta: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
    marginTop: 2,
  },
  itemRight: { alignItems: 'flex-end' },
  itemQty: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: '800',
    color: COLORS.PrimaryDark,
  },
  itemWeight: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
  },

  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: SPACING.sm,
    paddingTop: SPACING.sm,
    borderTopWidth: 2,
    borderTopColor: COLORS.Border,
  },
  totalLabel: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: 'bold',
    color: COLORS.TextPrimary,
  },
  totalValue: {
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
    height: 60,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Primary,
    ...SHADOWS.medium,
  },
  primaryButtonText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: '800',
    color: COLORS.Surface,
    letterSpacing: 0.5,
  },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    height: 56,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Surface,
    borderWidth: 2,
    borderColor: COLORS.Primary,
    marginBottom: SPACING.md,
  },
  secondaryButtonText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '800',
    color: COLORS.Primary,
    letterSpacing: 0.5,
  },
  // ---- Defective piece ----
  /* ---- Pending items / partial completion ---- */
  itemStatusPill: {
    marginTop: 4,
    paddingHorizontal: SPACING.xs,
    paddingVertical: 2,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: COLORS.Background,
  },
  itemStatusPending: { backgroundColor: '#FFF4E5' },
  itemStatusReady: { backgroundColor: '#E6F4EC' },
  itemStatusText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.4,
    color: COLORS.TextSecondary,
  },
  itemStatusTextPending: { color: '#8A5200' },
  itemStatusTextReady: { color: '#1B4332' },
  pendingBox: {
    backgroundColor: '#FFF9F0',
    borderRadius: BORDER_RADIUS.sm,
    padding: SPACING.sm,
    marginTop: SPACING.xs,
    gap: SPACING.xs,
  },
  pendingText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: '#8A5200',
    lineHeight: 18,
  },
  markReadyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.xs,
    backgroundColor: COLORS.Success,
    borderRadius: BORDER_RADIUS.sm,
    paddingVertical: SPACING.xs,
  },
  markReadyText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: COLORS.Surface,
  },

  /* ---- Defective piece adjustment ---- */
  itemBlock: { borderBottomWidth: 1, borderBottomColor: COLORS.Border, paddingBottom: SPACING.sm },
  itemAmount: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '700',
    color: COLORS.TextPrimary,
    marginTop: 2,
  },
  adjustBox: {
    backgroundColor: '#FDF2F2',
    borderRadius: BORDER_RADIUS.sm,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    marginTop: SPACING.xs,
  },
  adjustText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary,
  },
  adjustDefect: { color: COLORS.Error, fontWeight: '700' },
  adjustFinal: { color: COLORS.TextPrimary, fontWeight: '700' },
  adjustAmount: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    fontWeight: '700',
    color: COLORS.TextPrimary,
    marginTop: 2,
  },
  markDefectiveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.xs,
    borderWidth: 1,
    borderColor: COLORS.Error,
    borderRadius: BORDER_RADIUS.sm,
    paddingVertical: SPACING.xs,
    marginTop: SPACING.sm,
  },
  markDefectiveText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: COLORS.Error,
  },
  adjustRow: {
    borderBottomWidth: 1,
    borderBottomColor: COLORS.Border,
    paddingVertical: SPACING.sm,
  },
  adjustRowTitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '700',
    color: COLORS.TextPrimary,
  },
  adjustMetaFaint: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary,
    marginTop: SPACING.xs,
  },
  totalStruck: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
    textDecorationLine: 'line-through',
  },
  paymentNote: {
    backgroundColor: COLORS.Background,
    borderRadius: BORDER_RADIUS.sm,
    padding: SPACING.sm,
    marginTop: SPACING.sm,
  },
  paymentNoteWarn: { backgroundColor: '#FFF7E6' },
  paymentNoteText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextPrimary,
    lineHeight: 18,
  },

  defectItem: {
    borderTopWidth: 1,
    borderTopColor: COLORS.Border,
    paddingTop: SPACING.sm,
    marginTop: SPACING.sm,
    gap: SPACING.xs,
  },
  defectHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  defectHeaderText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: 'bold',
    color: COLORS.Error,
  },
  defectPhoto: {
    width: '100%',
    height: 180,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: COLORS.Background,
  },
  defectMeta: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
  },
  defectStatusRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  defectStatusText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '700',
  },
  defectError: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.Error,
  },
  defectEmpty: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
    marginTop: SPACING.xs,
  },
  defectHint: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
    marginTop: SPACING.md,
  },
  retryButtonSmall: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.xs,
    minHeight: 46,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: COLORS.Error,
    marginTop: SPACING.xs,
  },
  retryButtonSmallText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: 'bold',
    color: COLORS.Surface,
  },
  // Large: this is a primary shop-floor action.
  defectButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    minHeight: 58,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Error,
    marginTop: SPACING.md,
  },
  defectButtonText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: 'bold',
    color: COLORS.Surface,
    letterSpacing: 0.5,
  },

  buttonDisabled: { opacity: 0.6 },

  matchBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    backgroundColor: COLORS.Success,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.sm,
    marginTop: SPACING.sm,
  },
  matchText: {
    flex: 1,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '700',
    color: COLORS.Surface,
  },
  mismatchText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '600',
    color: COLORS.Warning,
    marginTop: SPACING.sm,
  },
  scanButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    height: 56,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.PrimaryDark,
    marginTop: SPACING.md,
    ...SHADOWS.light,
  },
  scanButtonText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '800',
    color: COLORS.Surface,
    letterSpacing: 0.5,
  },

  doneBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    backgroundColor: COLORS.Accent + '30',
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
  },
  doneText: {
    flex: 1,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.PrimaryDark,
    fontWeight: '600',
  },

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
