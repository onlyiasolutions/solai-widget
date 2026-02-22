/**
 * Rate limit básico in-memory por IP
 * En producción considera usar Redis (express-rate-limit + store)
 */
const requests = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60_000; // 1 minuto
const MAX_REQUESTS = 60; // 60 requests por minuto por IP

export function rateLimiter(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction
) {
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  let record = requests.get(ip);

  if (!record) {
    record = { count: 1, resetAt: now + WINDOW_MS };
    requests.set(ip, record);
  } else if (now > record.resetAt) {
    record = { count: 1, resetAt: now + WINDOW_MS };
    requests.set(ip, record);
  } else {
    record.count++;
  }

  if (record.count > MAX_REQUESTS) {
    res.status(429).json({ error: "Too many requests" });
    return;
  }

  next();
}
