import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS } from '../../constants/theme';
import {
  LEGAL_DOCUMENTS,
  LegalBlock,
  LegalDocument,
  LegalDocumentKey,
} from '../../constants/legalContent';

/**
 * Renders one legal document — the Privacy Policy or the Terms & Conditions.
 *
 * ONE SCREEN, NOT TWO. Both documents have the same shape and the same
 * reading needs, so they share a renderer and a route; which one to show is a
 * parameter. That also keeps them out of a second navigation stack: the
 * screen is registered once per section that links to it.
 *
 * The text itself lives in `constants/legalContent`, transcribed from
 * Swachham's source document. Nothing on this screen writes, shortens or
 * rewords it — the renderer only decides how it looks.
 */

interface Params {
  /** Which document to render. Defaults to the Privacy Policy. */
  document?: LegalDocumentKey;
}

export default function LegalDocumentScreen({ navigation, route }: any) {
  const key: LegalDocumentKey = (route?.params as Params)?.document ?? 'privacy';
  const doc: LegalDocument = LEGAL_DOCUMENTS[key] ?? LEGAL_DOCUMENTS.privacy;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={22} color={COLORS.PrimaryDark} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {doc.title}
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator
        /* Long documents are read, not skimmed: keep the scroll indicator so
           length is obvious, and allow text selection for copying a clause. */
      >
        {doc.lastUpdated ? (
          <Text style={styles.updated}>Last updated: {doc.lastUpdated}</Text>
        ) : null}

        {doc.blocks.length === 0 ? (
          /* An honest empty state. Showing invented text here would be worse
             than showing nothing: a placeholder policy reads as a real one. */
          <View style={styles.emptyCard}>
            <Ionicons name="document-text-outline" size={32} color={COLORS.TextSecondary} />
            <Text style={styles.emptyTitle}>{doc.title} is not available yet</Text>
            <Text style={styles.emptyBody}>
              This document has not been published in the app yet. Please contact Swachham
              support if you need a copy.
            </Text>
          </View>
        ) : (
          doc.blocks.map((block, index) => <Block key={index} block={block} />)
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

/** One block of the document, laid out according to its kind. */
function Block({ block }: { block: LegalBlock }) {
  switch (block.type) {
    case 'heading':
      return <Text style={styles.heading} selectable>{block.text}</Text>;

    case 'subheading':
      return <Text style={styles.subheading} selectable>{block.text}</Text>;

    case 'paragraph':
      return <Text style={styles.paragraph} selectable>{block.text}</Text>;

    case 'bullet':
      return (
        <View style={styles.listRow}>
          <Text style={styles.bulletMark}>{'•'}</Text>
          <Text style={styles.listText} selectable>{block.text}</Text>
        </View>
      );

    default:
      return null;
  }
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
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.Background,
  },
  headerTitle: {
    flex: 1,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: 'bold',
    color: COLORS.PrimaryDark,
  },

  /* Generous bottom padding so the last clause clears the tab bar. */
  content: { padding: SPACING.md, paddingBottom: SPACING.xxl },

  updated: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary,
    marginBottom: SPACING.md,
  },

  heading: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '800',
    color: COLORS.PrimaryDark,
    marginTop: SPACING.lg,
    marginBottom: SPACING.xs,
  },
  subheading: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    fontWeight: '700',
    color: COLORS.TextPrimary,
    marginTop: SPACING.md,
    marginBottom: SPACING.xs,
  },
  /* 22px leading on 14px text: long legal paragraphs are much easier to
     track across on a narrow screen with the extra line spacing. */
  paragraph: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    lineHeight: 22,
    color: COLORS.TextPrimary,
    marginBottom: SPACING.sm,
  },

  listRow: {
    flexDirection: 'row',
    gap: SPACING.sm,
    marginBottom: SPACING.xs,
    paddingLeft: SPACING.xs,
  },
  bulletMark: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    lineHeight: 22,
    color: COLORS.Primary,
  },
  listText: {
    flex: 1,
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    lineHeight: 22,
    color: COLORS.TextPrimary,
  },

  emptyCard: {
    alignItems: 'center',
    gap: SPACING.sm,
    padding: SPACING.lg,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: 1,
    borderColor: COLORS.Border,
    backgroundColor: COLORS.Surface,
    marginTop: SPACING.lg,
  },
  emptyTitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '700',
    color: COLORS.TextPrimary,
    textAlign: 'center',
  },
  emptyBody: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    lineHeight: 20,
    color: COLORS.TextSecondary,
    textAlign: 'center',
  },
});
