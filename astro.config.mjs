import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  vite: {
    define: {
      'import.meta.env.PUBLIC_FIREBASE_API_KEY':     JSON.stringify(process.env.PUBLIC_FIREBASE_API_KEY    || ''),
      'import.meta.env.PUBLIC_FIREBASE_AUTH_DOMAIN': JSON.stringify(process.env.PUBLIC_FIREBASE_AUTH_DOMAIN || ''),
      'import.meta.env.PUBLIC_FIREBASE_PROJECT_ID':  JSON.stringify(process.env.PUBLIC_FIREBASE_PROJECT_ID  || ''),
    }
  }
});