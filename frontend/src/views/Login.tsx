import { useState } from 'react';
import { useDispatch } from 'react-redux';
import { actions } from '../store';
import { AuthApi, setToken } from '../api';

/** Aperture mark — the same lens iris used in the app shell. */
function Mark() {
  return (
    <svg width="22" height="22" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="8.25" stroke="#D5D1C4" strokeWidth="1.2" opacity="0.85" />
      <circle cx="10" cy="10" r="2.6" fill="#34D6A0" />
      <path d="M10 1.75V6M10 14v4.25M1.75 10H6M14 10h4.25" stroke="#D5D1C4" strokeWidth="1.2" opacity="0.5" />
    </svg>
  );
}

export function Login() {
  const dispatch = useDispatch();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = mode === 'login' ? await AuthApi.login(email, password) : await AuthApi.register(email, password);
      setToken(res.token);
      dispatch(actions.auth.setAuth({ token: res.token, email: res.user.email }));
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'auth failed');
    } finally {
      setLoading(false);
    }
  };

  const field = 'w-full rounded border border-border bg-panel2 px-3 py-2 text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-600 hover:border-hairline focus:border-blue-400';

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-5 py-10">
      <div className="w-full max-w-[360px]">
        {/* Identity sits above the form, so the panel holds nothing but the task. */}
        <div className="mb-6">
          <div className="flex items-center gap-3">
            <Mark />
            <span className="font-mono text-[15px] font-medium uppercase text-slate-100" style={{ letterSpacing: '0.19em' }}>
              FX Intel
            </span>
          </div>
          <p className="mt-3 max-w-[300px] text-[13px] leading-relaxed text-slate-400">
            Real-time forex intelligence, signal generation, backtesting and paper trading.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-panel shadow-panel">
          <div className="flex items-center justify-between px-5 pb-2.5 pt-4">
            <div className="eyebrow text-slate-400">{mode === 'login' ? 'Sign in' : 'Create account'}</div>
            <span className="font-mono text-[10px] text-slate-600" style={{ letterSpacing: '0.08em' }}>
              PAPER
            </span>
          </div>

          <div className="seam" />

          <div className="space-y-4 p-5">
            <div>
              <label htmlFor="login-email" className="eyebrow mb-1.5 block">
                Email
              </label>
              <input
                id="login-email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={field}
              />
            </div>

            <div>
              <label htmlFor="login-password" className="eyebrow mb-1.5 block">
                Password
              </label>
              <input
                id="login-password"
                type="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={field}
              />
              {/* Says why the button is disabled, instead of leaving it a mystery. */}
              <div className="mt-1.5 text-[11px] text-slate-600">Use at least 8 characters.</div>
            </div>

            {error && (
              <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300" role="alert">
                {error}
              </div>
            )}

            <button
              onClick={() => void submit()}
              disabled={loading || password.length < 8}
              className="w-full rounded bg-blue-600 py-2.5 text-sm font-medium text-white shadow-raised transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {loading ? 'Signing in…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>

            <button
              onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
              className="w-full text-center text-xs text-slate-500 transition-colors hover:text-slate-300"
            >
              {mode === 'login' ? 'Need an account? Register' : 'Have an account? Sign in'}
            </button>
          </div>
        </div>

        <p className="mt-5 text-[11px] leading-relaxed text-slate-600">
          Educational tool. Nothing here is financial advice and no prediction is ever guaranteed. Trades are simulated —
          no real money is placed.
        </p>
      </div>
    </div>
  );
}
