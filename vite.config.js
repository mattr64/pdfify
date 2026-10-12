import { defineConfig } from 'vite';

export default defineConfig({
  build: { target: 'esnext' }, // pdf.js uses modern JS; every browser from 2024 on is fine
});
