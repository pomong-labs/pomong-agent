/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        pomong: {
          pink: '#FFB7CA',
          purple: '#D2B4FF',
          blue: '#BBE6FF',
          cream: '#FFDFB3',
          mint: '#BCF4DE',
          ink: '#2A2A35',
          sub: '#8A8A9A',
          line: '#EFEEF5',
          bg: '#FBFBFD',
          primary: '#8B72F8',
          primaryDeep: '#7C63F6',
          lavender: '#F1ECFF',
        },
      },
      fontFamily: {
        sans: ['"Spoqa Han Sans Neo"', '"Apple SD Gothic Neo"', 'system-ui', '-apple-system', 'sans-serif'],
      },
      borderRadius: { '4xl': '28px', '5xl': '34px' },
      boxShadow: {
        soft: '0 18px 50px rgba(90, 80, 160, 0.08)',
        card: '0 10px 30px rgba(90, 80, 160, 0.07)',
        float: '0 12px 32px rgba(124, 99, 246, 0.18)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        float: {
          '0%,100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-8px)' },
        },
        pop: {
          '0%': { transform: 'scale(.94)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
      },
      animation: {
        'fade-up': 'fade-up .45s cubic-bezier(.22,1,.36,1) both',
        float: 'float 4.5s ease-in-out infinite',
        pop: 'pop .28s cubic-bezier(.22,1,.36,1) both',
      },
    },
  },
  plugins: [],
};
