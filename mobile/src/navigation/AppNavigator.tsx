import React from 'react';

import {
  NavigationContainer,
} from '@react-navigation/native';

import {
  createNativeStackNavigator,
} from '@react-navigation/native-stack';

import {
  createBottomTabNavigator,
} from '@react-navigation/bottom-tabs';

import {
  Ionicons,
} from '@expo/vector-icons';

import {
  useAuthStore,
} from '../store/authStore';

import { DEMO_MODE } from '../demo/demoMode';

import { registerDeviceForPush } from '../services/pushRegistration';

import DemoLoginScreen
  from '../screens/demo/DemoLoginScreen';


// =========================================================
// AUTH / ONBOARDING SCREENS
// =========================================================

import SplashScreen
  from '../screens/auth/SplashScreen';

import PermissionScreen
  from '../screens/auth/PermissionScreen';

import MobileVerificationScreen
  from '../screens/auth/MobileVerificationScreen';

import LoginScreen
  from '../screens/auth/LoginScreen';

import CustomerRegisterScreen
  from '../screens/auth/CustomerRegisterScreen';

import BusinessRegisterScreen
  from '../screens/auth/BusinessRegisterScreen';

import ForgotPasswordScreen
  from '../screens/auth/ForgotPasswordScreen';

import ResetPasswordScreen
  from '../screens/auth/ResetPasswordScreen';


// =========================================================
// MAIN SCREENS
// =========================================================

import ProfileScreen
  from '../screens/profile/ProfileScreen';

import ProfileSetupScreen
  from '../screens/profile/ProfileSetupScreen';

import HomeScreen
  from '../screens/home/HomeScreen';

import CartScreen
  from '../screens/cart/CartScreen';

import CustomerOrdersScreen
  from '../screens/orders/CustomerOrdersScreen';
import CustomerOrderTrackingScreen
  from '../screens/orders/CustomerOrderTrackingScreen';

import CheckoutScreen
  from '../screens/cart/CheckoutScreen';
import OrderPlacedScreen
  from '../screens/cart/OrderPlacedScreen';

import AddressListScreen
  from '../screens/addresses/AddressListScreen';

import AddAddressScreen
  from '../screens/addresses/AddAddressScreen';

import EditAddressScreen
  from '../screens/addresses/EditAddressScreen';

import BusinessListScreen
  from '../screens/business/BusinessListScreen';

import BusinessDetailsScreen
  from '../screens/business/BusinessDetailsScreen';

/*
 * The Business flow opens straight on Select Items. Order Type and Laundry
 * Type are no longer asked for up front — both are chosen in the Cart, and
 * the laundry service belongs to each item, chosen on the Items page.
 */
import BusinessCategoriesScreen
  from '../screens/business/BusinessCategoriesScreen';

import BusinessSubCategoriesScreen
  from '../screens/business/BusinessSubCategoriesScreen';

import BusinessItemsScreen
  from '../screens/business/BusinessItemsScreen';


import BusinessCartScreen
  from '../screens/business/BusinessCartScreen';

import BusinessTimeSlotScreen
  from '../screens/business/BusinessTimeSlotScreen';


import BusinessProfileScreen
  from '../screens/business/BusinessProfileScreen';

import BusinessProfileDetailsScreen
  from '../screens/business/BusinessProfileDetailsScreen';

import StoreLocatorScreen
  from '../screens/business/StoreLocatorScreen';

import BusinessOrdersScreen
  from '../screens/business/BusinessOrdersScreen';

import BusinessOrderDetailsScreen
  from '../screens/business/BusinessOrderDetailsScreen';

import BusinessOrderTrackingScreen
  from '../screens/business/BusinessOrderTrackingScreen';

import BusinessDoorTicketsScreen
  from '../screens/business/BusinessDoorTicketsScreen';


// =========================================================
// SORTER MODULE
//
// Staff-facing. Its own login and stack, gated on the
// SORTER role, so it can never be reached from a customer
// or business session.
// =========================================================

import SorterLoginScreen
  from '../screens/sorter/SorterLoginScreen';

import SorterDashboardScreen
  from '../screens/sorter/SorterDashboardScreen';

import SorterRequestsScreen
  from '../screens/sorter/SorterRequestsScreen';

import SorterOrderDetailsScreen
  from '../screens/sorter/SorterOrderDetailsScreen';
// The one ticket system. The same three screens serve every role; the
// server scopes what each of them sees. See services/ticket.service.ts.
import TicketsScreen from '../screens/tickets/TicketsScreen';
import TicketDetailScreen from '../screens/tickets/TicketDetailScreen';
import CreateTicketScreen from '../screens/tickets/CreateTicketScreen';

import SorterScanScreen
  from '../screens/sorter/SorterScanScreen';

import SorterDefectCaptureScreen
  from '../screens/sorter/SorterDefectCaptureScreen';

// Batch processing — an ADDITIONAL Sorter workflow. The screens above are
// unchanged and keep their own routes.
import SorterBatchProcessingScreen
  from '../screens/sorter/SorterBatchProcessingScreen';

import SorterBatchDistributionScreen
  from '../screens/sorter/SorterBatchDistributionScreen';

import SorterBatchDetailScreen
  from '../screens/sorter/SorterBatchDetailScreen';

import SorterBatchScanScreen
  from '../screens/sorter/SorterBatchScanScreen';


// =========================================================
// RIDER MODULE
//
// Staff-facing, gated on the RIDER role. Riders sign in
// through the same unified OTP + password flow as the other
// staff roles, so there is no separate login screen here.
// =========================================================

import RiderDashboardScreen
  from '../screens/rider/RiderDashboardScreen';

import RiderJobDetailsScreen
  from '../screens/rider/RiderJobDetailsScreen';


// The one bottom bar for both tab sets: Customer and Business.
import LiquidGlassTabBar from '../components/LiquidGlassTabBar';

// The Swachham assistant, opened from the launcher on Select Items.
import SwachhamChatbot from '../components/chat/SwachhamChatbot';
import { useChatStore } from '../store/chatStore';

/* The add-to-cart bag animation. Mounted once, above every screen — see
   CartFlyOverlay for why it lives here rather than on a screen. */
import { CartFlyProvider } from '../components/CartFlyOverlay';

import SignInPasswordScreen from '../screens/auth/SignInPasswordScreen';
import ServiceCategoryScreen from '../screens/home/ServiceCategoryScreen';
/* The CUSTOMER app's own screens. Separate from the shared HomeScreen, which
   the business stack also uses — see CustomerHomeScreen for why. */
import CustomerHomeScreen from '../screens/customer/CustomerHomeScreen';
import CustomerCategoriesScreen from '../screens/customer/CustomerCategoriesScreen';
import CustomerItemsScreen from '../screens/customer/CustomerItemsScreen';
import OrderTypeScreen from '../screens/home/OrderTypeScreen';

// One screen renders both legal documents; which one is a route param, so
// neither section needs a stack of its own for them.
import LegalDocumentScreen from '../screens/legal/LegalDocumentScreen';

// =========================================================
// SUPER ADMIN SCREENS
// =========================================================

import SuperAdminLoginScreen from '../screens/superadmin/SuperAdminLoginScreen';
import SuperAdminDashboardScreen from '../screens/superadmin/SuperAdminDashboardScreen';
import SuperAdminApprovalsScreen from '../screens/superadmin/SuperAdminApprovalsScreen';
import SuperAdminBusinessListScreen from '../screens/superadmin/SuperAdminBusinessListScreen';
import SuperAdminBusinessDetailsScreen from '../screens/superadmin/SuperAdminBusinessDetailsScreen';
import SuperAdminManageBusinessesScreen from '../screens/superadmin/SuperAdminManageBusinessesScreen';
import SuperAdminBusinessAccountScreen from '../screens/superadmin/SuperAdminBusinessAccountScreen';
import SuperAdminEditBusinessScreen from '../screens/superadmin/SuperAdminEditBusinessScreen';
/* SuperAdminCreateBusinessScreen and SuperAdminCreateRiderScreen are gone.
   A Super Admin no longer creates a business or a rider: a Manager raises a
   creation request and the Super Admin approves it, which is
   SuperAdminRequestsScreen below. The routes are removed rather than merely
   unlinked, so `navigate('SuperAdminCreateBusiness')` cannot reach them from
   anywhere -- and the endpoints behind them are gone from the server too. */
import SuperAdminPriceListScreen from '../screens/superadmin/SuperAdminPriceListScreen';
import SuperAdminCustomerPricesScreen from '../screens/superadmin/SuperAdminCustomerPricesScreen';
import SuperAdminBusinessPricesScreen from '../screens/superadmin/SuperAdminBusinessPricesScreen';
import SuperAdminBusinessPriceBrowseScreen from '../screens/superadmin/SuperAdminBusinessPriceBrowseScreen';
import SuperAdminBusinessPricesListScreen from '../screens/superadmin/SuperAdminBusinessPricesListScreen';
/* Purchase and Expense — the two finance modules. */
import SuperAdminPurchaseScreen from '../screens/superadmin/SuperAdminPurchaseScreen';
import SuperAdminPurchaseFormScreen from '../screens/superadmin/SuperAdminPurchaseFormScreen';
import SuperAdminPurchaseDetailScreen from '../screens/superadmin/SuperAdminPurchaseDetailScreen';
import SuperAdminSuppliersScreen from '../screens/superadmin/SuperAdminSuppliersScreen';
import SuperAdminExpenseScreen from '../screens/superadmin/SuperAdminExpenseScreen';
import SuperAdminExpenseFormScreen from '../screens/superadmin/SuperAdminExpenseFormScreen';
import SuperAdminExpenseDetailScreen from '../screens/superadmin/SuperAdminExpenseDetailScreen';
import SuperAdminExpenseCategoriesScreen from '../screens/superadmin/SuperAdminExpenseCategoriesScreen';
/* Reports. */
import SuperAdminReportsScreen from '../screens/superadmin/SuperAdminReportsScreen';
import SuperAdminKgReportHubScreen from '../screens/superadmin/SuperAdminKgReportHubScreen';
import SuperAdminKgReportScreen from '../screens/superadmin/SuperAdminKgReportScreen';
import SuperAdminItemKgReportScreen from '../screens/superadmin/SuperAdminItemKgReportScreen';
import SuperAdminKgPivotReportScreen from '../screens/superadmin/SuperAdminKgPivotReportScreen';
import SuperAdminDayWiseKgReportScreen from '../screens/superadmin/SuperAdminDayWiseKgReportScreen';
import SuperAdminOutstandingReportScreen from '../screens/superadmin/SuperAdminOutstandingReportScreen';
import SuperAdminRequestsScreen from '../screens/superadmin/SuperAdminRequestsScreen';
import SuperAdminManagersScreen from '../screens/superadmin/SuperAdminManagersScreen';

// =========================================================
// MANAGER SCREENS
//
// A Manager proposes; a Super Admin disposes. Nothing in this
// stack can approve anything — the server would refuse it too.
// =========================================================

import ManagerDashboardScreen from '../screens/manager/ManagerDashboardScreen';
import ManagerNewBusinessScreen from '../screens/manager/ManagerNewBusinessScreen';
import ManagerNewStaffScreen from '../screens/manager/ManagerNewStaffScreen';
import ManagerRequestsScreen from '../screens/manager/ManagerRequestsScreen';
import ManagerOrderRequestsScreen
  from '../screens/manager/ManagerOrderRequestsScreen';


// =========================================================
// NAVIGATORS
// =========================================================

const Stack =
  createNativeStackNavigator();

const Tab =
  createBottomTabNavigator();



// =========================================================
// CART STACK
// =========================================================

function CartStack() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
      }}
    >

      <Stack.Screen
        name="CartScreen"
        component={CartScreen}
      />

      <Stack.Screen
        name="CheckoutScreen"
        component={CheckoutScreen}
      />

      {/* The end of the booking flow. Checkout REPLACES onto this rather
          than pushing, so Back cannot return to a checkout for an order that
          has already been placed. It stays inside the Cart tab's stack so
          the tab bar is still there to leave by. */}
      <Stack.Screen
        name="OrderPlaced"
        component={OrderPlacedScreen}
      />

    </Stack.Navigator>
  );
}

/**
 * The Orders tab, as a STACK.
 *
 * It was the bare `CustomerOrdersScreen`, which is why tracking had nowhere
 * to go: with no stack under the tab there was no screen to push an order
 * onto. The list stays the tab's first screen, so the tab itself is
 * unchanged; tracking is pushed on top of it and Back returns to the list.
 */
function CustomerOrdersStack() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
      }}
    >

      <Stack.Screen
        name="CustomerOrdersScreen"
        component={CustomerOrdersScreen}
      />

      <Stack.Screen
        name="CustomerOrderTracking"
        component={CustomerOrderTrackingScreen}
      />

    </Stack.Navigator>
  );
}


// =========================================================
// CUSTOMER TABS
//
// Customer-only screens. Never points at a Business screen.
// =========================================================

const CUSTOMER_TAB_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  Home: 'home-outline',
  Orders: 'list-outline',
  Cart: 'cart-outline',
  Profile: 'person-outline',
};

/**
 * The Home tab's own stack.
 *
 * Select Item and its item list live HERE rather than on the root stack,
 * and that is the whole point: a screen pushed on the root stack covers the
 * tab navigator, so the bottom bar vanishes. Inside the tab's stack it
 * stays put, which is what "visible on all customer pages" requires.
 *
 * Every one of these screens leaves room at the bottom of its scroll for
 * the bar, so nothing is hidden behind it.
 */
function CustomerHomeStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="CustomerHome" component={CustomerHomeScreen} />
      <Stack.Screen name="CustomerCategories" component={CustomerCategoriesScreen} />
      <Stack.Screen name="CustomerItems" component={CustomerItemsScreen} />
    </Stack.Navigator>
  );
}

function MainTab() {
  const isChatOpen = useChatStore((state) => state.isOpen);
  const closeChat = useChatStore((state) => state.close);

  return (
    <>
      <Tab.Navigator
        tabBar={(props) => <LiquidGlassTabBar {...props} />}
        initialRouteName="Home"
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarIcon: ({ color, size }) => (
            <Ionicons
              name={CUSTOMER_TAB_ICONS[route.name] || 'home-outline'}
              size={size}
              color={color}
            />
          ),
          tabBarActiveTintColor: '#2D6A4F',
          tabBarInactiveTintColor: 'gray',
        })}
      >
        {/* The customer's own home, NOT the shared `HomeScreen`: that one
            opens with the Hotel / Guest laundry-type choice, which is a
            business concept and is the "first page" the customer flow no
            longer has. The business stack still uses it, untouched. */}
        <Tab.Screen
          name="Home"
          component={CustomerHomeStack}
        />

        <Tab.Screen
          name="Orders"
          component={CustomerOrdersStack}
        />

        <Tab.Screen
          name="Cart"
          component={CartStack}
        />

        <Tab.Screen
          name="Profile"
          component={ProfileScreen}
        />
      </Tab.Navigator>

      <SwachhamChatbot visible={isChatOpen} onClose={closeChat} section="general" />
    </>
  );
}


// =========================================================
// CUSTOMER STACK
// =========================================================

function CustomerStack() {

  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
      }}
    >

      <Stack.Screen
        name="MainTab"
        component={MainTab}
      />

      <Stack.Screen
        name="EditProfile"
        component={ProfileSetupScreen}
      />

      {/* Privacy Policy / Terms & Conditions, opened from Profile. */}
      <Stack.Screen
        name="LegalDocument"
        component={LegalDocumentScreen}
      />

      <Stack.Screen
        name="AddressList"
        component={AddressListScreen}
      />

      <Stack.Screen
        name="AddAddress"
        component={AddAddressScreen}
      />

      <Stack.Screen
        name="EditAddress"
        component={EditAddressScreen}
      />

      <Stack.Screen
        name="BusinessList"
        component={BusinessListScreen}
      />

      <Stack.Screen
        name="BusinessDetails"
        component={BusinessDetailsScreen}
      />

      <Stack.Screen
        name="ServiceCategory"
        component={ServiceCategoryScreen}
      />

      <Stack.Screen
        name="OrderType"
        component={OrderTypeScreen}
      />

      <Stack.Screen
        name="OrderTypeScreen"
        component={OrderTypeScreen}
      />

      <Stack.Screen
        name="BusinessCategoriesScreen"
        component={BusinessCategoriesScreen}
      />

      <Stack.Screen
        name="BusinessSubCategoriesScreen"
        component={BusinessSubCategoriesScreen}
      />

      <Stack.Screen
        name="BusinessItemsScreen"
        component={BusinessItemsScreen}
      />

    </Stack.Navigator>
  );
}


// =========================================================
// BUSINESS SECTION
//
// Four independent stacks, one per bottom tab, so nested
// screens (order details, tracking, checkout) push inside
// their own tab without leaving the Business section.
// =========================================================

function BusinessHomeStack() {
  return (
    <Stack.Navigator
      initialRouteName="HomeScreen"
      screenOptions={{ headerShown: false }}
    >
      {/* 1. Home Page: Laundry Type (Hotel Laundry / Guest Laundry) & Search */}
      <Stack.Screen name="HomeScreen" component={HomeScreen} />

      {/* 2. Order Type: Standard Order / Quick Order */}
      <Stack.Screen name="OrderType" component={OrderTypeScreen} />
      <Stack.Screen name="OrderTypeScreen" component={OrderTypeScreen} />

      {/* 3. Main Categories Page: 4 Main Categories */}
      <Stack.Screen name="BusinessCategoriesScreen" component={BusinessCategoriesScreen} />

      {/* 4. Existing Services: SubCategories & Items */}
      <Stack.Screen name="BusinessSubCategoriesScreen" component={BusinessSubCategoriesScreen} />
      <Stack.Screen name="BusinessItemsScreen" component={BusinessItemsScreen} />

      {/* THE TICKET SCREENS. The hotel raises tickets and reads the replies.
          Registered in every role stack that has a Tickets button, under the
          same route names, because only one stack is mounted at a time. */}
      <Stack.Screen name="TicketsScreen" component={TicketsScreen} />
      <Stack.Screen name="TicketDetailScreen" component={TicketDetailScreen} />
      <Stack.Screen name="CreateTicketScreen" component={CreateTicketScreen} />
    </Stack.Navigator>
  );
}

function BusinessOrdersStack() {
  return (
    <Stack.Navigator
      initialRouteName="BusinessOrdersScreen"
      screenOptions={{ headerShown: false }}
    >
      <Stack.Screen name="BusinessOrdersScreen" component={BusinessOrdersScreen} />
      <Stack.Screen name="BusinessOrderDetailsScreen" component={BusinessOrderDetailsScreen} />
      <Stack.Screen name="BusinessOrderTrackingScreen" component={BusinessOrderTrackingScreen} />
      {/* Where a business answers a rider who collected without counting.
          Reached from the Your Orders header; a rider is blocked until it is. */}
      <Stack.Screen name="BusinessDoorTicketsScreen" component={BusinessDoorTicketsScreen} />
    </Stack.Navigator>
  );
}

function BusinessCartStack() {
  return (
    <Stack.Navigator
      initialRouteName="BusinessCartScreen"
      screenOptions={{ headerShown: false }}
    >
      <Stack.Screen name="BusinessCartScreen" component={BusinessCartScreen} />
      {/* Cart -> Continue -> here. Pushed onto the Cart's own stack, so the
          cart screen stays mounted and nothing selected is lost. */}
      <Stack.Screen name="BusinessTimeSlotScreen" component={BusinessTimeSlotScreen} />
    </Stack.Navigator>
  );
}

function BusinessProfileStack() {
  return (
    <Stack.Navigator
      initialRouteName="BusinessProfileScreen"
      screenOptions={{ headerShown: false }}
    >
      <Stack.Screen name="BusinessProfileScreen" component={BusinessProfileScreen} />
      <Stack.Screen name="BusinessProfileDetailsScreen" component={BusinessProfileDetailsScreen} />
      <Stack.Screen name="StoreLocatorScreen" component={StoreLocatorScreen} />
      {/* Same screen as the customer section registers, pushed onto this
          stack so it keeps the Business tab bar and its own back behaviour. */}
      <Stack.Screen name="LegalDocument" component={LegalDocumentScreen} />
    </Stack.Navigator>
  );
}


// =========================================================
// BUSINESS TABS
//
// The frosted LiquidGlassTabBar is the tab bar itself, so it
// exists once and React Navigation owns active state. The
// Customer tabs use the same component.
// =========================================================

function BusinessTabs() {
  /*
   * The assistant is a modal owned by the tab navigator, not a screen in a
   * stack, and it is opened from a store rather than by navigating. Opening
   * or closing it therefore never remounts Select Items, so the items and
   * quantities already chosen are still there afterwards.
   */
  const isChatOpen = useChatStore((state) => state.isOpen);
  const closeChat = useChatStore((state) => state.close);

  return (
    <>
      <Tab.Navigator
        initialRouteName="BusinessHome"
        screenOptions={{ headerShown: false }}
        /* No brand plate in the Business bar: every Business screen already
           opens with the full-width Swachham banner, so the mark at the
           bottom of the same page was the logo twice. The Customer tabs keep
           theirs. */
        tabBar={(props) => <LiquidGlassTabBar {...props} showBrandBadge={false} />}
      >
        <Tab.Screen name="BusinessHome" component={BusinessHomeStack} />
        <Tab.Screen name="BusinessOrders" component={BusinessOrdersStack} />
        <Tab.Screen name="BusinessCart" component={BusinessCartStack} />
        <Tab.Screen name="BusinessProfile" component={BusinessProfileStack} />
      </Tab.Navigator>

      <SwachhamChatbot visible={isChatOpen} onClose={closeChat} section="business" />
    </>
  );
}


// =========================================================
// SORTER STACK
//
// Home -> requests page -> order detail. No tabs: the shop
// floor works one queue, and a bottom bar would only take
// room from it.
// =========================================================

// =========================================================
// SUPER ADMIN STACK
//
// One stack, not tabs: the dashboard is the landing page and
// everything else is opened from it and closed again.
// =========================================================

/**
 * The Manager section.
 *
 * One stack, like the Super Admin's: a dashboard that everything else opens
 * from and closes back to. There is no tab bar because there are four
 * destinations and they are all tasks, not places.
 */
function ManagerStack() {
  return (
    <Stack.Navigator
      initialRouteName="ManagerDashboard"
      screenOptions={{ headerShown: false }}
    >
      <Stack.Screen name="ManagerDashboard" component={ManagerDashboardScreen} />
      <Stack.Screen name="ManagerNewBusiness" component={ManagerNewBusinessScreen} />
      {/* Rider and sorter share a screen; `kind` says which. */}
      <Stack.Screen name="ManagerNewStaff" component={ManagerNewStaffScreen} />
      <Stack.Screen name="ManagerRequests" component={ManagerRequestsScreen} />
      {/* The two ORDER tabs: Customer Requests and Business Requests. Separate
          from ManagerRequests above, which is the manager's own account
          creation requests and is unchanged. */}
      <Stack.Screen name="ManagerOrderRequests" component={ManagerOrderRequestsScreen} />

      {/* THE TICKET SCREENS. The Manager raises and answers tickets.
          Registered in every role stack that has a Tickets button, under the
          same route names, because only one stack is mounted at a time. */}
      <Stack.Screen name="TicketsScreen" component={TicketsScreen} />
      <Stack.Screen name="TicketDetailScreen" component={TicketDetailScreen} />
      <Stack.Screen name="CreateTicketScreen" component={CreateTicketScreen} />
    </Stack.Navigator>
  );
}


function SuperAdminStack() {
  return (
    <Stack.Navigator
      initialRouteName="SuperAdminDashboard"
      screenOptions={{ headerShown: false }}
    >
      <Stack.Screen name="SuperAdminDashboard" component={SuperAdminDashboardScreen} />
      <Stack.Screen name="SuperAdminApprovals" component={SuperAdminApprovalsScreen} />
      <Stack.Screen name="SuperAdminBusinessList" component={SuperAdminBusinessListScreen} />
      <Stack.Screen name="SuperAdminBusinessDetails" component={SuperAdminBusinessDetailsScreen} />
      <Stack.Screen name="SuperAdminManageBusinesses" component={SuperAdminManageBusinessesScreen} />
      <Stack.Screen name="SuperAdminBusinessAccount" component={SuperAdminBusinessAccountScreen} />
      <Stack.Screen name="SuperAdminEditBusiness" component={SuperAdminEditBusinessScreen} />
      {/* Price List: the menu, then one screen per list. */}
      <Stack.Screen name="SuperAdminPriceList" component={SuperAdminPriceListScreen} />
      <Stack.Screen name="SuperAdminCustomerPrices" component={SuperAdminCustomerPricesScreen} />
      <Stack.Screen name="SuperAdminBusinessPrices" component={SuperAdminBusinessPricesScreen} />
      <Stack.Screen name="SuperAdminBusinessPriceBrowse" component={SuperAdminBusinessPriceBrowseScreen} />
      <Stack.Screen name="SuperAdminBusinessPricesList" component={SuperAdminBusinessPricesListScreen} />

      {/* ---- Reports ---- */}
      <Stack.Screen name="SuperAdminReports" component={SuperAdminReportsScreen} />
      <Stack.Screen name="SuperAdminKgReportHub" component={SuperAdminKgReportHubScreen} />
      <Stack.Screen name="SuperAdminKgReport" component={SuperAdminKgReportScreen} />
      <Stack.Screen name="SuperAdminItemKgReport" component={SuperAdminItemKgReportScreen} />
      {/* The three KG grids, one screen — which is drawn comes from `variant`. */}
      <Stack.Screen name="SuperAdminKgPivotReport" component={SuperAdminKgPivotReportScreen} />
      <Stack.Screen name="SuperAdminDayWiseKgReport" component={SuperAdminDayWiseKgReportScreen} />
      <Stack.Screen
        name="SuperAdminOutstandingReport"
        component={SuperAdminOutstandingReportScreen}
      />

      {/* ---- Purchase ---- */}
      <Stack.Screen name="SuperAdminPurchase" component={SuperAdminPurchaseScreen} />
      <Stack.Screen name="SuperAdminPurchaseForm" component={SuperAdminPurchaseFormScreen} />
      <Stack.Screen name="SuperAdminPurchaseDetail" component={SuperAdminPurchaseDetailScreen} />
      <Stack.Screen name="SuperAdminSuppliers" component={SuperAdminSuppliersScreen} />

      {/* ---- Expense ---- */}
      <Stack.Screen name="SuperAdminExpense" component={SuperAdminExpenseScreen} />
      <Stack.Screen name="SuperAdminExpenseForm" component={SuperAdminExpenseFormScreen} />
      <Stack.Screen name="SuperAdminExpenseDetail" component={SuperAdminExpenseDetailScreen} />
      <Stack.Screen name="SuperAdminExpenseCategories" component={SuperAdminExpenseCategoriesScreen} />
      {/* Creation requests: one screen, the kind chosen by route param. */}
      <Stack.Screen name="SuperAdminRequests" component={SuperAdminRequestsScreen} />
      <Stack.Screen name="SuperAdminManagers" component={SuperAdminManagersScreen} />

      {/* THE TICKET SCREENS. The Super Admin answers every role's tickets.
          Registered in every role stack that has a Tickets button, under the
          same route names, because only one stack is mounted at a time. */}
      <Stack.Screen name="TicketsScreen" component={TicketsScreen} />
      <Stack.Screen name="TicketDetailScreen" component={TicketDetailScreen} />
      <Stack.Screen name="CreateTicketScreen" component={CreateTicketScreen} />
    </Stack.Navigator>
  );
}


/**
 * The Rider section.
 *
 * One stack, no tabs. A rider works a single queue on a phone that is
 * usually in a mount on a handlebar, and a bottom bar would only take room
 * from the one card that matters.
 */
function RiderStack() {
  return (
    <Stack.Navigator
      initialRouteName="RiderDashboard"
      screenOptions={{ headerShown: false }}
    >
      <Stack.Screen name="RiderDashboard" component={RiderDashboardScreen} />
      <Stack.Screen name="RiderJobDetails" component={RiderJobDetailsScreen} />
    </Stack.Navigator>
  );
}


function SorterStack() {
  return (
    <Stack.Navigator
      initialRouteName="SorterDashboardScreen"
      screenOptions={{ headerShown: false }}
    >
      <Stack.Screen name="SorterDashboardScreen" component={SorterDashboardScreen} />
      {/* Both home buttons land here: mode 'today' or 'previous'. */}
      <Stack.Screen name="SorterRequestsScreen" component={SorterRequestsScreen} />
      <Stack.Screen name="SorterOrderDetailsScreen" component={SorterOrderDetailsScreen} />
      {/* THE TICKET SCREENS. The Sorter raises tickets and reads the replies.
          Registered in every role stack that has a Tickets button, under the
          same route names, because only one stack is mounted at a time. */}
      <Stack.Screen name="TicketsScreen" component={TicketsScreen} />
      <Stack.Screen name="TicketDetailScreen" component={TicketDetailScreen} />
      <Stack.Screen name="CreateTicketScreen" component={CreateTicketScreen} />
      <Stack.Screen name="SorterScanScreen" component={SorterScanScreen} />
      <Stack.Screen name="SorterDefectCaptureScreen" component={SorterDefectCaptureScreen} />
      {/* Batch processing: eligibility -> proposed distribution -> confirmed
          batch -> batch barcode scan. Added alongside the routes above, which
          keep working exactly as they did. */}
      <Stack.Screen name="SorterBatchProcessingScreen" component={SorterBatchProcessingScreen} />
      <Stack.Screen
        name="SorterBatchDistributionScreen"
        component={SorterBatchDistributionScreen}
      />
      <Stack.Screen name="SorterBatchDetailScreen" component={SorterBatchDetailScreen} />
      <Stack.Screen name="SorterBatchScanScreen" component={SorterBatchScanScreen} />
    </Stack.Navigator>
  );
}


// =========================================================
// ROOT NAVIGATOR
// =========================================================

export default function AppNavigator() {

  const {
    isAuthenticated,
    user,
    userType,
  } = useAuthStore();


  /*
   * =========================================================
   * REGISTER THIS HANDSET FOR PUSH, ONCE SIGNED IN
   * =========================================================
   *
   * HERE rather than in each sign-in path: `authStore` sets
   * `isAuthenticated` in a dozen places — customer OTP, business password,
   * every staff role, session restore on launch — and hooking each would
   * guarantee one gets missed. Watching the flag catches all of them,
   * including a session restored at startup, which no sign-in handler runs
   * for at all.
   *
   * The endpoint takes the account from the JWT, so this must run AFTER the
   * token exists — which is exactly what this flag means.
   *
   * Failure is expected and ignored: no permission, Expo Go, a build with no
   * `google-services.json`. `registerDeviceForPush` never throws and the
   * notifications it supplements arrive without it.
   */
  React.useEffect(() => {
    if (!isAuthenticated || DEMO_MODE) return;
    let cancelled = false;
    registerDeviceForPush().then((result) => {
      if (cancelled || result.registered) return;
      // Visible in a dev build, silent in production. Worth printing because
      // the failure mode is otherwise "nothing ever arrives".
      if (__DEV__) console.log('[Push] not registered:', result.reason);
    });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);


  /*
   * Normalize role.
   *
   * CUSTOMER -> customer
   * BUSINESS -> business
   */
  const role =
    user?.role
      ? String(user.role).toLowerCase()
      : userType
        ? String(userType).toLowerCase()
        : null;


  /*
   * =========================================================
   * WHAT A DEMO BUILD MOUNTS
   *
   * A demo APK is a BUSINESS-ONLY app. The hotel gets exactly two
   * destinations — the demo sign-in, and the Business section — and every
   * other stack is left unregistered.
   *
   * UNREGISTERED, NOT HIDDEN. React Navigation can only navigate to a screen
   * that exists in the navigator, so a `navigate('SuperAdmin')` from anywhere
   * in a demo build is a no-op rather than a way in. There is no Admin,
   * Super Admin, Manager, Sorter, Rider or Customer screen to reach, no
   * registration form, and no staff login link — because in this build those
   * screens are not part of the app at all.
   *
   * `showEntryScreen` covers the production entry sequence (permission gate,
   * mobile OTP, password step, registration, the staff and super-admin
   * logins). All of it needs a server, so none of it belongs in an offline
   * demo.
   *
   * The splash is kept in BOTH builds: it restores any saved session and is
   * where the app's branding lands first. It hands over to the demo sign-in
   * instead of the permission gate when the flag is on.
   * =========================================================
   */
  const showEntryScreen = !DEMO_MODE && !isAuthenticated;
  /** A signed-in stack for a role the demo never has. */
  const showRole = (target: string) => !DEMO_MODE && isAuthenticated && role === target;


  return (

    /* The bag overlay wraps the navigator so it is drawn above every screen
       and survives navigation. It renders nothing until an Add to Cart is
       pressed, and never takes touches. */
    <CartFlyProvider>
    <NavigationContainer>

      <Stack.Navigator
        initialRouteName="SplashScreen"
        screenOptions={{
          headerShown: false,
          gestureEnabled: false,
        }}
      >

        {/* =================================================
            STEP 0
            BRANDED SPLASH

            Drawn in JS, so the Swachham logo appears in Expo
            Go as well as in a native build. It hands over to
            PermissionScreen, never straight to login, so the
            permission gate below is still never bypassed.
        ================================================= */}

        {/* The splash belongs to BOTH builds: it is where the session is
            restored and where the branding lands. In a demo build it hands
            over to the demo sign-in rather than to the permission gate. */}
        {!isAuthenticated && (

          <Stack.Screen
            name="SplashScreen"
            component={
              SplashScreen
            }
          />

        )}


        {/* =================================================
            DEMO SIGN-IN

            The demo build's ONLY entry point, and the only
            screen below that a demo build registers besides
            the Business section itself.
        ================================================= */}

        {DEMO_MODE && !isAuthenticated && (

          <Stack.Screen
            name="DemoLoginScreen"
            component={
              DemoLoginScreen
            }
          />

        )}


        {/* =================================================
            STEP 1
            PERMISSION SCREEN
           
            This MUST be the first screen.
           
            User cannot enter Login until:
            Location = granted
            Camera = granted
        ================================================= */}

        {showEntryScreen && (

          <Stack.Screen
            name="PermissionScreen"
            component={
              PermissionScreen
            }
          />

        )}


        {/* =================================================
            STEP 2
            MOBILE OTP VERIFICATION
           
            PermissionScreen must navigate here only after
            both permissions have been granted.
        ================================================= */}

        {showEntryScreen && (

          <Stack.Screen
            name="MobileVerificationScreen"
            component={
              MobileVerificationScreen
            }
          />

        )}


        {/* Password step, for the roles the server says need one.
            Customers never reach it. */}

        {showEntryScreen && (

          <Stack.Screen
            name="SignInPasswordScreen"
            component={
              SignInPasswordScreen
            }
          />

        )}


        {/* =================================================
            STEP 3
            LOGIN
           
            MobileVerificationScreen must navigate here
            only after successful OTP verification.
        ================================================= */}

        {showEntryScreen && (

          <Stack.Screen
            name="LoginScreen"
            component={
              LoginScreen
            }
          />

        )}


        {/* =================================================
            CUSTOMER REGISTRATION
           
            Only available from Customer Login.
        ================================================= */}

        {showEntryScreen && (

          <Stack.Screen
            name="CustomerRegisterScreen"
            component={
              CustomerRegisterScreen
            }
          />

        )}


        {/* =================================================
            BUSINESS REGISTRATION
        ================================================= */}

        {showEntryScreen && (

          <Stack.Screen
            name="BusinessRegisterScreen"
            component={
              BusinessRegisterScreen
            }
          />

        )}


        {/* =================================================
            FORGOT PASSWORD
           
            Only available from Customer Login.
        ================================================= */}

        {showEntryScreen && (

          <Stack.Screen
            name="ForgotPasswordScreen"
            component={
              ForgotPasswordScreen
            }
          />

        )}


        {/* =================================================
            RESET PASSWORD
        ================================================= */}

        {showEntryScreen && (

          <Stack.Screen
            name="ResetPasswordScreen"
            component={
              ResetPasswordScreen
            }
          />

        )}


        {/* =================================================
            CUSTOMER APPLICATION
        ================================================= */}

        {showRole('customer') && (

          <Stack.Screen
            name="Customer"
            component={
              CustomerStack
            }
          />

        )}


        {/* =================================================
            SORTER LOGIN

            Reachable only while signed out, from the link on
            the customer login screen.
        ================================================= */}

        {showEntryScreen && (

          <Stack.Screen
            name="SorterLoginScreen"
            component={
              SorterLoginScreen
            }
          />

        )}


        {/* =================================================
            SUPER ADMIN
        ================================================= */}

        {showEntryScreen && (
          <Stack.Screen
            name="SuperAdminLogin"
            component={SuperAdminLoginScreen}
          />
        )}

        {showRole('super_admin') && (
          <Stack.Screen
            name="SuperAdmin"
            component={SuperAdminStack}
          />
        )}


        {/* =================================================
            MANAGER APPLICATION

            Signs in through the same password flow as the
            other staff roles; the role decides which stack
            is mounted, so a Manager cannot navigate into the
            Super Admin one at all.
        ================================================= */}

        {showRole('manager') && (
          <Stack.Screen
            name="Manager"
            component={ManagerStack}
          />
        )}


        {/* =================================================
            SORTER APPLICATION
        ================================================= */}

        {showRole('sorter') && (

          <Stack.Screen
            name="Sorter"
            component={
              SorterStack
            }
          />

        )}


        {/* =================================================
            RIDER APPLICATION

            Same unified sign-in as the other staff roles;
            the role decides the stack, so a rider cannot
            navigate into the Sorter or Manager one.
        ================================================= */}

        {showRole('rider') && (

          <Stack.Screen
            name="Rider"
            component={RiderStack}
          />

        )}


        {/* =================================================
            BUSINESS APPLICATION

            The one signed-in stack a demo build mounts, and
            it is NOT gated on the flag: the demo signs in as
            a business account, so this is the same section,
            the same screens and the same navigation the real
            app gives a business — served from local data.
        ================================================= */}

        {isAuthenticated &&
          role === 'business' && (

          <Stack.Screen
            name="Business"
            component={
              BusinessTabs
            }
          />

        )}

      </Stack.Navigator>

    </NavigationContainer>
    </CartFlyProvider>
  );
}