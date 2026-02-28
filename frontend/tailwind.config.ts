import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50: "#faf5ff",
          100: "#f3e8ff",
          200: "#e9d5ff",
          300: "#d8b4fe",
          400: "#c084fc",
          500: "#a855f7",
          600: "#9333ea",
          700: "#7e22ce",
          800: "#6b21a8",
          900: "#581c87",
          950: "#3b0764",
        },
        accent: {
          green: "#22c55e",
          red: "#ef4444",
          yellow: "#eab308",
        },
        surface: {
          DEFAULT: "#0f0f14",
          card: "#1a1a24",
          hover: "#24243a",
          border: "#2e2e48",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        heading: ["Space Grotesk", "system-ui", "sans-serif"],
      },
      borderRadius: {
        "navbar": "0 0 16px 16px",
      },
    },
  },
  plugins: [],
};

export default config;
