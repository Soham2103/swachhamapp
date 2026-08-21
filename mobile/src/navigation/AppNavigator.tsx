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


// =========================================================
// AUTH / ONBOARDING SCREENS
// =========================================================

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

import CheckoutScreen
  from '../screens/cart/CheckoutScreen';

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

import SorterOrderDetailsScreen
  from '../screens/sorter/SorterOrderDetailsScreen';

import SorterScanScreen
  from '../screens/sorter/SorterScanScreen';


// The one bottom bar for both tab sets: Customer and Business.
import LiquidGlassTabBar from '../components/LiquidGlassTabBar';

import SignInPasswordScreen from '../screens/auth/SignInPasswordScreen';
import ServiceCategoryScreen from '../screens/home/ServiceCategoryScreen';

// =========================================================
// SUPER ADMIN SCREENS
// =========================================================

import SuperAdminLoginScreen from '../screens/superadmin/SuperAdminLoginScreen';
import SuperAdminDashboardScreen from '../screens/superadmin/SuperAdminDashboardScreen';
import SuperAdminApprovalsScreen from '../screens/superadmin/SuperAdminApprovalsScreen';
import SuperAdminBusinessListScreen from '../screens/superadmin/SuperAdminBusinessListScreen';
import SuperAdminBusinessDetailsScreen from '../screens/superadmin/SuperAdminBusinessDetailsScreen';
import SuperAdminCreateBusinessScreen from '../screens/superadmin/SuperAdminCreateBusinessScreen';
import SuperAdminCreateRiderScreen from '../screens/superadmin/SuperAdminCreateRiderScreen';


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

function MainTab() {

  return (
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

      <Tab.Screen
        name="Home"
        component={HomeScreen}
      />

      <Tab.Screen
        name="Orders"
        component={CustomerOrdersScreen}
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
      initialRouteName="BusinessCategoriesScreen"
      screenOptions={{ headerShown: false }}
    >
      {/* The first page is the four main categories — no pre-selection step. */}
      <Stack.Screen name="BusinessCategoriesScreen" component={BusinessCategoriesScreen} />
      <Stack.Screen name="BusinessSubCategoriesScreen" component={BusinessSubCategoriesScreen} />
      <Stack.Screen name="BusinessItemsScreen" component={BusinessItemsScreen} />
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
  return (
    <Tab.Navigator
      initialRouteName="BusinessHome"
      screenOptions={{ headerShown: false }}
      tabBar={(props) => <LiquidGlassTabBar {...props} />}
    >
      <Tab.Screen name="BusinessHome" component={BusinessHomeStack} />
      <Tab.Screen name="BusinessOrders" component={BusinessOrdersStack} />
      <Tab.Screen name="BusinessCart" component={BusinessCartStack} />
      <Tab.Screen name="BusinessProfile" component={BusinessProfileStack} />
    </Tab.Navigator>
  );
}


// =========================================================
// SORTER STACK
//
// Dashboard + order detail. No tabs: the shop floor works
// one queue, and a bottom bar would only take room from it.
// =========================================================

// =========================================================
// SUPER ADMIN STACK
//
// One stack, not tabs: the dashboard is the landing page and
// everything else is opened from it and closed again.
// =========================================================

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
      <Stack.Screen name="SuperAdminCreateBusiness" component={SuperAdminCreateBusinessScreen} />
      <Stack.Screen name="SuperAdminCreateRider" component={SuperAdminCreateRiderScreen} />
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
      <Stack.Screen name="SorterOrderDetailsScreen" component={SorterOrderDetailsScreen} />
      <Stack.Screen name="SorterScanScreen" component={SorterScanScreen} />
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


  return (

    <NavigationContainer>

      <Stack.Navigator
        initialRouteName="PermissionScreen"
        screenOptions={{
          headerShown: false,
          gestureEnabled: false,
        }}
      >

        {/* =================================================
            STEP 1
            PERMISSION SCREEN
           
            This MUST be the first screen.
           
            User cannot enter Login until:
            Location = granted
            Camera = granted
        ================================================= */}

        {!isAuthenticated && (

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

        {!isAuthenticated && (

          <Stack.Screen
            name="MobileVerificationScreen"
            component={
              MobileVerificationScreen
            }
          />

        )}


        {/* Password step, for the roles the server says need one.
            Customers never reach it. */}

        {!isAuthenticated && (

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

        {!isAuthenticated && (

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

        {!isAuthenticated && (

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

        {!isAuthenticated && (

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

        {!isAuthenticated && (

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

        {!isAuthenticated && (

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

        {isAuthenticated &&
          role === 'customer' && (

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

        {!isAuthenticated && (

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

        {!isAuthenticated && (
          <Stack.Screen
            name="SuperAdminLogin"
            component={SuperAdminLoginScreen}
          />
        )}

        {isAuthenticated && role === 'super_admin' && (
          <Stack.Screen
            name="SuperAdmin"
            component={SuperAdminStack}
          />
        )}


        {/* =================================================
            SORTER APPLICATION
        ================================================= */}

        {isAuthenticated &&
          role === 'sorter' && (

          <Stack.Screen
            name="Sorter"
            component={
              SorterStack
            }
          />

        )}


        {/* =================================================
            BUSINESS APPLICATION
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
  );
}