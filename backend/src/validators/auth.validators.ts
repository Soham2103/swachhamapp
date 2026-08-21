import { body } from 'express-validator';

const customerRegisterValidation = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Name is required')
    .isLength({ min: 2, max: 100 })
    .withMessage('Name must be between 2 and 100 characters'),

  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('Email must be a valid email address')
    .normalizeEmail(),

  body('mobile')
    .trim()
    .notEmpty()
    .withMessage('Mobile number is required')
    .matches(/^[6-9]\d{9}$/)
    .withMessage('Mobile must be a valid 10-digit Indian mobile number'),

  body('password')
    .notEmpty()
    .withMessage('Password is required')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long')
    .matches(/[A-Za-z]/)
    .withMessage('Password must contain at least one letter')
    .matches(/\d/)
    .withMessage('Password must contain at least one number'),
    
  body('confirmPassword')
    .notEmpty()
    .withMessage('Confirm password is required')
    .custom((value, { req }) => {
      if (value !== req.body.password) {
        throw new Error('Passwords do not match');
      }
      return true;
    }),
];

const customerLoginValidation = [
  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('Email must be a valid email address')
    .normalizeEmail(),

  body('password')
    .notEmpty()
    .withMessage('Password is required'),
];

const businessLoginValidation = [
  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('Email must be a valid email address')
    .normalizeEmail(),

  body('password')
    .notEmpty()
    .withMessage('Password is required'),
];

const mobileOtpValidation = [
  body('mobile')
    .trim()
    .notEmpty()
    .withMessage('Mobile number is required')
    .matches(/^[6-9]\d{9}$/)
    .withMessage('Mobile must be a valid 10-digit Indian mobile number'),

  body('otp')
    .trim()
    .notEmpty()
    .withMessage('OTP is required')
    .isLength({ min: 6, max: 6 })
    .withMessage('OTP must be 6 digits')
    .isNumeric()
    .withMessage('OTP must contain only digits'),
];

const resendOtpValidation = [
  body('mobile')
    .trim()
    .notEmpty()
    .withMessage('Mobile number is required')
    .matches(/^[6-9]\d{9}$/)
    .withMessage('Mobile must be a valid 10-digit Indian mobile number'),
];

const forgotPasswordValidation = [
  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('Email must be a valid email address')
    .normalizeEmail(),
];

const resetPasswordValidation = [
  body('mobile')
    .trim()
    .notEmpty()
    .withMessage('Mobile number is required')
    .matches(/^[6-9]\d{9}$/)
    .withMessage('Mobile must be a valid 10-digit Indian mobile number'),
    
  body('otp')
    .trim()
    .notEmpty()
    .withMessage('OTP is required')
    .isLength({ min: 6, max: 6 })
    .withMessage('OTP must be 6 digits')
    .isNumeric()
    .withMessage('OTP must contain only digits'),
    
  body('newPassword')
    .notEmpty()
    .withMessage('New password is required')
    .isLength({ min: 8 })
    .withMessage('New password must be at least 8 characters long')
    .matches(/[A-Za-z]/)
    .withMessage('New password must contain at least one letter')
    .matches(/\d/)
    .withMessage('New password must contain at least one number'),

  body('confirmPassword')
    .notEmpty()
    .withMessage('Confirm password is required')
    .custom((value, { req }) => {
      if (value !== req.body.newPassword) {
        throw new Error('Passwords do not match');
      }
      return true;
    }),
];

const changePasswordValidation = [
  body('currentPassword')
    .notEmpty()
    .withMessage('Current password is required'),

  body('newPassword')
    .notEmpty()
    .withMessage('New password is required')
    .isLength({ min: 8 })
    .withMessage('New password must be at least 8 characters long')
    .matches(/[A-Za-z]/)
    .withMessage('New password must contain at least one letter')
    .matches(/\d/)
    .withMessage('New password must contain at least one number')
    .custom((value, { req }) => {
      if (value === req.body.currentPassword) {
        throw new Error('New password must be different from current password');
      }
      return true;
    }),

  body('confirmPassword')
    .notEmpty()
    .withMessage('Confirm password is required')
    .custom((value, { req }) => {
      if (value !== req.body.newPassword) {
        throw new Error('Passwords do not match');
      }
      return true;
    }),
];

const superAdminLoginValidation = [
  body('username')
    .trim()
    .notEmpty()
    .withMessage('Username is required')
    .isLength({ max: 255 })
    .withMessage('Username is too long'),

  body('password')
    .notEmpty()
    .withMessage('Password is required'),

  // Proof that step 1 (mobile OTP) actually happened.
  body('preAuthToken')
    .trim()
    .notEmpty()
    .withMessage('Mobile verification is required before signing in'),
];

export { 
  customerRegisterValidation, 
  customerLoginValidation, 
  businessLoginValidation,
  mobileOtpValidation,
  resendOtpValidation,
  forgotPasswordValidation,
  resetPasswordValidation,
  changePasswordValidation,
  businessRegisterValidation,
  entryOtpSendValidation,
  entryOtpVerifyValidation,
  superAdminLoginValidation
};

const businessRegisterValidation = [
  body('customerType')
    .notEmpty().withMessage('Customer Type is required')
    .isIn(['HOTEL_RESORT', 'RESTAURANT', 'HOSTEL', 'CORPORATE', 'INSTITUTION', 'OTHER'])
    .withMessage('Invalid Customer Type'),
  body('otherTypeSpecify')
    .if(body('customerType').equals('OTHER'))
    .notEmpty().withMessage('Other Type Specify is required when customer type is OTHER'),
  body('establishmentName')
    .trim().notEmpty().withMessage('Establishment Name is required')
    .isLength({ min: 2, max: 255 }).withMessage('Establishment Name must be between 2 and 255 characters'),
  body('establishmentAddress')
    .trim().notEmpty().withMessage('Establishment Address is required')
    .isLength({ min: 5 }).withMessage('Establishment Address must be at least 5 characters'),
  body('gstNumber')
    .optional({ checkFalsy: true })
    .matches(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/i)
    .withMessage('Invalid GST Number'),
  body('panNumber')
    .optional({ checkFalsy: true })
    .matches(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/i)
    .withMessage('Invalid PAN Number'),
  body('website')
    .optional({ checkFalsy: true })
    .isURL().withMessage('Invalid Website URL'),
  body('contactPersonName')
    .trim().notEmpty().withMessage('Contact Person Name is required')
    .isLength({ min: 2, max: 255 }).withMessage('Contact Person Name must be between 2 and 255 characters'),
  body('designation').optional({ checkFalsy: true }),
  body('mobileNumber')
    .trim().notEmpty().withMessage('Mobile Number is required')
    .matches(/^[6-9]\d{9}$/).withMessage('Invalid Indian mobile number'),
  body('whatsappNumber')
    .optional({ checkFalsy: true })
    .matches(/^[6-9]\d{9}$/).withMessage('Invalid Indian mobile number'),
  body('emailId')
    .trim().notEmpty().withMessage('Email ID is required')
    .isEmail().withMessage('Invalid Email ID')
    .normalizeEmail(),
  body('alternateContactPerson').optional({ checkFalsy: true }),
  body('alternateMobileNo')
    .optional({ checkFalsy: true })
    .matches(/^[6-9]\d{9}$/).withMessage('Invalid Indian mobile number'),
  body('password')
    .notEmpty().withMessage('Password is required')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters long')
    .matches(/[A-Za-z]/).withMessage('Password must contain at least one letter')
    .matches(/\d/).withMessage('Password must contain at least one number'),
  body('confirmPassword')
    .notEmpty().withMessage('Confirm password is required')
    .custom((value, { req }) => {
      if (value !== req.body.password) {
        throw new Error('Passwords do not match');
      }
      return true;
    })
];

const entryOtpSendValidation = [
  body('mobile')
    .trim()
    .notEmpty()
    .withMessage('Mobile number is required')
    .matches(/^[6-9]\d{9}$/)
    .withMessage('Mobile must be a valid 10-digit Indian mobile number'),
];

const entryOtpVerifyValidation = [
  body('mobile')
    .trim()
    .notEmpty()
    .withMessage('Mobile number is required')
    .matches(/^[6-9]\d{9}$/)
    .withMessage('Mobile must be a valid 10-digit Indian mobile number'),
  body('otp')
    .trim()
    .notEmpty()
    .withMessage('OTP is required')
    .isLength({ min: 6, max: 6 })
    .withMessage('OTP must be 6 digits')
    .isNumeric()
    .withMessage('OTP must contain only digits'),
];
