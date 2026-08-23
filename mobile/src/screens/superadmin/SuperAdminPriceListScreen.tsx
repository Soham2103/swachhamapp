import React from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, BORDER_RADIUS, TYPOGRAPHY } from '../../constants/theme';
import { sa } from './styles';

/**
 * Price List — the fork between the two price lists.
 *
 * They are separate screens because they are separate things: the
 * customer list is one global price per item, the business list is a
 * different price per business. Putting them behind one tab would
 * suggest editing one affects the other, which it never does.
 */
export default function SuperAdminPriceListScreen({ navigation }: any) {
  return (
    <SafeAreaView style={sa.container} edges={['top']}>
      <View style={sa.header}>
        <TouchableOpacity
          style={sa.iconBtn}
          onPress={() => navigation.goBack()}
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={22} color={COLORS.TextPrimary} />
        </TouchableOpacity>
        <Text style={sa.headerTitle}>Price List</Text>
      </View>

      <ScrollView contentContainerStyle={sa.scroll}>
        <Option
          icon="people-outline"
          title="Customer Price List"
          subtitle="Same prices for all customers"
          onPress={() => navigation.navigate('SuperAdminCustomerPrices')}
        />
        <Option
          icon="business-outline"
          title="Business Price List"
          subtitle="Different prices per business"
          onPress={() => navigation.navigate('SuperAdminBusinessPrices')}
        />

        <Text
          style={{
            fontFamily: TYPOGRAPHY.fontFamily,
            fontSize: TYPOGRAPHY.sizes.xs,
            color: COLORS.TextSecondary,
            marginTop: SPACING.md,
            lineHeight: 18,
          }}
        >
          The two lists are independent. Changing a customer price never moves a
          business price, and one business's price never affects another's.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Option({
  icon,
  title,
  subtitle,
  onPress,
}: {
  icon: any;
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[sa.card, { flexDirection: 'row', alignItems: 'center', gap: SPACING.md }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${subtitle}`}
    >
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: BORDER_RADIUS.md,
          backgroundColor: COLORS.Accent,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Ionicons name={icon} size={22} color={COLORS.PrimaryDark} />
      </View>
      <View style={sa.flex}>
        <Text style={sa.cardTitle}>{title}</Text>
        <Text style={sa.cardMeta}>{subtitle}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={COLORS.TextSecondary} />
    </TouchableOpacity>
  );
}
