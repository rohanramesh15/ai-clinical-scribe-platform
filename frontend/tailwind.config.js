/** @type {import('tailwindcss').Config} */
// Clinical, dense, high-trust palette. Restrained color: slate neutrals,
// one clinical blue for primary, status colors reserved for state/red-flags.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        clinical: {
          bg: "#f4f6f8",
          surface: "#ffffff",
          border: "#d3d9e0",
          ink: "#1b2733",
          muted: "#5b6b7b",
          primary: "#1f5f8b",
          danger: "#b3261e",
          warn: "#9a6700",
          ok: "#1f7a4d",
        },
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
