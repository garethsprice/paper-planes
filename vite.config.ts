import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS via self-signed cert so navigator.mediaDevices (mic) is available
// over the LAN — browsers gate getUserMedia on a secure context.
// `base: './'` produces relative asset URLs in the build, so the app works
// when deployed to any subdirectory (e.g., GitHub Pages at /<repo>/).
export default defineConfig({
  base: './',
  plugins: [basicSsl()],
  // 'esnext' keeps top-level await available un-transpiled. All evergreen
  // browsers support it.
  build: { target: 'esnext' },
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
