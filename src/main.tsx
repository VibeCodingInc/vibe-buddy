import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);

// Dev screenshot harness: real components, synthetic data, no Tauri backend.
// DEV-guarded dynamic import — the harness and its fixtures never reach a
// production bundle, so no synthetic state can masquerade as the live app.
if (import.meta.env.DEV && (new URLSearchParams(window.location.search).has('fixture') || new URLSearchParams(window.location.search).has('dm'))) {
  void import('./dev/Harness').then(({ default: Harness }) => {
    root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <Harness />
        </ErrorBoundary>
      </React.StrictMode>
    );
  });
} else {
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
}
