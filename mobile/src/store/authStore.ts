import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';

import authApi from '../services/authApi';
import type { SignInResult } from '../services/authApi';
import { extractErrorMessage } from '../services/api';
import { User, LoginPayload, RegisterPayload, BusinessRegisterPayload } from '../types';

interface AuthState {
  user: User | null;
  userType: 'customer' | 'business' | 'sorter' | 'super_admin' | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;

  customerRegister: (payload: RegisterPayload & { confirmPassword: string }) => Promise<void>;
  businessRegister: (payload: BusinessRegisterPayload) => Promise<void>;
  customerLogin: (payload: LoginPayload) => Promise<void>;
  businessLogin: (payload: LoginPayload) => Promise<void>;
  /** Staff sign-in. Username, not email — see authApi.sorterLogin. */
  sorterLogin: (payload: { username: string; password: string }) => Promise<void>;
  
  sendEntryOtp: (mobile: string) => Promise<void>;
  verifyEntryOtp: (mobile: string, otp: string) => Promise<void>;
  resendEntryOtp: (mobile: string) => Promise<void>;
  
  /** Unified sign-in. One entry point; the server decides the role. */
  signInSendOtp: (mobile: string) => Promise<void>;
  signInVerifyOtp: (mobile: string, otp: string) => Promise<SignInResult>;
  signInPassword: (username: string, password: string, preAuthToken: string) => Promise<void>;

  /** Super admin step 1: OTP out, then verify to learn if step 2 applies. */
  superAdminSendOtp: (mobile: string) => Promise<void>;
  superAdminVerifyOtp: (
    mobile: string,
    otp: string
  ) => Promise<{ isSuperAdmin: boolean; preAuthToken: string | null; name: string | null }>;
  /** Super admin step 2. Only reachable with the token from step 1. */
  superAdminLogin: (username: string, password: string, preAuthToken: string) => Promise<void>;

  verifyMobileOtp: (mobile: string, otp: string) => Promise<void>;
  resendOtp: (mobile: string) => Promise<void>;
  
  forgotPassword: (mobile: string) => Promise<void>;
  verifyResetOtp: (mobile: string, otp: string) => Promise<void>;
  resetPassword: (mobile: string, otp: string, newPassword: string) => Promise<void>;

  restoreSession: () => Promise<void>;
  logout: () => Promise<void>;
  updateUser: (user: Partial<User>) => void;
  setUserType: (type: 'customer' | 'business' | 'sorter' | 'super_admin' | null) => void;
}

const TOKEN_KEY = 'swachham_access_token';
const USER_KEY = 'swachham_user';

/** Maps the role on the account to the stack the app should show. */
function userTypeFor(role?: string | null): 'customer' | 'business' | 'sorter' | 'super_admin' {
  const value = String(role || '').toLowerCase();
  if (value === 'business') return 'business';
  if (value === 'sorter') return 'sorter';
  if (value === 'super_admin') return 'super_admin';
  return 'customer';
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  userType: null,
  token: null,
  isAuthenticated: false,
  isLoading: false,

  setUserType: (type) => set({ userType: type }),

  customerRegister: async (payload: RegisterPayload & { confirmPassword: string }) => {
    try {
      set({ isLoading: true });
      const response = await authApi.customerRegister(payload);
      const authData = (response as any)?.data ?? response;
      if (authData?.accessToken && authData?.user) {
        await SecureStore.setItemAsync(TOKEN_KEY, authData.accessToken);
        await SecureStore.setItemAsync(USER_KEY, JSON.stringify(authData.user));
        set({
          token: authData.accessToken,
          user: authData.user,
          userType: 'customer',
          isAuthenticated: true,
        });
      }
    } catch (error: any) {
      const responseData = error?.response?.data;

      const validationMessages = Array.isArray(responseData?.errors)
        ? responseData.errors
            .map(
              (item: any) =>
                item?.msg ||
                item?.message ||
                item?.error
            )
            .filter(Boolean)
        : [];

      const message =
        validationMessages.length > 0
          ? validationMessages.join('\n')
          : responseData?.message ||
            error?.message ||
            'Registration failed';

      throw new Error(message);
    } finally {
      set({ isLoading: false });
    }
  },

  businessRegister: async (payload: BusinessRegisterPayload) => {
    try {
      set({ isLoading: true });
      const response = await authApi.businessRegister(payload);
      
      await SecureStore.setItemAsync(TOKEN_KEY, response.accessToken);
      await SecureStore.setItemAsync(USER_KEY, JSON.stringify(response.user));
      
      set({
        token: response.accessToken,
        user: response.user,
        userType: 'business',
        isAuthenticated: true,
      });
    } catch (error: any) {
      const message = error?.response?.data?.message || error?.message || 'Business registration failed';
      throw new Error(message);
    } finally {
      set({ isLoading: false });
    }
  },

  sendEntryOtp: async (mobile: string) => {
    if (get().isLoading) return;
    try {
      set({ isLoading: true });
      await authApi.sendEntryOtp(mobile);
    } catch (error: any) {
      throw new Error(extractErrorMessage(error, 'Failed to send OTP'));
    } finally {
      set({ isLoading: false });
    }
  },

  verifyEntryOtp: async (mobile: string, otp: string) => {
    if (get().isLoading) return;
    try {
      set({ isLoading: true });
      await authApi.verifyEntryOtp(mobile, otp);
    } catch (error: any) {
      throw new Error(extractErrorMessage(error, 'OTP verification failed'));
    } finally {
      set({ isLoading: false });
    }
  },

  resendEntryOtp: async (mobile: string) => {
    if (get().isLoading) return;
    try {
      set({ isLoading: true });
      await authApi.resendEntryOtp(mobile);
    } catch (error: any) {
      throw new Error(extractErrorMessage(error, 'Failed to resend OTP'));
    } finally {
      set({ isLoading: false });
    }
  },

  customerLogin: async (payload: LoginPayload) => {
    try {
      set({ isLoading: true });
      const response = await authApi.customerLogin(payload);
      
      await SecureStore.setItemAsync(TOKEN_KEY, response.accessToken);
      await SecureStore.setItemAsync(USER_KEY, JSON.stringify(response.user));
      
      set({
        token: response.accessToken,
        user: response.user,
        userType: 'customer',
        isAuthenticated: true,
      });
    } catch (error: any) {
      const message = error?.response?.data?.message || error?.message || 'Login failed';
      throw new Error(message);
    } finally {
      set({ isLoading: false });
    }
  },

  businessLogin: async (payload: LoginPayload) => {
    try {
      set({ isLoading: true });
      const response = await authApi.businessLogin(payload);
      
      await SecureStore.setItemAsync(TOKEN_KEY, response.accessToken);
      await SecureStore.setItemAsync(USER_KEY, JSON.stringify(response.user));
      
      set({
        token: response.accessToken,
        user: response.user,
        userType: 'business',
        isAuthenticated: true,
      });
    } catch (error: any) {
      const message = error?.response?.data?.message || error?.message || 'Login failed';
      throw new Error(message);
    } finally {
      set({ isLoading: false });
    }
  },

  sorterLogin: async (payload: { username: string; password: string }) => {
    try {
      set({ isLoading: true });
      const response = await authApi.sorterLogin(payload);

      await SecureStore.setItemAsync(TOKEN_KEY, response.accessToken);
      await SecureStore.setItemAsync(USER_KEY, JSON.stringify(response.user));

      set({
        token: response.accessToken,
        user: response.user,
        userType: 'sorter',
        isAuthenticated: true,
      });
    } catch (error: any) {
      const message = error?.response?.data?.message || error?.message || 'Login failed';
      throw new Error(message);
    } finally {
      set({ isLoading: false });
    }
  },

  signInSendOtp: async (mobile: string) => {
    if (get().isLoading) return;
    try {
      set({ isLoading: true });
      await authApi.signinSendOtp(mobile);
    } catch (error: any) {
      throw new Error(extractErrorMessage(error, 'Failed to send OTP'));
    } finally {
      set({ isLoading: false });
    }
  },

  signInVerifyOtp: async (mobile: string, otp: string) => {
    try {
      set({ isLoading: true });
      const response = await authApi.signinVerifyOtp(mobile, otp);
      const result = response.data;

      // A customer is already signed in at this point -- the OTP was the
      // credential -- so the session is stored here and the navigator
      // switches stacks on its own. Anything else is handed back for the
      // caller to route onward; no session is created for those.
      if (result.mode === 'CUSTOMER_SESSION' && result.accessToken && result.user) {
        await SecureStore.setItemAsync(TOKEN_KEY, result.accessToken);
        await SecureStore.setItemAsync(USER_KEY, JSON.stringify(result.user));
        set({
          token: result.accessToken,
          user: result.user,
          userType: userTypeFor(result.user.role),
          isAuthenticated: true,
        });
      }
      return result;
    } catch (error: any) {
      throw new Error(extractErrorMessage(error, 'OTP verification failed'));
    } finally {
      set({ isLoading: false });
    }
  },

  signInPassword: async (username: string, password: string, preAuthToken: string) => {
    try {
      set({ isLoading: true });
      const response = await authApi.signinPassword(username, password, preAuthToken);
      const result = response.data;
      if (!result.accessToken || !result.user) {
        throw new Error('Sign-in failed');
      }
      await SecureStore.setItemAsync(TOKEN_KEY, result.accessToken);
      await SecureStore.setItemAsync(USER_KEY, JSON.stringify(result.user));
      set({
        token: result.accessToken,
        user: result.user,
        userType: userTypeFor(result.user.role),
        isAuthenticated: true,
      });
    } catch (error: any) {
      throw new Error(extractErrorMessage(error, 'Sign-in failed'));
    } finally {
      set({ isLoading: false });
    }
  },

  superAdminSendOtp: async (mobile: string) => {
    if (get().isLoading) return;
    try {
      set({ isLoading: true });
      await authApi.superAdminSendOtp(mobile);
    } catch (error: any) {
      throw new Error(extractErrorMessage(error, 'Failed to send OTP'));
    } finally {
      set({ isLoading: false });
    }
  },

  superAdminVerifyOtp: async (mobile: string, otp: string) => {
    try {
      set({ isLoading: true });
      const response = await authApi.superAdminVerifyOtp(mobile, otp);
      // No session is created here on purpose: clearing the OTP only earns
      // the right to attempt step 2, never an authenticated session.
      return response.data;
    } catch (error: any) {
      throw new Error(extractErrorMessage(error, 'OTP verification failed'));
    } finally {
      set({ isLoading: false });
    }
  },

  superAdminLogin: async (username: string, password: string, preAuthToken: string) => {
    try {
      set({ isLoading: true });
      const response = await authApi.superAdminLogin(username, password, preAuthToken);

      await SecureStore.setItemAsync(TOKEN_KEY, response.accessToken);
      await SecureStore.setItemAsync(USER_KEY, JSON.stringify(response.user));

      set({
        token: response.accessToken,
        user: response.user,
        userType: 'super_admin',
        isAuthenticated: true,
      });
    } catch (error: any) {
      throw new Error(extractErrorMessage(error, 'Login failed'));
    } finally {
      set({ isLoading: false });
    }
  },

  verifyMobileOtp: async (mobile: string, otp: string) => {
    try {
      set({ isLoading: true });
      const response = await authApi.verifyMobileOtp(mobile, otp);
      
      await SecureStore.setItemAsync(TOKEN_KEY, response.accessToken);
      await SecureStore.setItemAsync(USER_KEY, JSON.stringify(response.user));
      
      set({
        token: response.accessToken,
        user: response.user,
        userType: userTypeFor(response.user.role),
        isAuthenticated: true,
      });
    } catch (error: any) {
      const message = error?.response?.data?.message || error?.message || 'OTP verification failed';
      throw new Error(message);
    } finally {
      set({ isLoading: false });
    }
  },

  resendOtp: async (mobile: string) => {
    try {
      set({ isLoading: true });
      await authApi.resendOtp(mobile);
    } catch (error: any) {
      const message = error?.response?.data?.message || error?.message || 'Unable to resend OTP';
      throw new Error(message);
    } finally {
      set({ isLoading: false });
    }
  },

  forgotPassword: async (mobile: string) => {
    try {
      set({ isLoading: true });
      await authApi.forgotPassword(mobile);
    } catch (error: any) {
      const message = error?.response?.data?.message || error?.message || 'Unable to initiate password reset';
      throw new Error(message);
    } finally {
      set({ isLoading: false });
    }
  },

  verifyResetOtp: async (mobile: string, otp: string) => {
    try {
      set({ isLoading: true });
      await authApi.verifyResetOtp(mobile, otp);
    } catch (error: any) {
      const message = error?.response?.data?.message || error?.message || 'Invalid OTP';
      throw new Error(message);
    } finally {
      set({ isLoading: false });
    }
  },

  resetPassword: async (mobile: string, otp: string, newPassword: string) => {
    try {
      set({ isLoading: true });
      await authApi.resetPassword(mobile, otp, newPassword);
    } catch (error: any) {
      const message = error?.response?.data?.message || error?.message || 'Failed to reset password';
      throw new Error(message);
    } finally {
      set({ isLoading: false });
    }
  },

  restoreSession: async () => {
    try {
      set({ isLoading: true });
      const token = await SecureStore.getItemAsync(TOKEN_KEY);
      const userString = await SecureStore.getItemAsync(USER_KEY);

      if (!token) {
        set({ token: null, user: null, userType: null, isAuthenticated: false });
        return;
      }

      try {
        const response = await authApi.getMe();
        if (response.success && response.data) {
          const user = response.data;
          await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
          set({
            token,
            user,
            userType: userTypeFor(user.role),
            isAuthenticated: true,
          });
          return;
        }
      } catch (error) {
        console.log('⚠️ Could not restore session from server.');
      }

      if (userString) {
        try {
          const user: User = JSON.parse(userString);
          set({
            token,
            user,
            userType: userTypeFor(user.role),
            isAuthenticated: true,
          });
          return;
        } catch (error) {
          console.error('❌ Invalid stored user data');
        }
      }

      await SecureStore.deleteItemAsync(TOKEN_KEY);
      await SecureStore.deleteItemAsync(USER_KEY);
      set({ token: null, user: null, userType: null, isAuthenticated: false });

    } catch (error) {
      console.error('❌ Restore session error:', error);
      await SecureStore.deleteItemAsync(TOKEN_KEY);
      await SecureStore.deleteItemAsync(USER_KEY);
      set({ token: null, user: null, userType: null, isAuthenticated: false });
    } finally {
      set({ isLoading: false });
    }
  },

  logout: async () => {
    try {
      set({ isLoading: true });
      try {
        await authApi.logout();
      } catch (error) {
        console.log('⚠️ Backend logout failed.');
      }
      await SecureStore.deleteItemAsync(TOKEN_KEY);
      await SecureStore.deleteItemAsync(USER_KEY);
      set({ token: null, user: null, userType: null, isAuthenticated: false });
    } catch (error) {
      console.error('❌ Logout error:', error);
    } finally {
      set({ isLoading: false });
    }
  },

  updateUser: (userData: Partial<User>) => {
    set((state) => {
      if (!state.user) return state;
      const updatedUser = { ...state.user, ...userData };
      SecureStore.setItemAsync(USER_KEY, JSON.stringify(updatedUser)).catch(console.error);
      return { user: updatedUser };
    });
  },
}));