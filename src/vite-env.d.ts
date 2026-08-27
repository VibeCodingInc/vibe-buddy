/// <reference types="vite/client" />

interface ImportMetaEnv {
  // No build-time secrets or private Mind destinations: Buddy's native
  // boundary reads its runtime-local capability after launch.
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
