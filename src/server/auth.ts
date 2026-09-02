import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';

/**
 * Optional HTTP Basic auth for the dashboard.
 *
 * Locally the port is bound to loopback, so this is unnecessary. On a PaaS like
 * Render the service URL is public, and the dashboard exposes task contents and
 * can trigger sends — so a password is required there, not optional.
 */
export function basicAuth(password: string) {
  const expected = Buffer.from(password);

  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization ?? '';
    const [scheme, encoded] = header.split(' ');

    if (scheme === 'Basic' && encoded) {
      const supplied = Buffer.from(Buffer.from(encoded, 'base64').toString('utf8').split(':').slice(1).join(':'));
      // Constant-time so a wrong password cannot be guessed a character at a time.
      if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) {
        next();
        return;
      }
    }

    res.set('WWW-Authenticate', 'Basic realm="Task Reminder", charset="UTF-8"');
    res.status(401).send('Authentication required');
  };
}
