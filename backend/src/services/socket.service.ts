import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { logger } from '../utils/logger';
import { verifyAccessToken } from '../utils/jwt';
import { query } from '../config/database';

/** Roles that may watch any order, because their job is the order pipeline. */
const STAFF_ROLES = new Set(['SORTER', 'ADMIN', 'MANAGER', 'SUPER_ADMIN']);

type AuthedSocket = Socket & { userId?: string; userRole?: string };

class SocketService {
  private io: Server | null = null;

  initialize(httpServer: HttpServer): void {
    this.io = new Server(httpServer, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
      pingTimeout: 60000,
      pingInterval: 25000,
    });

    // Authentication middleware
    this.io.use(async (socket, next) => {
      try {
        const token =
          socket.handshake.auth?.token ||
          (socket.handshake.query?.token as string | undefined);
        if (token && typeof token === 'string') {
          const decoded = verifyAccessToken(token);
          (socket as AuthedSocket).userId = decoded.id;
          (socket as AuthedSocket).userRole = decoded.role;
        }
        next();
      } catch (_error) {
        // Allow unauthenticated connections but they won't join rooms
        next();
      }
    });

    this.io.on('connection', (socket: Socket) => {
      const userId = (socket as AuthedSocket).userId;
      const userRole = (socket as AuthedSocket).userRole;
      logger.info(
        `[Socket] Client connected: ${socket.id}${userId ? ` (user: ${userId}, ${userRole})` : ''}`
      );

      // Auto-join user's personal room for notifications
      if (userId) {
        socket.join(`user:${userId}`);
      }

      /*
       * RIDERS ALSO JOIN A ROLE ROOM.
       *
       * Dispatch addresses a specific rider by `user:<id>`, but two things go
       * to riders as a group: the advisory that an order has just been placed
       * nearby, and the "this job is gone" that clears a card from every
       * phone that was offered it. Without a shared room those would each be
       * a loop over sockets.
       */
      if (userId && userRole === 'RIDER') {
        socket.join('riders');
        socket.join(`rider:${userId}`);
      }

      // Join order room (with access verification)
      socket.on('join-order', async (data: { orderId: string }) => {
        try {
          if (!userId) {
            socket.emit('error', { message: 'Authentication required' });
            return;
          }
          if (!data?.orderId) {
            socket.emit('error', { message: 'orderId is required' });
            return;
          }

          const allowed = await this.canWatchOrder(String(data.orderId), userId, userRole);
          if (!allowed) {
            socket.emit('error', { message: 'Order not found or access denied' });
            return;
          }

          socket.join(`order:${data.orderId}`);
          logger.debug(`[Socket] User ${userId} joined order room: ${data.orderId}`);
          socket.emit('joined-order', { orderId: data.orderId });
        } catch (error) {
          logger.error('[Socket] Error joining order room:', error);
          socket.emit('error', { message: 'Failed to join order room' });
        }
      });

      // Leave order room
      socket.on('leave-order', (data: { orderId: string }) => {
        if (data?.orderId) {
          socket.leave(`order:${data.orderId}`);
          logger.debug(`[Socket] Client ${socket.id} left order room: ${data.orderId}`);
        }
      });

      socket.on('disconnect', (reason: string) => {
        logger.info(`[Socket] Client disconnected: ${socket.id} (${reason})`);
      });
    });

    logger.info('[Socket] Socket.IO initialized');
  }

  /**
   * May this user watch this order?
   *
   * The previous version asked `WHERE id = $1 AND user_id = $2` — Postgres
   * placeholders against a MySQL pool, so it threw on every call and no client
   * ever joined an order room. Beyond the syntax it was also too narrow: it
   * recognised only the customer who placed the order, so a BUSINESS order
   * (which hangs off `business_user_id`, not `user_id`) could never be
   * watched by the establishment that placed it, and the assigned rider —
   * whose live position is the whole point of the room — was refused too.
   */
  private async canWatchOrder(
    orderId: string,
    userId: string,
    userRole?: string
  ): Promise<boolean> {
    if (userRole && STAFF_ROLES.has(userRole)) {
      const exists = await query<{ id: string }>('SELECT id FROM orders WHERE id = ? LIMIT 1', [
        orderId,
      ]);
      return exists.rows.length > 0;
    }

    const result = await query<{ id: string }>(
      `SELECT o.id
         FROM orders o
         LEFT JOIN business_users bu ON bu.id = o.business_user_id
         LEFT JOIN rider_jobs rj ON rj.order_id = o.id AND rj.rider_id = ?
        WHERE o.id = ?
          AND (o.user_id = ? OR bu.id = ? OR rj.id IS NOT NULL)
        LIMIT 1`,
      [userId, orderId, userId, userId]
    );
    return result.rows.length > 0;
  }

  emitOrderStatusUpdate(orderId: string, payload: object): void {
    if (!this.io) {
      logger.warn('[Socket] Socket.IO not initialized, skipping order status emit');
      return;
    }
    this.io.to(`order:${orderId}`).emit('order:status', payload);
    logger.debug(`[Socket] Emitted order:status to order:${orderId}`);
  }

  emitProductionStatusUpdate(orderId: string, payload: object): void {
    if (!this.io) {
      logger.warn('[Socket] Socket.IO not initialized, skipping production status emit');
      return;
    }
    this.io.to(`order:${orderId}`).emit('production:status', payload);
    logger.debug(`[Socket] Emitted production:status to order:${orderId}`);
  }

  emitNotification(userId: string, payload: object): void {
    if (!this.io) {
      logger.warn('[Socket] Socket.IO not initialized, skipping notification emit');
      return;
    }
    this.io.to(`user:${userId}`).emit('notification', payload);
    logger.debug(`[Socket] Emitted notification to user:${userId}`);
  }

  /**
   * A job offer landing on one rider's phone.
   *
   * Separate from `emitNotification` because the app treats it differently:
   * a notification goes to the bell, an offer opens a card with a countdown.
   */
  emitJobOffer(riderId: string, payload: object): void {
    if (!this.io) return;
    this.io.to(`rider:${riderId}`).emit('rider:job-offer', payload);
    logger.debug(`[Socket] Emitted rider:job-offer to rider:${riderId}`);
  }

  /**
   * Clears an offer card from every rider who was shown it.
   *
   * Sent to all riders rather than to the losers individually: the payload
   * carries the job id, and a rider whose card is already gone ignores it.
   */
  emitJobTaken(jobId: string, payload: object): void {
    if (!this.io) return;
    this.io.to('riders').emit('rider:job-taken', { jobId, ...payload });
    logger.debug(`[Socket] Emitted rider:job-taken for job ${jobId}`);
  }

  /** The advisory that an order has been placed near a rider. */
  emitRiderAdvisory(riderId: string, payload: object): void {
    if (!this.io) return;
    this.io.to(`rider:${riderId}`).emit('rider:nearby-order', payload);
  }

  /** The rider's live position, for whoever is watching the order. */
  emitRiderLocation(orderId: string, payload: object): void {
    if (!this.io) return;
    this.io.to(`order:${orderId}`).emit('rider:location', payload);
  }

  /** A rider job changed state — the customer's tracking screen redraws. */
  emitJobUpdate(orderId: string, payload: object): void {
    if (!this.io) return;
    this.io.to(`order:${orderId}`).emit('rider:job-update', payload);
  }

  getIO(): Server | null {
    return this.io;
  }
}

const socketService = new SocketService();
export default socketService;
