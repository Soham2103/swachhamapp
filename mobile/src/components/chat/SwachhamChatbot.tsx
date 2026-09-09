import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  FlatList,
  ActivityIndicator,
  Modal,
  Image,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS, SHADOWS } from '../../constants/theme';
import chatApi, { ChatSection } from '../../services/chatApi';

/**
 * Swachham — the in-app assistant.
 *
 * A full-screen modal rather than a screen in the navigator, so opening and
 * closing it never touches the stack underneath: the Select Items page keeps
 * its scroll position, and anything already chosen stays chosen.
 *
 * The conversation lives in this component's state and is kept while the app
 * is running, so closing the chat and reopening it resumes where it left off.
 */

interface Message {
  id: string;
  author: 'user' | 'swachham';
  text: string;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Where the chat was opened from; travels with each question. */
  section?: ChatSection;
}

const FALLBACK_GREETING =
  "Hello! 👋\nI'm Swachham, your laundry assistant.\n\nHow can I help you?";

/** Shown when the assistant cannot be reached at all. */
const OFFLINE_MESSAGE =
  "Sorry, I'm unable to connect right now.\nPlease try again or contact support.";

const FALLBACK_SUGGESTIONS = [
  'How to book pickup?',
  'How to book delivery?',
  'How to place an order?',
  'Check order status',
];

let messageSeq = 0;
const nextId = () => `m${(messageSeq += 1)}`;

export default function SwachhamChatbot({ visible, onClose, section = 'general' }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>(FALLBACK_SUGGESTIONS);
  const [draft, setDraft] = useState('');
  const [isSending, setIsSending] = useState(false);
  /** The question to retry after a failed send. */
  const [failedQuestion, setFailedQuestion] = useState<string | null>(null);

  const listRef = useRef<FlatList<Message>>(null);
  const hasOpened = useRef(false);

  // The greeting and its quick questions come from the server, so the wording
  // can be corrected without a new build. If that call fails the chat still
  // opens — with the same greeting, offline.
  useEffect(() => {
    if (!visible || hasOpened.current) return;
    hasOpened.current = true;

    let active = true;
    chatApi
      .getWelcome()
      .then((response) => {
        if (!active) return;
        setMessages([
          { id: nextId(), author: 'swachham', text: response.data?.greeting || FALLBACK_GREETING },
        ]);
        if (response.data?.suggestions?.length) setSuggestions(response.data.suggestions);
      })
      .catch(() => {
        if (!active) return;
        setMessages([{ id: nextId(), author: 'swachham', text: FALLBACK_GREETING }]);
      });

    return () => {
      active = false;
    };
  }, [visible]);

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  }, []);

  const ask = useCallback(
    async (question: string) => {
      const text = question.trim();
      // One request at a time: a second tap while Swachham is answering is
      // ignored rather than queued.
      if (!text || isSending) return;

      setFailedQuestion(null);
      setMessages((prev) => [...prev, { id: nextId(), author: 'user', text }]);
      setDraft('');
      setIsSending(true);
      scrollToEnd();

      try {
        const response = await chatApi.send(text, section);
        setMessages((prev) => [
          ...prev,
          { id: nextId(), author: 'swachham', text: response.data?.reply || OFFLINE_MESSAGE },
        ]);
        setSuggestions(response.data?.suggestions?.length ? response.data.suggestions : []);
      } catch (error) {
        // A failure is said out loud and left retryable — never a silent drop.
        setMessages((prev) => [...prev, { id: nextId(), author: 'swachham', text: OFFLINE_MESSAGE }]);
        setFailedQuestion(text);
      } finally {
        setIsSending(false);
        scrollToEnd();
      }
    },
    [isSending, scrollToEnd, section]
  );

  const renderMessage = ({ item }: { item: Message }) => {
    const mine = item.author === 'user';
    return (
      <View style={[styles.row, mine ? styles.rowMine : styles.rowTheirs]}>
        {!mine ? (
          <View style={styles.avatar}>
            <Image
              source={require('../../../assets/swachham-logo1.png')}
              style={styles.avatarImage}
              resizeMode="contain"
            />
          </View>
        ) : null}
        <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
          <Text style={[styles.bubbleText, mine && styles.bubbleTextMine]}>{item.text}</Text>
        </View>
      </View>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        {/* Header: the assistant's name and what it is for. */}
        <View style={styles.header}>
          <View style={styles.headerBadge}>
            <Image
              source={require('../../../assets/swachham-logo1.png')}
              style={styles.headerBadgeImage}
              resizeMode="contain"
            />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.headerTitle}>Swachham</Text>
            <Text style={styles.headerSubtitle}>Your laundry assistant</Text>
          </View>
          <TouchableOpacity
            style={styles.closeButton}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close chat"
          >
            <Ionicons name="close" size={24} color={COLORS.TextPrimary} />
          </TouchableOpacity>
        </View>

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
        >
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(item) => item.id}
            renderItem={renderMessage}
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled"
            onContentSizeChange={scrollToEnd}
            ListFooterComponent={
              isSending ? (
                <View style={styles.typingRow}>
                  <ActivityIndicator size="small" color={COLORS.Primary} />
                  <Text style={styles.typingText}>Swachham is typing...</Text>
                </View>
              ) : null
            }
          />

          {/* Retry sits with the failure it belongs to. */}
          {failedQuestion && !isSending ? (
            <TouchableOpacity
              style={styles.retryButton}
              onPress={() => ask(failedQuestion)}
              activeOpacity={0.85}
            >
              <Ionicons name="refresh" size={16} color={COLORS.Surface} />
              <Text style={styles.retryText}>RETRY</Text>
            </TouchableOpacity>
          ) : null}

          {/* Quick questions: tapping one sends it straight away. */}
          {suggestions.length && !isSending ? (
            <View style={styles.suggestionWrap}>
              {suggestions.map((question) => (
                <TouchableOpacity
                  key={question}
                  style={styles.suggestionChip}
                  onPress={() => ask(question)}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                >
                  <Text style={styles.suggestionText}>{question}</Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : null}

          <View style={styles.composer}>
            <TextInput
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              placeholder="Ask Swachham..."
              placeholderTextColor={COLORS.TextSecondary}
              multiline
              maxLength={500}
              onSubmitEditing={() => ask(draft)}
              returnKeyType="send"
              blurOnSubmit={false}
              accessibilityLabel="Message"
            />
            <TouchableOpacity
              style={[styles.sendButton, (!draft.trim() || isSending) && styles.sendButtonDisabled]}
              onPress={() => ask(draft)}
              disabled={!draft.trim() || isSending}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel="Send"
            >
              {isSending ? (
                <ActivityIndicator size="small" color={COLORS.Surface} />
              ) : (
                <Ionicons name="send" size={20} color={COLORS.Surface} />
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.Background },

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
  headerBadge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.Background,
  },
  headerBadgeImage: {
    width: 30,
    height: 30,
    borderWidth: 1,
    borderColor: COLORS.Border,
    borderRadius: BORDER_RADIUS.sm,
  },
  headerTitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: 'bold',
    color: COLORS.PrimaryDark,
  },
  headerSubtitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary,
  },
  closeButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.Background,
  },

  listContent: { padding: SPACING.md, gap: SPACING.sm, paddingBottom: SPACING.md },

  row: { flexDirection: 'row', alignItems: 'flex-end', gap: SPACING.xs, marginBottom: SPACING.sm },
  rowMine: { justifyContent: 'flex-end' },
  rowTheirs: { justifyContent: 'flex-start' },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.Surface,
    borderWidth: 1,
    borderColor: COLORS.Border,
  },
  avatarImage: {
    width: 20,
    height: 20,
    borderWidth: 1,
    borderColor: COLORS.Border,
    borderRadius: BORDER_RADIUS.sm,
  },

  bubble: {
    maxWidth: '82%',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.lg,
  },
  bubbleTheirs: {
    backgroundColor: COLORS.Surface,
    borderWidth: 1,
    borderColor: COLORS.Border,
    borderBottomLeftRadius: BORDER_RADIUS.xs,
  },
  bubbleMine: {
    backgroundColor: COLORS.Primary,
    borderBottomRightRadius: BORDER_RADIUS.xs,
  },
  bubbleText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextPrimary,
    lineHeight: 21,
  },
  bubbleTextMine: { color: COLORS.Surface },

  typingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: SPACING.sm,
  },
  typingText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextSecondary,
    fontStyle: 'italic',
  },

  retryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.xs,
    alignSelf: 'center',
    minHeight: 40,
    paddingHorizontal: SPACING.lg,
    marginBottom: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.Error,
  },
  retryText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    fontWeight: '800',
    color: COLORS.Surface,
    letterSpacing: 0.5,
  },

  suggestionWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.xs,
    paddingHorizontal: SPACING.md,
    paddingBottom: SPACING.sm,
  },
  suggestionChip: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.full,
    backgroundColor: COLORS.Surface,
    borderWidth: 1.5,
    borderColor: COLORS.Primary,
  },
  suggestionText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '600',
    color: COLORS.Primary,
  },

  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: SPACING.sm,
    padding: SPACING.md,
    backgroundColor: COLORS.Surface,
    borderTopWidth: 1,
    borderTopColor: COLORS.Border,
    ...SHADOWS.light,
  },
  input: {
    flex: 1,
    minHeight: 48,
    maxHeight: 120,
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.sm,
    paddingBottom: SPACING.sm,
    borderRadius: BORDER_RADIUS.lg,
    backgroundColor: COLORS.Background,
    borderWidth: 1,
    borderColor: COLORS.Border,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.TextPrimary,
  },
  sendButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.Primary,
  },
  sendButtonDisabled: { opacity: 0.45 },
});
