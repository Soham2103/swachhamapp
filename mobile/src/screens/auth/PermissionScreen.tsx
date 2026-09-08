import React, { useCallback, useState } from 'react';

import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  SafeAreaView,
  StatusBar,
  Alert,
  Linking,
  ActivityIndicator,
} from 'react-native';

import { Ionicons } from '@expo/vector-icons';

import { getNotifications } from '../../services/expoNotifications';
import * as Location from 'expo-location';
import { Camera } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';

import {
  useNavigation,
  useFocusEffect,
} from '@react-navigation/native';

import {
  COLORS,
  SPACING,
  TYPOGRAPHY,
  BORDER_RADIUS,
} from '../../constants/theme';

import {
  useLocationGateStore,
  OUTSIDE_DISTRICT_MESSAGE,
} from '../../store/locationGateStore';


export default function PermissionScreen() {

  const navigation =
    useNavigation<any>();

  const [loading, setLoading] =
    useState(false);


  const [permissions, setPermissions] =
    useState({
      notifications: false,
      location: false,
      camera: false,
      photos: false,
    });


  /*
   * =====================================================
   * SERVICE AREA — THE APP'S ONLY LOCATION CHECK
   * =====================================================
   *
   * Permission, one GPS fix, and the server's verdict on
   * whether it falls inside Ratnagiri district, all on this
   * page. Passing it is what opens the app.
   *
   * Nothing later repeats it: not login, not the business
   * catalogue, not the cart, and not Place Order.
   */

  const areaStatus =
    useLocationGateStore(state => state.status);

  const areaMessage =
    useLocationGateStore(state => state.message);

  const isCheckingArea =
    useLocationGateStore(state => state.isChecking);

  const verifyArea =
    useLocationGateStore(state => state.verify);


  const locationVerified =
    areaStatus === 'verified';


  const runLocationCheck =
    async (force = false) => {

      const result =
        await verifyArea({ force });

      setPermissions(prev => ({
        ...prev,

        // A verdict of any kind means permission was granted;
        // a denial is reported as its own status.
        location:
          result.status !== 'permission-denied' &&
          result.status !== 'idle',
      }));

      return result;
    };


  // =====================================================
  // NOTIFICATIONS - OPTIONAL
  // =====================================================

  const requestNotifications =
    async () => {

      // Null in Expo Go on Android, where the module cannot be imported at
      // all. Notifications are optional and both callers discard this result,
      // so reporting "not granted" is the honest answer and blocks nothing.
      const Notifications = getNotifications();

      if (!Notifications) {

        setPermissions(prev => ({
          ...prev,
          notifications: false,
        }));

        return false;
      }

      try {

        const { status } =
          await Notifications.requestPermissionsAsync();

        const granted =
          status === 'granted';

        setPermissions(prev => ({
          ...prev,
          notifications: granted,
        }));

        return granted;

      } catch (error) {

        console.error(
          'Notification permission error:',
          error
        );

        return false;
      }
    };


  // =====================================================
  // CAMERA - REQUIRED
  // =====================================================

  const requestCamera =
    async () => {

      try {

        const { status } =
          await Camera.requestCameraPermissionsAsync();

        const granted =
          status === 'granted';

        setPermissions(prev => ({
          ...prev,
          camera: granted,
        }));

        return granted;

      } catch (error) {

        console.error(
          'Camera permission error:',
          error
        );

        return false;
      }
    };


  // =====================================================
  // PHOTOS / MEDIA - OPTIONAL
  // =====================================================

  const requestPhotos =
    async () => {

      try {

        const result =
          await ImagePicker.requestMediaLibraryPermissionsAsync();

        const granted =
          result.status === 'granted';

        setPermissions(prev => ({
          ...prev,
          photos: granted,
        }));

        return granted;

      } catch (error) {

        console.error(
          'Photo permission error:',
          error
        );

        return false;
      }
    };


  // =====================================================
  // CHECK REQUIRED PERMISSIONS EVERY TIME SCREEN OPENS
  // =====================================================

  useFocusEffect(
    useCallback(() => {

      let isActive = true;


      const checkRequiredPermissions =
        async () => {

          try {

            setLoading(true);

            /*
             * Camera and Location are both REQUIRED.
             *
             * Every time this screen receives focus,
             * we check their current OS permission status.
             *
             * This is important because the user may have
             * changed the permission from phone Settings.
             */

            const locationStatus =
              await Location.getForegroundPermissionsAsync();

            const cameraStatus =
              await Camera.getCameraPermissionsAsync();


            if (isActive) {

              setPermissions(prev => ({
                ...prev,

                location:
                  locationStatus.status === 'granted',

                camera:
                  cameraStatus.status === 'granted',
              }));


              // Permission already granted from an earlier run:
              // take the fix straight away so the user sees the
              // verdict without having to tap anything.
              if (
                locationStatus.status === 'granted' &&
                !useLocationGateStore.getState().isVerified()
              ) {
                runLocationCheck();
              }
            }

          } catch (error) {

            console.error(
              'Required permission check error:',
              error
            );

          } finally {

            if (isActive) {
              setLoading(false);
            }
          }
        };


      checkRequiredPermissions();


      return () => {
        isActive = false;
      };

    }, [])
  );


  // =====================================================
  // CONTINUE
  // =====================================================

  const handleContinue =
    async () => {

      try {

        setLoading(true);


        /*
         * =================================================
         * LOCATION — REQUIRED, AND CHECKED ONLY HERE
         * =================================================
         *
         * The user cannot enter the app until the fix has
         * been taken and the server has confirmed it is
         * inside the service district. The message below
         * says which of those failed; the banner on screen
         * carries the same wording with a retry.
         */

        const area =
          await runLocationCheck();


        if (area.status !== 'verified') {

          Alert.alert(
            area.status === 'outside'
              ? 'Service Not Available'
              : 'Location Required',

            area.message || OUTSIDE_DISTRICT_MESSAGE,

            area.status === 'permission-denied'
              ? [
                  {
                    text: 'Cancel',
                    style: 'cancel',
                  },
                  {
                    text: 'Open Settings',
                    onPress: () => {
                      Linking.openSettings();
                    },
                  },
                ]
              : [{ text: 'OK' }]
          );

          return;
        }


        const cameraGranted =
          await requestCamera();


        /*
         * If camera is not granted, STOP.
         *
         * User cannot enter the next screen.
         */

        if (!cameraGranted) {

          Alert.alert(
            'Camera Permission Required',
            'Camera permission is required to continue. Please allow Camera access.',
            [
              {
                text: 'Cancel',
                style: 'cancel',
              },
              {
                text: 'Open Settings',
                onPress: () => {
                  Linking.openSettings();
                },
              },
            ]
          );

          return;
        }


        /*
         * =================================================
         * BOTH REQUIRED PERMISSIONS GRANTED
         * =================================================
         *
         * Optional permissions can now be requested.
         *
         * They DO NOT block the user.
         */

        await requestNotifications();
        await requestPhotos();


        /*
         * =================================================
         * IMPORTANT AUTHENTICATION FLOW
         * =================================================
         *
         * DO NOT go directly to LoginScreen.
         *
         * Required flow:
         *
         * Permission
         *      ↓
         * Mobile OTP
         *      ↓
         * Login
         *
         * reset() also prevents the user from pressing
         * Back and returning to the permission screen.
         */

        navigation.reset({
          index: 0,

          routes: [
            {
              name: 'MobileVerificationScreen',

              /*
               * This parameter identifies this OTP as
               * ENTRY verification.
               *
               * Your MobileVerificationScreen can use
               * this to distinguish it from registration
               * or password-reset OTP.
               */
              params: {
                verificationPurpose: 'ENTRY',
              },
            },
          ],
        });

      } catch (error) {

        console.error(
          'Permission setup error:',
          error
        );

        Alert.alert(
          'Permission Error',
          'Unable to complete permission setup. Please try again.'
        );

      } finally {

        setLoading(false);
      }
    };


  // =====================================================
  // INDIVIDUAL PERMISSION
  // =====================================================

  const handlePermissionPress =
    async (
      type:
        | 'notifications'
        | 'location'
        | 'camera'
        | 'photos'
    ) => {

      if (type === 'notifications') {

        await requestNotifications();

        return;
      }


      if (type === 'location') {

        /*
         * Required: this is where the district check happens.
         * `force` because tapping the row is an explicit ask
         * to check again.
         */
        await runLocationCheck(true);

        return;
      }


      if (type === 'camera') {

        const granted =
          await requestCamera();


        if (!granted) {

          Alert.alert(
            'Camera Required',
            'Camera permission is required to continue. Please enable Camera permission in your phone settings.',
            [
              {
                text: 'Cancel',
                style: 'cancel',
              },
              {
                text: 'Open Settings',
                onPress: () => {
                  Linking.openSettings();
                },
              },
            ]
          );
        }

        return;
      }


      if (type === 'photos') {

        await requestPhotos();

        return;
      }
    };


  // =====================================================
  // REQUIRED PERMISSIONS STATUS
  // =====================================================

  // Both are required to enter the app: the camera permission, and a
  // location the server confirmed is inside the service district.
  const requiredPermissionsGranted =
    permissions.camera && locationVerified;


  // =====================================================
  // UI
  // =====================================================

  return (

    <SafeAreaView
      style={styles.container}
    >

      <StatusBar
        barStyle="dark-content"
        backgroundColor={
          COLORS.Background
        }
      />


      <View style={styles.content}>

        {/* =================================================
            HEADER
        ================================================= */}

        <View style={styles.header}>

          <View style={styles.headerIcon}>

            <Ionicons
              name="shield-checkmark-outline"
              size={42}
              color={COLORS.Primary}
            />

          </View>


          <Text style={styles.title}>
            Allow Permissions
          </Text>


          <Text style={styles.subtitle}>
            Swachham needs a few permissions
            to provide you with the best
            experience.
          </Text>

        </View>


        {/* =================================================
            PERMISSIONS
        ================================================= */}

        <View style={styles.permissions}>

          {/* NOTIFICATIONS */}

          <PermissionCard
            icon="notifications-outline"
            title="Notifications"
            description="Get updates about your orders and deliveries."
            granted={
              permissions.notifications
            }
            required={false}
            onPress={() =>
              handlePermissionPress(
                'notifications'
              )
            }
          />


          {/* LOCATION - OPTIONAL */}

          <PermissionCard
            icon="location-outline"
            title="Location"
            description="We need your location to verify service availability in your area."
            granted={
              locationVerified
            }
            required={true}
            onPress={() =>
              handlePermissionPress(
                'location'
              )
            }
          />


          {/* CAMERA - REQUIRED */}

          <PermissionCard
            icon="camera-outline"
            title="Camera"
            description="Required to take photos for your profile and services."
            granted={
              permissions.camera
            }
            required={true}
            onPress={() =>
              handlePermissionPress(
                'camera'
              )
            }
          />


          {/* PHOTOS */}

          <PermissionCard
            icon="images-outline"
            title="Photos & Media"
            description="Select photos for your profile and business."
            granted={
              permissions.photos
            }
            required={false}
            onPress={() =>
              handlePermissionPress(
                'photos'
              )
            }
          />

        </View>


        {/* =================================================
            SERVICE AREA VERDICT

            The result of the one location check the app
            performs. Verified means the user may continue.
        ================================================= */}

        {isCheckingArea ? (

          <View style={styles.areaChecking}>

            <ActivityIndicator
              size="small"
              color={COLORS.Primary}
            />

            <Text style={styles.areaCheckingText}>
              Checking your location...
            </Text>

          </View>

        ) : locationVerified ? (

          <View style={styles.areaVerified}>

            <Ionicons
              name="checkmark-circle"
              size={20}
              color={COLORS.Success}
            />

            <Text style={styles.areaVerifiedText}>
              Location verified
            </Text>

          </View>

        ) : areaStatus !== 'idle' ? (

          <View style={styles.areaBlocked}>

            <View style={styles.areaBlockedRow}>

              <Ionicons
                name={
                  areaStatus === 'outside'
                    ? 'location-outline'
                    : 'alert-circle-outline'
                }
                size={20}
                color={COLORS.Error}
              />

              <Text style={styles.areaBlockedText}>
                {areaMessage || OUTSIDE_DISTRICT_MESSAGE}
              </Text>

            </View>

            <TouchableOpacity
              style={styles.areaRetry}
              onPress={() =>
                areaStatus === 'permission-denied'
                  ? Linking.openSettings()
                  : runLocationCheck(true)
              }
              activeOpacity={0.85}
            >

              <Ionicons
                name={
                  areaStatus === 'permission-denied'
                    ? 'settings-outline'
                    : 'refresh'
                }
                size={18}
                color="#fff"
              />

              <Text style={styles.areaRetryText}>
                {
                  areaStatus === 'permission-denied'
                    ? 'ENABLE LOCATION'
                    : 'RETRY'
                }
              </Text>

            </TouchableOpacity>

          </View>

        ) : null}


        {/* =================================================
            REQUIRED PERMISSION MESSAGE
        ================================================= */}

        {!requiredPermissionsGranted && (

          <View
            style={
              styles.warningContainer
            }
          >

            <Ionicons
              name="information-circle-outline"
              size={20}
              color={COLORS.Primary}
            />


            <Text
              style={styles.warningText}
            >
              {
                locationVerified
                  ? 'Camera permission is required to continue.'
                  : 'Location and Camera permissions are required to continue.'
              }
            </Text>

          </View>

        )}


        {/* =================================================
            CONTINUE
        ================================================= */}

        {/*
          Continue is NOT gated on the camera permission.
          handleContinue requests Camera itself and refuses to move on if it is
          denied, so gating the button on the permission only made the screen a
          dead end: the button that asks for Camera cannot be pressed until
          Camera is already granted, and a user who does not think to tap the
          Camera row can never leave this screen.
        */}
        <TouchableOpacity
          style={[
            styles.continueButton,
            (loading || isCheckingArea) &&
              styles.buttonDisabled,
          ]}
          onPress={handleContinue}
          disabled={loading || isCheckingArea}
          activeOpacity={0.8}
        >

          <Text
            style={styles.continueText}
          >
            {
              loading || isCheckingArea
                ? 'Checking Permissions...'
                : 'Continue'
            }
          </Text>


          {!loading && (

            <Ionicons
              name="arrow-forward"
              size={20}
              color="#fff"
            />

          )}

        </TouchableOpacity>


        <Text style={styles.footerText}>
          You can change these permissions
          anytime from your phone settings.
        </Text>

      </View>

    </SafeAreaView>
  );
}


// =====================================================
// PERMISSION CARD
// =====================================================

type PermissionCardProps = {

  icon:
    keyof typeof Ionicons.glyphMap;

  title: string;

  description: string;

  granted: boolean;

  required: boolean;

  onPress: () => void;
};


function PermissionCard({
  icon,
  title,
  description,
  granted,
  required,
  onPress,
}: PermissionCardProps) {

  return (

    <TouchableOpacity
      style={styles.permissionCard}
      onPress={onPress}
      activeOpacity={0.8}
    >

      <View
        style={styles.permissionIcon}
      >

        <Ionicons
          name={icon}
          size={25}
          color={COLORS.Primary}
        />

      </View>


      <View
        style={styles.permissionText}
      >

        <View
          style={styles.titleRow}
        >

          <Text
            style={styles.permissionTitle}
          >
            {title}
          </Text>


          {required && (

            <Text
              style={styles.requiredText}
            >
              REQUIRED
            </Text>

          )}

        </View>


        <Text
          style={
            styles.permissionDescription
          }
        >
          {description}
        </Text>

      </View>


      {granted ? (

        <Ionicons
          name="checkmark-circle"
          size={26}
          color={COLORS.Primary}
        />

      ) : (

        <Ionicons
          name="chevron-forward"
          size={22}
          color={COLORS.TextSecondary}
        />

      )}

    </TouchableOpacity>
  );
}


// =====================================================
// STYLES
// =====================================================

const styles =
  StyleSheet.create({

    container: {
      flex: 1,
      backgroundColor:
        COLORS.Background,
    },


    content: {
      flex: 1,
      paddingHorizontal:
        SPACING.lg,
      justifyContent: 'center',
    },


    // ===================================================
    // HEADER
    // ===================================================

    header: {
      alignItems: 'center',
      marginBottom:
        SPACING.lg,
    },


    headerIcon: {
      width: 80,
      height: 80,
      borderRadius: 40,
      backgroundColor:
        '#E8F5E9',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom:
        SPACING.md,
    },


    title: {
      fontSize:
        TYPOGRAPHY.sizes.xxl,
      fontWeight:
        TYPOGRAPHY.weights.bold,
      color:
        COLORS.TextPrimary,
      textAlign: 'center',
      marginBottom:
        SPACING.sm,
    },


    subtitle: {
      fontSize:
        TYPOGRAPHY.sizes.base,
      color:
        COLORS.TextSecondary,
      textAlign: 'center',
      lineHeight: 22,
    },


    // ===================================================
    // PERMISSIONS
    // ===================================================

    permissions: {
      gap: SPACING.sm,
      marginBottom:
        SPACING.md,
    },


    permissionCard: {
      minHeight: 75,
      backgroundColor:
        COLORS.Surface,
      borderWidth: 1,
      borderColor:
        COLORS.Border,
      borderRadius:
        BORDER_RADIUS.md,
      paddingHorizontal:
        SPACING.md,
      paddingVertical:
        SPACING.sm,
      flexDirection: 'row',
      alignItems: 'center',
    },


    permissionIcon: {
      width: 46,
      height: 46,
      borderRadius: 23,
      backgroundColor:
        '#E8F5E9',
      alignItems: 'center',
      justifyContent: 'center',
      marginRight:
        SPACING.sm,
    },


    permissionText: {
      flex: 1,
    },


    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: 6,
    },


    permissionTitle: {
      fontSize:
        TYPOGRAPHY.sizes.base,
      fontWeight:
        TYPOGRAPHY.weights.semibold,
      color:
        COLORS.TextPrimary,
      marginBottom: 3,
    },


    requiredText: {
      fontSize: 9,
      fontWeight: '700',
      color:
        COLORS.Primary,
      marginBottom: 3,
    },


    permissionDescription: {
      fontSize:
        TYPOGRAPHY.sizes.sm,
      color:
        COLORS.TextSecondary,
      lineHeight: 18,
    },


    // ===================================================
    // SERVICE AREA VERDICT
    // ===================================================

    areaChecking: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: SPACING.sm,
      backgroundColor:
        COLORS.Surface,
      borderWidth: 1,
      borderColor:
        COLORS.Border,
      borderRadius:
        BORDER_RADIUS.md,
      paddingHorizontal:
        SPACING.md,
      paddingVertical:
        SPACING.sm,
      marginBottom:
        SPACING.md,
    },


    areaCheckingText: {
      fontSize:
        TYPOGRAPHY.sizes.sm,
      color:
        COLORS.TextSecondary,
    },


    areaVerified: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: SPACING.sm,
      backgroundColor:
        '#E9F7EF',
      borderWidth: 1,
      borderColor:
        COLORS.Success,
      borderRadius:
        BORDER_RADIUS.md,
      paddingHorizontal:
        SPACING.md,
      paddingVertical:
        SPACING.sm,
      marginBottom:
        SPACING.md,
    },


    areaVerifiedText: {
      fontSize:
        TYPOGRAPHY.sizes.sm,
      fontWeight: '700',
      color:
        COLORS.PrimaryDark,
    },


    areaBlocked: {
      backgroundColor:
        '#FDECEC',
      borderWidth: 1,
      borderColor:
        COLORS.Error,
      borderRadius:
        BORDER_RADIUS.md,
      padding: SPACING.md,
      gap: SPACING.sm,
      marginBottom:
        SPACING.md,
    },


    areaBlockedRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: SPACING.sm,
    },


    areaBlockedText: {
      flex: 1,
      fontSize:
        TYPOGRAPHY.sizes.sm,
      fontWeight: '600',
      color:
        COLORS.Error,
      lineHeight: 18,
    },


    areaRetry: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: SPACING.xs,
      minHeight: 44,
      borderRadius:
        BORDER_RADIUS.sm,
      backgroundColor:
        COLORS.Error,
    },


    areaRetryText: {
      fontSize:
        TYPOGRAPHY.sizes.sm,
      fontWeight: 'bold',
      color: '#fff',
      letterSpacing: 0.5,
    },


    // ===================================================
    // WARNING
    // ===================================================

    warningContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor:
        '#E8F5E9',
      borderRadius:
        BORDER_RADIUS.md,
      paddingHorizontal:
        SPACING.md,
      paddingVertical:
        SPACING.sm,
      marginBottom:
        SPACING.md,
    },


    warningText: {
      flex: 1,
      marginLeft:
        SPACING.sm,
      fontSize:
        TYPOGRAPHY.sizes.sm,
      color:
        COLORS.TextSecondary,
      lineHeight: 18,
    },


    // ===================================================
    // CONTINUE BUTTON
    // ===================================================

    continueButton: {
      height: 54,
      backgroundColor:
        COLORS.Primary,
      borderRadius:
        BORDER_RADIUS.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: SPACING.sm,
    },


    buttonDisabled: {
      opacity: 0.5,
    },


    continueText: {
      color: '#fff',
      fontSize:
        TYPOGRAPHY.sizes.lg,
      fontWeight:
        TYPOGRAPHY.weights.semibold,
    },


    // ===================================================
    // FOOTER
    // ===================================================

    footerText: {
      textAlign: 'center',
      marginTop:
        SPACING.md,
      fontSize:
        TYPOGRAPHY.sizes.sm,
      color:
        COLORS.TextSecondary,
    },

  });