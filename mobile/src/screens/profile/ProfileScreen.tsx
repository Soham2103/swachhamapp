import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS, SHADOWS } from '../../constants/theme';
import { useAuthStore } from '../../store/authStore';

const menuItems = [
  { id: 'profile', icon: 'person-outline', title: 'User Profile', subtitle: 'Manage your details' },
  { id: 'addresses', icon: 'location-outline', title: 'Addresses', subtitle: 'Manage your saved pickup and delivery addresses' },
  { id: 'orders', icon: 'bag-outline', title: 'Your Orders', subtitle: 'View your current and past orders' },
  { id: 'privacy', icon: 'shield-checkmark-outline', title: 'Privacy Policy', subtitle: 'Privacy Policy' },
  { id: 'express', icon: 'rocket-outline', title: 'Know About Express Service', subtitle: 'Express Service' },
  { id: 'terms', icon: 'document-text-outline', title: 'Terms & Conditions', subtitle: 'Term & Condition' },
  { id: 'faq', icon: 'help-circle-outline', title: 'FAQ', subtitle: 'Find answers to common questions and support' },
  { id: 'delete', icon: 'trash-outline', title: 'Delete account', subtitle: 'Request permanent removal of your account', isDestructive: true },
];

export default function ProfileScreen({ navigation }: any) {
  const { user, logout } = useAuthStore();

  const handleMenuPress = (id: string) => {
    switch (id) {
      case 'profile':
        navigation.navigate('EditProfile');
        break;
      case 'addresses':
        navigation.navigate('AddressList');
        break;
      case 'orders':
        navigation.navigate('Orders');
        break;
      // Both legal documents are one screen; the id says which to render.
      case 'privacy':
        navigation.navigate('LegalDocument', { document: 'privacy' });
        break;
      case 'terms':
        navigation.navigate('LegalDocument', { document: 'terms' });
        break;
      case 'delete':
        Alert.alert('Delete Account', 'Are you sure you want to delete your account?', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: () => console.log('Delete account') },
        ]);
        break;
      default:
        console.log('Navigate to', id);
    }
  };

  const handleLogout = () => {
    Alert.alert('Logout', 'Are you sure you want to logout?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Logout', style: 'destructive', onPress: logout },
    ]);
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{user?.name || 'User'}</Text>
        <Text style={styles.headerSubtitle}>{user?.mobile || 'Not added'}</Text>
        {user?.email ? (
          <Text style={styles.headerSubtitle}>{user.email}</Text>
        ) : null}
      </View>
      
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        <Text style={styles.sectionTitle}>Your Information</Text>
        
        <View style={styles.menuContainer}>
          {menuItems.map((item, index) => (
            <TouchableOpacity 
              key={item.id} 
              style={[
                styles.menuItem,
                index === menuItems.length - 1 && styles.lastMenuItem
              ]}
              onPress={() => handleMenuPress(item.id)}
            >
              <View style={styles.menuIconContainer}>
                <Ionicons 
                  name={item.icon as any} 
                  size={24} 
                  color={item.isDestructive ? COLORS.Error : COLORS.TextPrimary} 
                />
              </View>
              <View style={styles.menuTextContainer}>
                <Text style={[styles.menuTitle, item.isDestructive && styles.destructiveText]}>
                  {item.title}
                </Text>
                {item.subtitle && (
                  <Text style={styles.menuSubtitle}>{item.subtitle}</Text>
                )}
              </View>
              <MaterialIcons name="chevron-right" size={24} color={COLORS.TextSecondary} />
            </TouchableOpacity>
          ))}
        </View>

        <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
          <Text style={styles.logoutText}>Logout</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.Background,
  },
  header: {
    backgroundColor: COLORS.Primary,
    padding: SPACING.xl,
    paddingTop: SPACING.xxl,
    borderBottomLeftRadius: BORDER_RADIUS.xl,
    borderBottomRightRadius: BORDER_RADIUS.xl,
  },
  headerTitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xxl,
    fontWeight: 'bold',
    color: COLORS.Surface,
    marginBottom: SPACING.xs,
  },
  headerSubtitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.sm,
    color: COLORS.Surface,
    opacity: 0.9,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: SPACING.lg,
  },
  sectionTitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.lg,
    fontWeight: 'bold',
    color: COLORS.PrimaryDark,
    marginBottom: SPACING.md,
  },
  menuContainer: {
    backgroundColor: COLORS.Surface,
    borderRadius: BORDER_RADIUS.lg,
    ...SHADOWS.light,
    marginBottom: SPACING.xl,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.Border,
  },
  lastMenuItem: {
    borderBottomWidth: 0,
  },
  menuIconContainer: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: COLORS.Background,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: SPACING.md,
  },
  menuTextContainer: {
    flex: 1,
  },
  menuTitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: '500',
    color: COLORS.TextPrimary,
    marginBottom: 2,
  },
  menuSubtitle: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.xs,
    color: COLORS.TextSecondary,
  },
  destructiveText: {
    color: COLORS.Error,
  },
  logoutButton: {
    padding: SPACING.md,
    alignItems: 'center',
    marginBottom: SPACING.xl,
  },
  logoutText: {
    fontFamily: TYPOGRAPHY.fontFamily,
    fontSize: TYPOGRAPHY.sizes.base,
    fontWeight: 'bold',
    color: COLORS.Error,
  },
});
