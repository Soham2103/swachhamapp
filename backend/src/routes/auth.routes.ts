import {
  Router,
  Request,
  Response,
  NextFunction,
} from 'express';

import {
  sendSuccess,
  sendError,
} from '../utils/response';

import {
  register,
  customerLogin,
  businessLogin,
  adminLogin,
  superAdminSendOtp,
  superAdminVerifyOtp,
  superAdminLogin,
  getMe,
  updateProfile,
  changePassword,
  verifyMobileOtp,
  sendRegistrationOtp,
  sendPasswordResetOtp,
  verifyPasswordResetOtp,
  resetPassword,
  sendEntryOtp,
  verifyEntryOtp,
  resendEntryOtp,
  sorterLogin,
} from '../services/auth.service';

import {
  authenticate,
  AuthenticatedRequest,
} from '../middleware/auth';

import {
  resolveAfterOtp,
  completeWithPassword,
} from '../services/unifiedAuth.service';

import {
  sendEntryOtp as sendUnifiedOtp,
  verifyEntryOtpOnly,
} from '../services/auth.service';

import {
  handleValidation,
} from '../middleware/validate';

import {
  customerRegisterValidation,
  customerLoginValidation,
  businessLoginValidation,
  changePasswordValidation,
  mobileOtpValidation,
  resendOtpValidation,
  forgotPasswordValidation,
  resetPasswordValidation,
  businessRegisterValidation,
  entryOtpSendValidation,
  entryOtpVerifyValidation,
  superAdminLoginValidation,
} from '../validators/auth.validators';

import {
  authLimiter,
} from '../middleware/rateLimiter';


const router = Router();


// ======================================================
// CUSTOMER REGISTRATION
// ======================================================

router.post(
  '/customer/register',
  authLimiter,
  customerRegisterValidation,
  handleValidation,

  async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {

    try {

      const {
        name,
        email,
        mobile,
        password,
      } = req.body;


      await register(
        name,
        email,
        mobile,
        password
      );

      const result = await customerLogin(email, password);

      sendSuccess(
        res,
        result,
        'Registration successful.',
        201
      );

    } catch (error) {
      next(error);
    }
  }
);


// ======================================================
// CUSTOMER MOBILE VERIFICATION
// ======================================================

router.post(
  '/customer/verify-mobile',
  authLimiter,
  mobileOtpValidation,
  handleValidation,

  async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {

    try {

      const {
        mobile,
        otp,
      } = req.body;


      const result =
        await verifyMobileOtp(
          mobile,
          otp
        );


      sendSuccess(
        res,
        result,
        'Mobile verified successfully.'
      );

    } catch (error) {
      next(error);
    }
  }
);


// ======================================================
// CUSTOMER RESEND REGISTRATION OTP
// ======================================================

router.post(
  '/customer/resend-otp',
  authLimiter,
  resendOtpValidation,
  handleValidation,

  async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {

    try {

      const {
        mobile,
      } = req.body;


      await sendRegistrationOtp(
        mobile
      );


      sendSuccess(
        res,
        null,
        'OTP resent successfully.'
      );

    } catch (error) {
      next(error);
    }
  }
);


// ======================================================
// CUSTOMER LOGIN
// ======================================================

router.post(
  '/customer/login',
  authLimiter,
  customerLoginValidation,
  handleValidation,

  async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {

    try {

      const {
        email,
        password,
      } = req.body;


      const result =
        await customerLogin(
          email,
          password
        );


      sendSuccess(
        res,
        result,
        'Login successful.'
      );

    } catch (error) {
      next(error);
    }
  }
);


// ======================================================
// CUSTOMER FORGOT PASSWORD
// ======================================================

router.post(
  '/customer/forgot-password',
  authLimiter,
  forgotPasswordValidation,
  handleValidation,

  async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {

    try {

      /*
       * IMPORTANT:
       * User enters EMAIL.
       *
       * Backend finds the customer's
       * registered mobile number and
       * sends OTP there.
       */

      const {
        email,
      } = req.body;


      await sendPasswordResetOtp(
        email
      );


      /*
       * Do not reveal whether the
       * account exists.
       */

      sendSuccess(
        res,
        null,
        'If the account exists, a password reset OTP has been sent to the registered mobile number.'
      );

    } catch (error) {
      next(error);
    }
  }
);


// ======================================================
// VERIFY PASSWORD RESET OTP
// ======================================================

router.post(
  '/customer/verify-reset-otp',
  authLimiter,
  mobileOtpValidation,
  handleValidation,

  async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {

    try {

      const {
        email,
        otp,
      } = req.body;


      await verifyPasswordResetOtp(
        email,
        otp
      );


      sendSuccess(
        res,
        null,
        'OTP verified successfully.'
      );

    } catch (error) {
      next(error);
    }
  }
);


// ======================================================
// RESET CUSTOMER PASSWORD
// ======================================================

router.post(
  '/customer/reset-password',
  authLimiter,
  resetPasswordValidation,
  handleValidation,

  async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {

    try {

      const {
        email,
        otp,
        newPassword,
      } = req.body;


      await resetPassword(
        email,
        otp,
        newPassword
      );


      sendSuccess(
        res,
        null,
        'Password reset successfully. You can now login.'
      );

    } catch (error) {
      next(error);
    }
  }
);


// ======================================================
// BUSINESS LOGIN
// ======================================================

router.post(
  '/business/login',
  authLimiter,
  businessLoginValidation,
  handleValidation,

  async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {

    try {

      const {
        email,
        password,
      } = req.body;


      const result =
        await businessLogin(
          email,
          password
        );


      sendSuccess(
        res,
        result,
        'Business login successful.'
      );

    } catch (error) {
      next(error);
    }
  }
);


// ======================================================
// SORTER LOGIN
//
// Staff sign in with a username. Rate limited and role
// pinned exactly like the customer and business logins.
// ======================================================

router.post(
  '/sorter/login',
  authLimiter,

  async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {

    try {

      const {
        username,
        password,
      } = req.body;


      if (!username || !password) {
        sendError(
          res,
          'Username and password are required.',
          400
        );

        return;
      }


      const result =
        await sorterLogin(
          username,
          password
        );


      sendSuccess(
        res,
        result,
        'Sorter login successful.'
      );

    } catch (error) {
      next(error);
    }
  }
);


// ======================================================
// ADMIN LOGIN
// ======================================================

router.post(
  '/admin/login',
  authLimiter,
  // Same shape as the customer form (email + password), so the existing
  // chain is reused rather than duplicated.
  customerLoginValidation,
  handleValidation,

  async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {

    try {

      const {
        email,
        password,
      } = req.body;


      const result =
        await adminLogin(
          email,
          password
        );


      sendSuccess(
        res,
        result,
        'Admin login successful.'
      );

    } catch (error) {
      next(error);
    }
  }
);


// ======================================================
// SUPER ADMIN SIGN-IN — STEP 1: SEND MOBILE OTP
// ======================================================

router.post(
  '/super-admin/send-otp',
  authLimiter,
  entryOtpSendValidation,
  handleValidation,

  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await superAdminSendOtp(req.body.mobile);

      sendSuccess(res, null, 'OTP sent to the registered mobile number.');
    } catch (error) {
      next(error);
    }
  }
);


// ======================================================
// SUPER ADMIN SIGN-IN — STEP 1b: VERIFY MOBILE OTP
//
// Responds with whether this number belongs to a super
// admin, and if so a short-lived token that step 2 needs.
// ======================================================

router.post(
  '/super-admin/verify-otp',
  authLimiter,
  entryOtpVerifyValidation,
  handleValidation,

  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await superAdminVerifyOtp(req.body.mobile, req.body.otp);

      sendSuccess(
        res,
        result,
        result.isSuperAdmin
          ? 'Mobile verified. Please sign in with your username and password.'
          : 'Mobile verified.'
      );
    } catch (error) {
      next(error);
    }
  }
);


// ======================================================
// SUPER ADMIN SIGN-IN — STEP 2: USERNAME + PASSWORD
// ======================================================

router.post(
  '/super-admin/login',
  authLimiter,
  superAdminLoginValidation,
  handleValidation,

  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { username, password, preAuthToken } = req.body;

      const result = await superAdminLogin(username, password, preAuthToken);

      sendSuccess(res, result, 'Super admin login successful.');
    } catch (error) {
      next(error);
    }
  }
);


// ======================================================
// UNIFIED SIGN-IN — STEP 1: MOBILE OTP
//
// One entry point for everybody. The OTP goes out for any
// valid number, so this cannot be used to find out which
// numbers are staff.
// ======================================================

router.post(
  '/signin/send-otp',
  authLimiter,
  entryOtpSendValidation,
  handleValidation,

  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // The device id travels with the unified sign-in too: the shared
      // entry-OTP validators require it, and binding the OTP to the handset
      // that asked for it is the behaviour the rest of the app already has.
      await sendUnifiedOtp(req.body.mobile, req.body.deviceId);
      sendSuccess(res, null, 'OTP sent.');
    } catch (error) {
      next(error);
    }
  }
);


// ======================================================
// UNIFIED SIGN-IN — STEP 2: VERIFY, THEN THE SERVER DECIDES
//
// A customer (or an unrecognised number, which becomes one)
// is signed in here and goes straight to Home. Staff and
// business accounts get a short-lived token and are sent on
// to the password step. The client never says which it is.
// ======================================================

router.post(
  '/signin/verify-otp',
  authLimiter,
  entryOtpVerifyValidation,
  handleValidation,

  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const mobile = await verifyEntryOtpOnly(req.body.mobile, req.body.otp, req.body.deviceId);
      const result = await resolveAfterOtp(mobile);

      sendSuccess(
        res,
        result,
        result.mode === 'CUSTOMER_SESSION'
          ? 'Signed in.'
          : result.mode === 'PASSWORD_REQUIRED'
            ? 'Mobile verified. Please enter your username and password.'
            : (result.message as string)
      );
    } catch (error) {
      next(error);
    }
  }
);


// ======================================================
// UNIFIED SIGN-IN — STEP 3: PASSWORD (STAFF AND BUSINESS)
// ======================================================

router.post(
  '/signin/password',
  authLimiter,
  superAdminLoginValidation,
  handleValidation,

  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { username, password, preAuthToken } = req.body;
      const result = await completeWithPassword(username, password, preAuthToken);
      sendSuccess(res, result, 'Signed in.');
    } catch (error) {
      next(error);
    }
  }
);


// ======================================================
// GET CURRENT USER
// ======================================================

router.get(
  '/me',
  authenticate,

  async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {

    try {

      const authReq =
        req as AuthenticatedRequest;


      // Pass the token role so the right id-space is queried.
      const user =
        await getMe(
          authReq.user!.id,
          authReq.user!.role
        );


      sendSuccess(
        res,
        user,
        'Profile fetched successfully.'
      );

    } catch (error) {
      next(error);
    }
  }
);


// ======================================================
// UPDATE PROFILE
// ======================================================

router.put(
  '/profile',
  authenticate,

  async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {

    try {

      const authReq =
        req as AuthenticatedRequest;


      const user =
        await updateProfile(
          authReq.user!.id,
          req.body
        );


      sendSuccess(
        res,
        user,
        'Profile updated successfully.'
      );

    } catch (error) {
      next(error);
    }
  }
);


// ======================================================
// CHANGE PASSWORD
// ======================================================

router.post(
  '/change-password',
  authenticate,
  changePasswordValidation,
  handleValidation,

  async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {

    try {

      const authReq =
        req as AuthenticatedRequest;


      const {
        currentPassword,
        newPassword,
      } = req.body;


      await changePassword(
        authReq.user!.id,
        currentPassword,
        newPassword
      );


      sendSuccess(
        res,
        null,
        'Password changed successfully.'
      );

    } catch (error) {
      next(error);
    }
  }
);


// ======================================================
// LOGOUT
// ======================================================

router.post(
  '/logout',
  authenticate,

  async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {

    try {

      sendSuccess(
        res,
        null,
        'Logged out successfully.'
      );

    } catch (error) {
      next(error);
    }
  }
);


// ======================================================
// BUSINESS REGISTRATION
// ======================================================

/*
 * Business self-registration is CLOSED.
 *
 * Every business is onboarded by a super admin, who creates the account
 * through POST /api/super-admin/businesses. Leaving this endpoint open
 * would let an account into the system that never passed through
 * onboarding, and so could be missing the establishment details that
 * ordering now depends on.
 *
 * It stays mounted, and answers, so an older build of the app gets a
 * clear explanation instead of a confusing 404.
 */
router.post('/business/register', authLimiter, (_req: Request, res: Response) => {
  sendError(
    res,
    'Business accounts are created by Swachham during onboarding. Please contact us to register your establishment.',
    403
  );
});




// ======================================================
// ENTRY OTP SEND
// ======================================================

router.post(
  '/entry/send-otp',
  authLimiter,
  entryOtpSendValidation,
  handleValidation,

  async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {

    try {

      await sendEntryOtp(
        req.body.mobile,
        req.body.deviceId
      );

      sendSuccess(
        res,
        null,
        'Entry OTP sent successfully.'
      );

    } catch (error) {
      next(error);
    }
  }
);


// ======================================================
// ENTRY OTP VERIFY
// ======================================================

router.post(
  '/entry/verify-otp',
  authLimiter,
  entryOtpVerifyValidation,
  handleValidation,

  async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {

    try {

      await verifyEntryOtp(
        req.body.mobile,
        req.body.otp,
        req.body.deviceId
      );

      sendSuccess(
        res,
        null,
        'Entry OTP verified successfully.'
      );

    } catch (error) {
      next(error);
    }
  }
);


// ======================================================
// ENTRY OTP RESEND
// ======================================================

router.post(
  '/entry/resend-otp',
  authLimiter,
  entryOtpSendValidation,
  handleValidation,

  async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {

    try {

      await resendEntryOtp(
        req.body.mobile,
        req.body.deviceId
      );

      sendSuccess(
        res,
        null,
        'Entry OTP resent successfully.'
      );

    } catch (error) {
      next(error);
    }
  }
);


// ======================================================
// EXPORT
// ======================================================

export default router;