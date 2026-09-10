import http from 'http';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import { config } from './config/env';
import { pool } from './config/database';
import { logger } from './utils/logger';
import { rateLimiter } from './middleware/rateLimiter';
import { errorHandler } from './middleware/errorHandler';
import socketService from './services/socket.service';

// Routes
import authRoutes from './routes/auth.routes';
import cartRoutes from './routes/cart.routes';
import serviceRoutes from './routes/service.routes';
import addressRoutes from './routes/address.routes';
import orderRoutes from './routes/order.routes';
import customerRoutes from './routes/customer.routes';
import businessRoutes from './routes/business.routes';
import businessOrderingRoutes from './routes/businessOrdering.routes';
import businessPublicRoutes from './routes/businessPublic.routes';
import sorterRoutes from './routes/sorter.routes';
import locationRoutes from './routes/location.routes';
import chatRoutes from './routes/chat.routes';
import superAdminRoutes from './routes/superAdmin.routes';
import managerRoutes from './routes/manager.routes';
import { UPLOAD_ROOT, UPLOAD_URL_PREFIX } from './utils/fileStorage';
import adminRoutes from './routes/admin.routes';
import riderRoutes from './routes/rider.routes';
import ticketRoutes from './routes/ticket.routes';
import pushRoutes from './routes/push.routes';

const app = express();
const server = http.createServer(app);

// Initialize Socket.IO
socketService.initialize(server);

/**
 * HOW MANY PROXIES ARE IN FRONT OF US.
 *
 * `req.ip` is what the rate limiter buckets by. Behind a reverse proxy,
 * a load balancer or a PaaS router, the socket address is the PROXY's for
 * every request -- so without this the whole userbase shares ONE bucket and
 * the tenth customer in a quarter of an hour is locked out.
 *
 * Set from `TRUST_PROXY` rather than hardcoded, and OFF unless a deployment
 * says otherwise: trusting `X-Forwarded-For` with nothing in front lets any
 * caller spoof its IP and pick its own bucket. A COUNT OF HOPS, not `true`,
 * because `true` trusts the whole chain including whatever the client sent.
 */
const trustProxyHops = parseInt(config.TRUST_PROXY, 10);
if (Number.isFinite(trustProxyHops) && trustProxyHops > 0) {
  app.set('trust proxy', trustProxyHops);
  console.log(`[Server] Trusting ${trustProxyHops} proxy hop(s) for client IPs`);
}

// Middleware
app.use(helmet());
app.use(cors({ origin: config.CLIENT_URL || '*' }));
/**
 * JSON body parsing.
 *
 * Every route keeps the safe default limit (100kb). The one exception is the
 * defect-photo upload, which carries a base64 image and mounts its own parser
 * with a larger limit in sorter.routes.ts.
 *
 * That route has to be skipped HERE rather than simply layered, because this
 * parser runs first and would reject an oversized body with 413 long before
 * the route-level parser ever saw it.
 */
const jsonParser = express.json();
const DEFECT_PHOTO_PATH = /^\/api\/sorter\/orders\/[^/]+\/defect$/;
/**
 * The backdated walking-order upload, which carries a base64 spreadsheet.
 *
 * Same treatment and the same reason as the defect photo above: this parser
 * runs first and would reject the body with 413 long before the route's own
 * parser saw it, so the path is skipped HERE and parsed there.
 */
const WALKING_ORDER_PATH =
  /^\/api\/super-admin\/business-account\/[^/]+\/walking-orders\/(preview|import)$/;
/**
 * The Business Price List bulk price update, which carries a base64
 * spreadsheet. Same treatment and the same reason as the two above: this
 * parser runs first and would reject the body with 413 before the route's own
 * parser saw it, so the path is skipped HERE and parsed in
 * superAdminPrice.routes.ts.
 */
const PRICE_UPLOAD_PATH =
  /^\/api\/super-admin\/prices\/businesses\/[^/]+\/price-upload(\/preview)?$/;

app.use((req, res, next) => {
  if (
    req.method === 'POST' &&
    (DEFECT_PHOTO_PATH.test(req.path) ||
      WALKING_ORDER_PATH.test(req.path) ||
      PRICE_UPLOAD_PATH.test(req.path))
  ) {
    return next();
  }
  return jsonParser(req, res, next);
});

// Uploaded images (defect photos). Served read-only from disk so the database
// never holds image bytes; the tables store only these URLs.
app.use(UPLOAD_URL_PREFIX, express.static(UPLOAD_ROOT, { fallthrough: true, maxAge: '1d' }));
app.use(morgan(config.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(rateLimiter);

// Health Check
app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Swachham API is running',
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/addresses', addressRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/businesses/public', businessPublicRoutes);
app.use('/api/businesses', businessOrderingRoutes);
app.use('/api/businesses', businessRoutes);
app.use('/api/sorter', sorterRoutes);
app.use('/api/location', locationRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/super-admin', superAdminRoutes);
app.use('/api/manager', managerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/rider', riderRoutes);
// The one ticket router. Every role uses it; the service decides what each
// of them sees and may do. See routes/ticket.routes.ts.
app.use('/api/tickets', ticketRoutes);
// Device registration for push. Every signed-in role may register its own
// handset; the account is taken from the token, never from the body.
app.use('/api/push', pushRoutes);

// Error Handling Middleware
app.use(errorHandler);

const PORT = config.PORT || 5000;

server.listen(PORT, '0.0.0.0', () => {
  logger.info(`[Server] Server is running on http://0.0.0.0:${PORT}`);
  logger.info(`[Server] Environment: ${config.NODE_ENV}`);
});

// Graceful Shutdown
process.on('SIGINT', async () => {
  try {
    await pool.end();

    logger.info('Database pool closed');
    process.exit(0);
  } catch (error) {
    logger.error(
      `Error closing database pool: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`
    );

    process.exit(1);
  }
});

process.on('SIGTERM', async () => {
  try {
    await pool.end();

    logger.info('Database pool closed');
    process.exit(0);
  } catch (error) {
    logger.error(
      `Error closing database pool: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`
    );

    process.exit(1);
  }
});
