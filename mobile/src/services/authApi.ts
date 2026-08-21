import apiClient from './api';

/**
 * What the server reports after a mobile number is proven.
 *
 * CUSTOMER_SESSION  already signed in -- go to Home.
 * PASSWORD_REQUIRED staff or business -- ask for username + password.
 * AMBIGUOUS         the number matches several accounts; refused.
 */
export interface SignInResult {
  mode: 'CUSTOMER_SESSION' | 'PASSWORD_REQUIRED' | 'AMBIGUOUS';
  user?: any;
  accessToken?: string;
  refreshToken?: string;
  role?: string;
  name?: string | null;
  preAuthToken?: string;
  message?: string;
}
import { ApiResponse, User, LoginPayload, RegisterPayload, BusinessRegisterPayload } from '../types';
import { API_ENDPOINTS } from '../constants/api';
import { getDeviceId } from '../utils/deviceId';

export interface AuthResponse {
  user: User;
  accessToken: string;
  refreshToken?: string;
}

export interface MessageResponse {
  message: string;
}

const normalizeMobile = (mobile: string): string => {
  let cleaned = mobile.replace(/\D/g, '');
  if (cleaned.length === 12 && cleaned.startsWith('91')) {
    cleaned = cleaned.substring(2);
  }
  if (cleaned.length === 11 && cleaned.startsWith('0')) {
    cleaned = cleaned.substring(1);
  }
  if (cleaned.length !== 10) {
    throw new Error('Please enter a valid 10-digit mobile number.');
  }
  return cleaned;
};

export const authApi = {
  customerRegister: async (payload: RegisterPayload): Promise<ApiResponse<MessageResponse>> => {
    payload.mobile = normalizeMobile(payload.mobile);
    const response = await apiClient.post<ApiResponse<MessageResponse>>(
      API_ENDPOINTS.AUTH_CUSTOMER_REGISTER,
      payload
    );
    return response.data;
  },

  businessRegister: async (payload: BusinessRegisterPayload): Promise<AuthResponse> => {
    const response = await apiClient.post(
      API_ENDPOINTS.AUTH_BUSINESS_REGISTER,
      payload
    );
    const authData = response.data?.data ?? response.data;
    if (!authData?.accessToken || !authData?.user) {
      throw new Error('Authentication token or user info missing.');
    }
    return {
      user: authData.user,
      accessToken: authData.accessToken,
      refreshToken: authData.refreshToken,
    };
  },

  // The device id binds the OTP to this handset: the backend records it on
  // send and refuses to verify the code from anywhere else.
  sendEntryOtp: async (mobile: string): Promise<ApiResponse<MessageResponse>> => {
    const response = await apiClient.post<ApiResponse<MessageResponse>>(
      API_ENDPOINTS.AUTH_ENTRY_SEND_OTP,
      { mobile: normalizeMobile(mobile), deviceId: await getDeviceId() }
    );
    return response.data;
  },

  verifyEntryOtp: async (mobile: string, otp: string): Promise<ApiResponse<MessageResponse>> => {
    const response = await apiClient.post<ApiResponse<MessageResponse>>(
      API_ENDPOINTS.AUTH_ENTRY_VERIFY_OTP,
      { mobile: normalizeMobile(mobile), otp: otp.replace(/\D/g, ''), deviceId: await getDeviceId() }
    );
    return response.data;
  },

  resendEntryOtp: async (mobile: string): Promise<ApiResponse<MessageResponse>> => {
    const response = await apiClient.post<ApiResponse<MessageResponse>>(
      API_ENDPOINTS.AUTH_ENTRY_RESEND_OTP,
      { mobile: normalizeMobile(mobile), deviceId: await getDeviceId() }
    );
    return response.data;
  },

  customerLogin: async (payload: LoginPayload): Promise<AuthResponse> => {
    const response = await apiClient.post(
      API_ENDPOINTS.AUTH_CUSTOMER_LOGIN,
      payload
    );
    const authData = response.data?.data ?? response.data;
    if (!authData?.accessToken || !authData?.user) {
      throw new Error('Authentication token or user info missing.');
    }
    return {
      user: authData.user,
      accessToken: authData.accessToken,
      refreshToken: authData.refreshToken,
    };
  },

  verifyMobileOtp: async (mobile: string, otp: string): Promise<AuthResponse> => {
    const response = await apiClient.post(
      API_ENDPOINTS.AUTH_CUSTOMER_VERIFY_MOBILE,
      { mobile: normalizeMobile(mobile), otp: otp.replace(/\D/g, '') }
    );
    const authData = response.data?.data ?? response.data;
    if (!authData?.accessToken || !authData?.user) {
      throw new Error('Authentication token or user info missing.');
    }
    return {
      user: authData.user,
      accessToken: authData.accessToken,
      refreshToken: authData.refreshToken,
    };
  },

  resendOtp: async (mobile: string): Promise<ApiResponse<MessageResponse>> => {
    const response = await apiClient.post<ApiResponse<MessageResponse>>(
      API_ENDPOINTS.AUTH_CUSTOMER_RESEND_OTP,
      { mobile: normalizeMobile(mobile) }
    );
    return response.data;
  },

  forgotPassword: async (mobile: string): Promise<ApiResponse<MessageResponse>> => {
    const response = await apiClient.post<ApiResponse<MessageResponse>>(
      API_ENDPOINTS.AUTH_CUSTOMER_FORGOT_PASSWORD,
      { mobile: normalizeMobile(mobile) }
    );
    return response.data;
  },

  verifyResetOtp: async (mobile: string, otp: string): Promise<ApiResponse<MessageResponse>> => {
    const response = await apiClient.post<ApiResponse<MessageResponse>>(
      API_ENDPOINTS.AUTH_CUSTOMER_VERIFY_RESET_OTP,
      { mobile: normalizeMobile(mobile), otp: otp.replace(/\D/g, '') }
    );
    return response.data;
  },

  resetPassword: async (mobile: string, otp: string, newPassword: string): Promise<ApiResponse<MessageResponse>> => {
    const response = await apiClient.post<ApiResponse<MessageResponse>>(
      API_ENDPOINTS.AUTH_CUSTOMER_RESET_PASSWORD,
      { mobile: normalizeMobile(mobile), otp: otp.replace(/\D/g, ''), newPassword, confirmPassword: newPassword }
    );
    return response.data;
  },

  /**
   * Sorter sign-in. Staff use a username, not an email, so this does not reuse
   * LoginPayload; everything else about the response is identical.
   */
  sorterLogin: async (payload: { username: string; password: string }): Promise<AuthResponse> => {
    const response = await apiClient.post(
      API_ENDPOINTS.AUTH_SORTER_LOGIN,
      payload
    );
    const authData = response.data?.data ?? response.data;
    if (!authData?.accessToken || !authData?.user) {
      throw new Error('Authentication token or user info missing.');
    }
    return {
      user: authData.user,
      accessToken: authData.accessToken,
      refreshToken: authData.refreshToken,
    };
  },

  businessLogin: async (payload: LoginPayload): Promise<AuthResponse> => {
    const response = await apiClient.post(
      API_ENDPOINTS.AUTH_BUSINESS_LOGIN,
      payload
    );
    const authData = response.data?.data ?? response.data;
    if (!authData?.accessToken || !authData?.user) {
      throw new Error('Authentication token or user info missing.');
    }
    return {
      user: authData.user,
      accessToken: authData.accessToken,
      refreshToken: authData.refreshToken,
    };
  },

  getMe: async (): Promise<ApiResponse<User>> => {
    const response = await apiClient.get<ApiResponse<User>>(API_ENDPOINTS.AUTH_ME);
    return response.data;
  },

  updateProfile: async (data: Partial<User>): Promise<ApiResponse<User>> => {
    const response = await apiClient.put<ApiResponse<User>>(API_ENDPOINTS.PROFILE_UPDATE, data);
    return response.data;
  },

  logout: async (): Promise<ApiResponse<MessageResponse>> => {
    const response = await apiClient.post<ApiResponse<MessageResponse>>(API_ENDPOINTS.AUTH_LOGOUT);
    return response.data;
  },

  /**
   * Super admin sign-in, step 1: send the mobile OTP.
   * The OTP goes out whatever the number is, so this call cannot be used
   * to discover which numbers belong to super admins.
   */
  superAdminSendOtp: async (mobile: string): Promise<ApiResponse<null>> => {
    const response = await apiClient.post<ApiResponse<null>>(
      '/api/auth/super-admin/send-otp',
      { mobile: normalizeMobile(mobile) }
    );
    return response.data;
  },

  /**
   * Step 1b: verify it. Only a super admin gets a preAuthToken back;
   * everyone else gets isSuperAdmin false and is sent to normal sign-in.
   */
  superAdminVerifyOtp: async (
    mobile: string,
    otp: string
  ): Promise<ApiResponse<{ isSuperAdmin: boolean; preAuthToken: string | null; name: string | null }>> => {
    const response = await apiClient.post<
      ApiResponse<{ isSuperAdmin: boolean; preAuthToken: string | null; name: string | null }>
    >('/api/auth/super-admin/verify-otp', {
      mobile: normalizeMobile(mobile),
      otp: otp.replace(/\D/g, ''),
    });
    return response.data;
  },

  /** Step 2: username + password, carrying the proof of step 1. */
  superAdminLogin: async (
    username: string,
    password: string,
    preAuthToken: string
  ): Promise<AuthResponse> => {
    const response = await apiClient.post<{ data: AuthResponse }>(
      '/api/auth/super-admin/login',
      { username, password, preAuthToken }
    );
    return (response.data as any).data ?? response.data;
  },

  /**
   * Unified sign-in, step 1. One entry point for every kind of account.
   */
  signinSendOtp: async (mobile: string): Promise<ApiResponse<null>> => {
    // deviceId is required by the entry-OTP validators and binds the code to
    // this handset, exactly as the other OTP calls in this file do.
    const response = await apiClient.post<ApiResponse<null>>('/api/auth/signin/send-otp', {
      mobile: normalizeMobile(mobile),
      deviceId: await getDeviceId(),
    });
    return response.data;
  },

  /**
   * Step 2. The SERVER decides what this number is: a customer is signed
   * in here and there is nothing more to do; staff and business accounts
   * come back needing a password.
   */
  signinVerifyOtp: async (mobile: string, otp: string): Promise<ApiResponse<SignInResult>> => {
    const response = await apiClient.post<ApiResponse<SignInResult>>(
      '/api/auth/signin/verify-otp',
      {
        mobile: normalizeMobile(mobile),
        otp: otp.replace(/[^0-9]/g, ''),
        deviceId: await getDeviceId(),
      }
    );
    return response.data;
  },

  /** Step 3, only for the roles that need it. */
  signinPassword: async (
    username: string,
    password: string,
    preAuthToken: string
  ): Promise<ApiResponse<SignInResult>> => {
    const response = await apiClient.post<ApiResponse<SignInResult>>(
      '/api/auth/signin/password',
      { username, password, preAuthToken }
    );
    return response.data;
  },
};

export default authApi;