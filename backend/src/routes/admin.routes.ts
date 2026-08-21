import { Router, Request, Response, NextFunction } from 'express';
import { sendSuccess, sendError } from '../utils/response';
import { authenticate, AuthenticatedRequest, requireRole } from '../middleware/auth';
import { query } from '../config/database';

const router = Router();

// SUPER_ADMIN is a superset of ADMIN, so both tiers are listed rather than
// one replacing the other — introducing the higher tier must not revoke
// access from the existing admins.
router.use(authenticate, requireRole(['ADMIN', 'SUPER_ADMIN']));

router.get('/dashboard', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Example dashboard stats
    const usersCount = await query(`SELECT COUNT(*) as count FROM users`);
    const businessesCount = await query(`SELECT COUNT(*) as count FROM businesses`);
    
    const stats = {
      totalUsers: parseInt(usersCount.rows[0]?.count || '0', 10),
      totalBusinesses: parseInt(businessesCount.rows[0]?.count || '0', 10)
    };
    
    sendSuccess(res, stats, 'Admin dashboard stats fetched successfully');
  } catch (error) {
    next(error);
  }
});

// Generic users fetch for admin
router.get('/users', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await query(`SELECT id, name, email, mobile, role, is_active, created_at FROM users ORDER BY created_at DESC`);
    sendSuccess(res, result.rows, 'Users fetched successfully');
  } catch (error) {
    next(error);
  }
});

// ============= ADMIN BUSINESS MANAGEMENT =============

// GET /api/admin/businesses
router.get('/businesses', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await query('SELECT * FROM businesses ORDER BY created_at DESC');
    
    const businesses = [];
    for (const biz of result.rows) {
      const imgResult = await query('SELECT * FROM business_images WHERE business_id = ? ORDER BY sort_order ASC', [biz.id]);
      businesses.push({ ...biz, images: imgResult.rows });
    }
    
    sendSuccess(res, businesses, 'Businesses fetched successfully');
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/businesses
router.post('/businesses', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { name, business_type, description, phone_number, email, address, area, city, state, pincode, latitude, longitude, status } = req.body;
    
    if (!name || !address || !city) {
      sendError(res, 'Name, address, and city are required', 400);
      return;
    }
    
    const insertResult = await query(
      `INSERT INTO businesses (name, business_type, description, phone_number, email, address, area, city, state, pincode, latitude, longitude, status, created_by_admin_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, business_type || 'HOTEL', description || null, phone_number || null, email || null, address, area || null, city, state || null, pincode || null, latitude || null, longitude || null, status || 'ACTIVE', authReq.user!.id]
    );
    
    const result = await query('SELECT * FROM businesses WHERE id = ?', [insertResult.insertId]);
    sendSuccess(res, result.rows[0], 'Business created successfully', 201);
  } catch (error) {
    next(error);
  }
});

// PUT /api/admin/businesses/:id
router.put('/businesses/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, business_type, description, phone_number, email, address, area, city, state, pincode, latitude, longitude } = req.body;
    const businessId = req.params.id;
    
    const existing = await query('SELECT id FROM businesses WHERE id = ?', [businessId]);
    if (existing.rows.length === 0) {
      sendError(res, 'Business not found', 404);
      return;
    }
    
    const fields: string[] = [];
    const values: any[] = [];
    
    if (name !== undefined) { fields.push('name = ?'); values.push(name); }
    if (business_type !== undefined) { fields.push('business_type = ?'); values.push(business_type); }
    if (description !== undefined) { fields.push('description = ?'); values.push(description); }
    if (phone_number !== undefined) { fields.push('phone_number = ?'); values.push(phone_number); }
    if (email !== undefined) { fields.push('email = ?'); values.push(email); }
    if (address !== undefined) { fields.push('address = ?'); values.push(address); }
    if (area !== undefined) { fields.push('area = ?'); values.push(area); }
    if (city !== undefined) { fields.push('city = ?'); values.push(city); }
    if (state !== undefined) { fields.push('state = ?'); values.push(state); }
    if (pincode !== undefined) { fields.push('pincode = ?'); values.push(pincode); }
    if (latitude !== undefined) { fields.push('latitude = ?'); values.push(latitude); }
    if (longitude !== undefined) { fields.push('longitude = ?'); values.push(longitude); }
    
    if (fields.length > 0) {
      fields.push('updated_at = NOW()');
      values.push(businessId);
      await query(`UPDATE businesses SET ${fields.join(', ')} WHERE id = ?`, values);
    }
    
    const result = await query('SELECT * FROM businesses WHERE id = ?', [businessId]);
    sendSuccess(res, result.rows[0], 'Business updated successfully');
  } catch (error) {
    next(error);
  }
});

// PATCH /api/admin/businesses/:id/status
router.patch('/businesses/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status } = req.body;
    if (!['ACTIVE', 'INACTIVE'].includes(status)) {
      sendError(res, 'Status must be ACTIVE or INACTIVE', 400);
      return;
    }
    
    const existing = await query('SELECT id FROM businesses WHERE id = ?', [req.params.id]);
    if (existing.rows.length === 0) {
      sendError(res, 'Business not found', 404);
      return;
    }
    
    await query('UPDATE businesses SET status = ?, updated_at = NOW() WHERE id = ?', [status, req.params.id]);
    const result = await query('SELECT * FROM businesses WHERE id = ?', [req.params.id]);
    sendSuccess(res, result.rows[0], `Business ${status === 'ACTIVE' ? 'activated' : 'deactivated'} successfully`);
  } catch (error) {
    next(error);
  }
});

// DELETE /api/admin/businesses/:id
router.delete('/businesses/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await query('SELECT id FROM businesses WHERE id = ?', [req.params.id]);
    if (existing.rows.length === 0) {
      sendError(res, 'Business not found', 404);
      return;
    }
    
    // Soft delete - set status to INACTIVE
    await query('UPDATE businesses SET status = ?, updated_at = NOW() WHERE id = ?', ['INACTIVE', req.params.id]);
    sendSuccess(res, null, 'Business deactivated successfully');
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/businesses/:id/images
router.post('/businesses/:id/images', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { image_url, sort_order } = req.body;
    if (!image_url) {
      sendError(res, 'image_url is required', 400);
      return;
    }
    
    const existing = await query('SELECT id FROM businesses WHERE id = ?', [req.params.id]);
    if (existing.rows.length === 0) {
      sendError(res, 'Business not found', 404);
      return;
    }
    
    const insertResult = await query(
      'INSERT INTO business_images (business_id, image_url, sort_order) VALUES (?, ?, ?)',
      [req.params.id, image_url, sort_order || 0]
    );
    
    const result = await query('SELECT * FROM business_images WHERE id = ?', [insertResult.insertId]);
    sendSuccess(res, result.rows[0], 'Image added successfully', 201);
  } catch (error) {
    next(error);
  }
});

export default router;
