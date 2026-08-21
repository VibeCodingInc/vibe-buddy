// G6 — the report-a-problem surface.
//
// The consent boundary made visible: the user sees the ENTIRE report — every
// line, including the "does not include" promise — before any button can send
// it. No summary standing in for the contents, because the whole reason this
// exists is that a quiet app must be trustworthy about what it says about you.
//
// Two ways out, both under the user's hand: copy the text (paste it wherever
// they like), or open a prefilled email to support (their mail client still
// requires Send). Nothing leaves Buddy on its own.

import { useState, useRef, useEffect } from 'react';
import { open } from '@tauri-apps/plugin-shell';
import { color, font, size, space, radius } from '../lib/tokens';
import { copyText } from '../lib/clipboard';
import {
  buildDiagnosticReport,
  formatDiagnosticReport,
  type DiagnosticsInput,
} from '../lib/diagnostics';
import { buildSupportMailto, SUPPORT_EMAIL } from '../lib/support';

export function ReportProblem({
  input,
  onClose,
}: {
  input: DiagnosticsInput;
  onClose: () => void;
}) {
  // Built ONCE, on mount, from the snapshot the opener captured — so the text
  // the user reads is exactly the text the buttons act on, even though the app
  // keeps polling and re-rendering underneath (codex G6 P2). Later `input`
  // changes are deliberately ignored; a new report means reopening the panel.
  const [{ report, text }] = useState(() => {
    const report = buildDiagnosticReport(input);
    return { report, text: formatDiagnosticReport(report) };
  });

  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copyLabel =
    copyState === 'copied' ? 'copied' : copyState === 'failed' ? 'copy failed' : 'copy report';

  const [mailState, setMailState] = useState<'idle' | 'failed'>('idle');
  const emailLabel = mailState === 'failed' ? 'copy instead — mail app blocked' : 'email to support';

  // A visual overlay isn't enough: the panel covers the list but leaves the
  // controls under it keyboard-active, so Enter could reach a focused DM
  // composer and send a hidden message (codex G6 re-review). Make it a real
  // modal — move focus in on mount, trap Tab inside, restore focus on close,
  // and let Escape close it.
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => previouslyFocused?.focus?.();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
      'button, [href], input, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables || focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // Open the prefilled mail draft through the shell API. window.open('_blank')
  // is denied in the shipped macOS webview (no new-window handler installed —
  // codex G6 re-review), so a button click would silently do nothing. If the
  // shell rejects too, fall back to copying, so the path is never a dead end.
  const emailSupport = () => {
    open(buildSupportMailto(report.id, text)).catch(() => {
      void copyText(text).then((ok) => {
        setMailState('failed');
        setCopyState(ok ? 'copied' : 'failed');
      });
    });
  };

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label="Report a problem"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{
        // fixed, not absolute: the panel must cover whatever branch the app is
        // rendering — signed-out, compact, or the list — since those are the
        // broken states people report from (codex G6 P1).
        position: 'fixed',
        inset: 0,
        background: color.bg,
        outline: 'none',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: font.mono,
        zIndex: 50,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: `${space[2]}px ${space[3]}px`,
          borderBottom: `1px solid ${color.line}`,
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: size[12], color: color.ink }}>report a problem</span>
        <button
          type="button"
          onClick={onClose}
          style={{
            background: 'transparent',
            border: 'none',
            color: color.dim,
            fontSize: size[12],
            cursor: 'pointer',
          }}
        >
          close
        </button>
      </div>

      <div style={{ padding: `${space[2]}px ${space[3]}px`, flexShrink: 0 }}>
        <span style={{ fontSize: size[11], color: color.dim, lineHeight: 1.5 }}>
          this is everything Buddy would send. read it, then copy it or email it to{' '}
          {SUPPORT_EMAIL}. nothing leaves until you do.
        </span>
      </div>

      <pre
        style={{
          flex: 1,
          overflow: 'auto',
          margin: 0,
          padding: `${space[2]}px ${space[3]}px`,
          background: color.panel,
          borderTop: `1px solid ${color.line}`,
          borderBottom: `1px solid ${color.line}`,
          color: color.ink,
          fontSize: size[11],
          fontFamily: font.mono,
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          lineHeight: 1.5,
        }}
      >
        {text}
      </pre>

      <div
        style={{
          display: 'flex',
          gap: space[1],
          padding: `${space[2]}px ${space[3]}px`,
          flexShrink: 0,
          flexWrap: 'wrap',
          justifyContent: 'flex-end',
        }}
      >
        <button
          type="button"
          onClick={() => {
            void copyText(text).then((ok) => setCopyState(ok ? 'copied' : 'failed'));
          }}
          style={btnStyle(false)}
        >
          {copyLabel}
        </button>
        <button type="button" onClick={emailSupport} style={btnStyle(true)}>
          {emailLabel}
        </button>
      </div>
    </div>
  );
}

function btnStyle(primary: boolean) {
  return {
    background: primary ? color.blue : 'transparent',
    border: `1px solid ${primary ? color.blue : color.line}`,
    borderRadius: radius.sm,
    padding: `${space[1]}px ${space[3]}px`,
    color: primary ? color.bg : color.dim,
    fontSize: size[11],
    fontFamily: font.mono,
    cursor: 'pointer',
  } as const;
}
