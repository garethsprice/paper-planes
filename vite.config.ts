import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS via self-signed cert so navigator.mediaDevices (mic) is available
// over the LAN — browsers gate getUserMedia on a secure context.
// `base: './'` produces relative asset URLs in the build, so the app works
// when deployed to any subdirectory (e.g., GitHub Pages at /<repo>/).
export default defineConfig({
  base: './',
  plugins: [basicSsl()],
  server: {
    host: '0.0.0.0',
    // accept requests under any hostname (LAN, Tailscale, custom DNS, etc.)
    allowedHosts: true,
  },
});
