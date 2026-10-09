import { defineConfig } from 'vite';

// The game server (npm run server) runs the online rooms and the account API; in dev the page
// reaches it through this proxy, so the client always talks to /ws and /api on its own origin
// (LAN included, and the login cookie stays first-party).
export default defineConfig({
  server: {
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
      '/api': { target: 'http://localhost:8787' },
    },
  },
});
