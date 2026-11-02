// Sign a short-lived audit JWT using the backend's own env (secret never printed).
import dotenv from 'dotenv';
dotenv.config({ path: 'backend/.env' });
import jwt from 'jsonwebtoken';

const secret = process.env.JWT_SECRET || 'dev-only-secret-change-me';
const token = jwt.sign(
  { user: { id: 'audit', email: 'audit@local', role: 'USER', createdAt: 0 } },
  secret,
  { expiresIn: '10m' },
);
console.log(token);
