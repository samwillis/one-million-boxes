import { defineConfig } from "@neon/config/v1"

export default defineConfig({
  // Realtime is a preview service. Applying this policy enables it and sets the
  // exact browser origins used by local development and the deployed game.
  preview: {
    realtime: {
      allowedOrigins: [
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "https://one-million-boxes.vercel.app",
      ],
    },
  },
  branch: (branch) => (!branch.isDefault && !branch.exists ? { ttl: "7d" } : {}),
})
