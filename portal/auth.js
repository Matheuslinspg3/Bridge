import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { queryOne } from './db.js';

const JWT_SECRET = process.env.PORTAL_JWT_SECRET || 'claudbridge-portal-secret-change-me';
const JWT_EXPIRES = '7d';

export const hashPassword = (plain) => bcrypt.hashSync(plain, 10);
export const comparePassword = (plain, hash) => bcrypt.compareSync(plain, hash);

export const createToken = (user) =>
  jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES });

export const verifyToken = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
};

// Middleware: exige auth do portal (cookie ou header)
export const requireAuth = (req, res, next) => {
  const token =
    req.cookies?.portal_token ||
    (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Token inválido' });
  const user = queryOne('SELECT * FROM users WHERE id = ? AND enabled = 1', [payload.id]);
  if (!user) return res.status(401).json({ error: 'Usuário não encontrado' });
  req.portalUser = user;
  next();
};
