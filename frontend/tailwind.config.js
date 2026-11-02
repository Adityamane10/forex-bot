/** @type {import('tailwindcss').Config} */

/**
 * FX Intel design tokens — "Instrument".
 *
 * Principle: chrome is achromatic, chroma is data. Every structural surface,
 * border, label and control is a warm neutral; saturated colour is reserved for
 * money (gain/loss), direction (long/short) and risk state. That way a green or
 * red pixel on screen always means something.
 *
 * The `slate`, `blue`, `yellow`, `orange` and `violet` ramps are deliberately
 * REMAPPED rather than replaced with new token names, so the existing views
 * inherit the new identity without a single class name changing.
 *   slate  -> "ash"  warm neutral text/surface ramp
 *   blue   -> "bone" achromatic interactive accent (no hue)
 *   yellow -> folded into the amber caution family
 *   orange -> warm ember
 *   violet -> muted lilac (India section accent)
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // ── Ground: warm ink, four layers of depth ────────────────────────
        bg: '#0A0A09',
        panel: '#111110',
        panel2: '#171716',
        border: '#262521',
        hairline: '#33322C',

        // Semantic aliases (data-bearing)
        accent: '#D5D1C4',
        up: '#34D6A0',
        down: '#FF6B5E',
        warn: '#F7B23F',

        // ── Text + surfaces: warm neutral "ash" ───────────────────────────
        // 500 clears 4.5:1 on the panel ground and 600 clears 3.4:1, because
        // both carry real captions and table cells, not just decoration.
        // 700/800 are surface and border tones, so they stay dark.
        slate: {
          50: '#FBFAF7',
          100: '#F1EFE9',
          200: '#DDDAD1',
          300: '#BFBCB1',
          400: '#96938A',
          500: '#807D75',
          600: '#6B6862',
          700: '#47453E',
          800: '#2C2B24',
          900: '#171716',
          950: '#0A0A09',
        },

        // ── Interactive accent: "bone". Intentionally hue-free. ───────────
        // 600 stays dark enough that the existing `text-white` buttons keep
        // a comfortable contrast ratio.
        blue: {
          50: '#FAF9F6',
          100: '#F2F0EA',
          200: '#EAE7DD',
          300: '#D5D1C4',
          400: '#ADA898',
          500: '#7D7869',
          600: '#55524A',
          700: '#403E38',
          800: '#2E2D28',
          900: '#20201C',
          950: '#141410',
        },

        // ── Data chroma: gain / long ──────────────────────────────────────
        emerald: {
          50: '#E8FDF5',
          100: '#C6F8E5',
          200: '#9CF2D2',
          300: '#7FE9C3',
          400: '#34D6A0',
          500: '#14BE87',
          600: '#0E9E71',
          700: '#0B7D5A',
          800: '#0A5F46',
          900: '#084B38',
          950: '#032a20',
        },
        green: {
          50: '#E8FDF5',
          100: '#C6F8E5',
          200: '#9CF2D2',
          300: '#7FE9C3',
          400: '#34D6A0',
          500: '#14BE87',
          600: '#0E9E71',
          700: '#0B7D5A',
          800: '#0A5F46',
          900: '#084B38',
          950: '#032a20',
        },

        // ── Data chroma: loss / short ─────────────────────────────────────
        red: {
          50: '#FFF0EE',
          100: '#FFDCD8',
          200: '#FFBDB6',
          300: '#FFA39B',
          400: '#FF6B5E',
          500: '#F2453B',
          600: '#D82F26',
          700: '#B0231C',
          800: '#8A1D17',
          900: '#6B1813',
          950: '#3d0c09',
        },

        // ── Data chroma: caution / pending / live ─────────────────────────
        amber: {
          50: '#FFF8EA',
          100: '#FDECC8',
          200: '#FCDF9F',
          300: '#FBD07A',
          400: '#F7B23F',
          500: '#E89A19',
          600: '#C67D0B',
          700: '#9C6109',
          800: '#7A4C0B',
          900: '#603C0B',
          950: '#382204',
        },
        yellow: {
          50: '#FFF8EA',
          100: '#FDECC8',
          200: '#FCDF9F',
          300: '#FBD07A',
          400: '#F7B23F',
          500: '#E89A19',
          600: '#C67D0B',
          700: '#9C6109',
          800: '#7A4C0B',
          900: '#603C0B',
          950: '#382204',
        },
        orange: {
          50: '#FFF4EC',
          100: '#FFE3D0',
          200: '#FFC5A3',
          300: '#FFA974',
          400: '#FB8A47',
          500: '#EA6F27',
          600: '#C85718',
          700: '#A04413',
          800: '#7C3612',
          900: '#622C11',
          950: '#371606',
        },

        // ── India section accent: muted lilac ─────────────────────────────
        violet: {
          50: '#F6F4FA',
          100: '#EAE6F3',
          200: '#D8D1E8',
          300: '#B9AECF',
          400: '#9A8CB8',
          500: '#8E82A8',
          600: '#6E6389',
          700: '#564D6C',
          800: '#3F3950',
          900: '#2C2839',
          950: '#1A1723',
        },
      },

      fontFamily: {
        sans: ['"Instrument Sans"', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },

      fontSize: {
        // Micro label used for eyebrows and table headers.
        micro: ['10px', { lineHeight: '1.4', letterSpacing: '0.09em' }],
      },

      letterSpacing: {
        eyebrow: '0.09em',
        numeric: '-0.01em',
      },

      borderRadius: {
        DEFAULT: '5px',
        md: '6px',
        lg: '8px',
        xl: '11px',
      },

      boxShadow: {
        // Depth without a visible drop shadow: a hairline top highlight, the way
        // light catches the top edge of a machined panel.
        panel: 'inset 0 1px 0 0 rgba(255,255,255,0.035)',
        raised: 'inset 0 1px 0 0 rgba(255,255,255,0.05), 0 1px 2px 0 rgba(0,0,0,0.5)',
        lit: 'inset 0 1px 0 0 rgba(255,255,255,0.06), 0 0 0 1px rgba(213,209,196,0.10)',
        // Interactive lift: the panel comes toward you a half-step on hover.
        lift: 'inset 0 1px 0 0 rgba(255,255,255,0.06), 0 2px 8px -2px rgba(0,0,0,0.55), 0 0 0 1px rgba(51,50,44,0.9)',
        // Data glows — reserved for live/positive/negative states, never chrome.
        'glow-up': '0 0 12px -2px rgba(52,214,160,0.35), inset 0 1px 0 0 rgba(255,255,255,0.05)',
        'glow-down': '0 0 12px -2px rgba(255,107,94,0.30), inset 0 1px 0 0 rgba(255,255,255,0.05)',
        'glow-live': '0 0 14px -3px rgba(213,209,196,0.28), inset 0 1px 0 0 rgba(255,255,255,0.05)',
      },

      backgroundImage: {
        // Ambient light: one cool key light above the work surface and a faint
        // warm bounce from below the fold. Both are near-invisible alone; together
        // they keep the ink ground from reading as flat black.
        ambient: 'radial-gradient(1100px 480px at 38% -6%, rgba(213,209,196,0.055), transparent 62%), radial-gradient(900px 520px at 88% 112%, rgba(142,130,168,0.045), transparent 60%)',
        // A machined top edge for hero panels.
        edge: 'linear-gradient(to bottom, rgba(255,255,255,0.05), rgba(255,255,255,0) 22%)',
        // Sweep used by the .sheen hover treatment.
        sheen: 'linear-gradient(105deg, transparent 40%, rgba(255,255,255,0.045) 48%, rgba(255,255,255,0.07) 50%, rgba(255,255,255,0.045) 52%, transparent 60%)',
      },

      keyframes: {
        'flash-up': {
          '0%': { backgroundColor: 'rgba(52,214,160,0.20)' },
          '100%': { backgroundColor: 'transparent' },
        },
        'flash-down': {
          '0%': { backgroundColor: 'rgba(255,107,94,0.20)' },
          '100%': { backgroundColor: 'transparent' },
        },
        'flash-down': {
          '0%': { backgroundColor: 'rgba(255,107,94,0.20)' },
          '100%': { backgroundColor: 'transparent' },
        },
        breathe: {
          '0%, 100%': { opacity: '0.35' },
          '50%': { opacity: '1' },
        },
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(3px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        // A live indicator that reads as a heartbeat, not a spinner: the dot
        // holds steady while a ring expands and fades off it.
        'ping-ring': {
          '0%': { transform: 'scale(1)', opacity: '0.55' },
          '80%, 100%': { transform: 'scale(2.6)', opacity: '0' },
        },
        // The sheen sweep across a panel on hover.
        shimmer: {
          '0%': { backgroundPosition: '-180% 0' },
          '100%': { backgroundPosition: '280% 0' },
        },
        // Iris opening — brand mark boot moment.
        iris: {
          '0%': { transform: 'scale(0.4)', opacity: '0' },
          '60%': { opacity: '1' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
      },

      animation: {
        'flash-up': 'flash-up 500ms ease-out',
        'flash-down': 'flash-down 500ms ease-out',
        breathe: 'breathe 1.6s ease-in-out infinite',
        'slide-up': 'slide-up 180ms ease-out',
        'ping-ring': 'ping-ring 2.2s cubic-bezier(0, 0, 0.2, 1) infinite',
        shimmer: 'shimmer 900ms ease-in-out',
        iris: 'iris 700ms cubic-bezier(0.2, 0.9, 0.3, 1) both',
      },
    },
  },
  plugins: [],
};
