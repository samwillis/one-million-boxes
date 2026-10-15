import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    fs: {
      deny: [
        ".env",
        ".env.*",
        "*.{crt,pem}",
        "**/.git/**",
        "**/.local/**",
        "**/server/**",
        "**/scripts/**",
      ],
    },
    proxy: { "/api": `http://127.0.0.1:${process.env.API_PORT ?? "3001"}` },
  },
})
