/// <reference types="vite/client" />

interface ImportMetaEnv {
  // No build-time secrets.
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
