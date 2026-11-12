import type { Config } from "tailwindcss";

export default {
	content: ["./index.html", "./src/**/*.{ts,tsx}"],
	theme: {
		extend: {
			colors: { canvas: "#0b1020" },
			boxShadow: { panel: "0 1px 0 rgba(148, 163, 184, 0.04), 0 12px 32px -18px rgba(2, 6, 23, 0.8)" },
		},
	},
	plugins: [],
} satisfies Config;
