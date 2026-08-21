import React from 'react';
import { copyText } from '../lib/clipboard';
import {
  recordBreadcrumb,
  buildDiagnosticReport,
  formatDiagnosticReport,
  getLastDiagnosticsSnapshot,
} from '../lib/diagnostics';
import { loadUpdateCheck, loadUpdateFailureEvidence } from '../lib/updater';
import { SUPPORT_EMAIL } from '../lib/support';

interface State {
  hasError: boolean;
  error: Error | null;
  copied: 'idle' | 'copied' | 'failed';
}

export default class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { hasError: false, error: null, copied: 'idle' };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, copied: 'idle' };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack);
    // Keep the crash in the breadcrumb ring so the report below carries it even
    // though the app tree — and its own report panel — just unmounted. The ring
    // is module-level and survives.
    recordBreadcrumb('error', `crash: ${error.message}`);
  }

  // A crash unmounts App, taking its Report a Problem panel with it — so the
  // one screen a user is guaranteed to see when Buddy breaks hardest carries
  // its own report (G6). No content, same as every other report.
  //
  // Prefer the last snapshot the live app published (real handle/version/sync
  // as of just before the crash). Only when none exists — a crash before the
  // first sync — fall back to explicit unknowns (stateKnown:false), never
  // nulls that would read as "signed out / never synced" (codex re-review).
  private copyReport = () => {
    const snapshot = getLastDiagnosticsSnapshot();
    const report = buildDiagnosticReport(
      snapshot ?? {
        handle: null,
        appVersion: 'unknown',
        os: 'unknown',
        lastSyncSuccessAt: null,
        liveConnected: null,
        lastUpdateCheck: (() => {
          const uc = loadUpdateCheck();
          return uc ? { at: uc.at, outcome: uc.outcome, currentVersion: uc.currentVersion } : null;
        })(),
        lastUpdateFailure: (() => {
          const uf = loadUpdateFailureEvidence();
          return uf ? { id: uf.id, at: uf.at, phase: uf.phase, error: uf.error } : null;
        })(),
        mcpInstalled: null,
        stateKnown: false,
      },
    );
    void copyText(formatDiagnosticReport(report)).then((ok) =>
      this.setState({ copied: ok ? 'copied' : 'failed' }),
    );
  };

  render() {
    if (this.state.hasError) {
      const copyLabel =
        this.state.copied === 'copied'
          ? 'copied — email it to ' + SUPPORT_EMAIL
          : this.state.copied === 'failed'
            ? 'copy failed'
            : 'copy problem report';
      return (
        <div style={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0a0a0a',
          color: '#ef4444',
          padding: '20px',
          gap: '12px',
          textAlign: 'center',
        }}>
          <div style={{ fontSize: '14px', fontWeight: 600 }}>Something went wrong</div>
          <div style={{ fontSize: '11px', color: '#888', maxWidth: '260px' }}>
            {this.state.error?.message || 'Unknown error'}
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' }}>
            <button
              onClick={() => this.setState({ hasError: false, error: null, copied: 'idle' })}
              style={{
                background: '#333',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                padding: '6px 16px',
                fontSize: '12px',
                cursor: 'pointer',
                marginTop: '4px',
              }}
            >
              Try again
            </button>
            <button
              onClick={this.copyReport}
              style={{
                background: 'transparent',
                color: '#9CA3AF',
                border: '1px solid #1F2937',
                borderRadius: '6px',
                padding: '6px 16px',
                fontSize: '12px',
                cursor: 'pointer',
                marginTop: '4px',
              }}
            >
              {copyLabel}
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
