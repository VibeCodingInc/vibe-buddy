import { useState } from 'react';
import { open } from '@tauri-apps/plugin-shell';
import { buddyClient } from '../../lib/vibeClient';
import { copyText } from '../../lib/clipboard';
import { color } from '../../lib/tokens';

/**
 * The invitation ritual (#320): every invitation carries a thought, and may
 * name the ONE person it is for. The thought is the inviter's EXACT prose —
 * it materializes as their first message when the invitation is redeemed, so
 * this composer sends nothing and promises nothing beyond what the server
 * accepted.
 *
 * The refusal that matters is `principal_required`: a session that proves a
 * handle but not a principal cannot authorize a delayed send. That refusal
 * arrives STRUCTURED, and it renders here as its action — one button that
 * opens the reauth URL — never as a raw error string.
 */
export function ThoughtInvite({ onClose }: { onClose: () => void }) {
  const [thought, setThought] = useState('');
  const [forGithub, setForGithub] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<
    | { kind: 'created'; shareUrl: string; carriesThought: boolean; copied: boolean }
    | { kind: 'principal_required'; label: string; url: string; hint: string }
    | { kind: 'refused'; error: string }
    | { kind: 'unreachable' }
    | null
  >(null);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setOutcome(null);
    const res = await buddyClient.createThoughtInvite(thought, forGithub);
    if (res.kind === 'created') {
      const copied = await copyText(res.shareUrl);
      setOutcome({ ...res, copied });
    } else {
      setOutcome(res);
    }
    setBusy(false);
  };

  const label = { fontSize: '10px', color: color.faint, letterSpacing: '0.04em' } as const;
  const field = {
    width: '100%',
    background: color.bg,
    color: color.ink,
    border: `1px solid ${color.panel}`,
    borderRadius: '6px',
    padding: '6px 8px',
    fontSize: '12px',
    fontFamily: 'inherit',
    outline: 'none',
    boxSizing: 'border-box',
  } as const;

  return (
    <div style={{ padding: '10px 14px', borderBottom: `1px solid ${color.panel}`, flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: '12px', fontWeight: 600 }}>Invite with a thought</span>
        <span style={{ ...label }}>your exact words, waiting where they arrive</span>
        <button
          type="button"
          aria-label="Close invitation composer"
          onClick={onClose}
          style={{ marginLeft: 'auto', background: 'transparent', border: 0, color: color.faint, cursor: 'pointer', font: 'inherit' }}
        >
          ✕
        </button>
      </div>

      <div style={{ ...label, marginBottom: 2 }}>THE THOUGHT — lands verbatim as your first message</div>
      <textarea
        value={thought}
        onChange={(e) => setThought(e.target.value)}
        rows={3}
        placeholder="the real question that needs this specific mind…"
        style={{ ...field, resize: 'vertical', marginBottom: 8 }}
      />

      <div style={{ ...label, marginBottom: 2 }}>WHO IS THIS FOR? — GitHub username, nontransferable (optional)</div>
      <input
        value={forGithub}
        onChange={(e) => setForGithub(e.target.value)}
        placeholder="their-github-login"
        style={{ ...field, marginBottom: 8 }}
      />

      <button
        type="button"
        onClick={create}
        disabled={busy}
        style={{
          background: color.blue,
          color: color.ink,
          border: 'none',
          borderRadius: '6px',
          padding: '6px 14px',
          fontSize: '12px',
          fontWeight: 600,
          cursor: busy ? 'default' : 'pointer',
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? 'Creating…' : 'Create invitation'}
      </button>

      {outcome?.kind === 'created' && (
        <div style={{ marginTop: 8, fontSize: '11px', color: color.dim }}>
          {outcome.copied ? 'Link copied. ' : ''}
          {outcome.carriesThought
            ? 'It carries your thought — they land inside it.'
            : 'Created without the thought (none accepted).'}
          <div style={{ color: color.faint, wordBreak: 'break-all', marginTop: 2 }}>
            {outcome.shareUrl.replace(/^https?:\/\//, '')}
          </div>
        </div>
      )}

      {outcome?.kind === 'principal_required' && (
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            onClick={() => { void open(outcome.url); }}
            style={{
              background: color.panel,
              color: color.ink,
              border: `1px solid ${color.blue}`,
              borderRadius: '6px',
              padding: '6px 14px',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {outcome.label}
          </button>
          <div style={{ fontSize: '10.5px', color: color.faint, marginTop: 4 }}>
            {outcome.hint} Then create the invitation again.
          </div>
        </div>
      )}

      {outcome?.kind === 'refused' && (
        <div style={{ marginTop: 8, fontSize: '11px', color: color.dim }}>{outcome.error}</div>
      )}
      {outcome?.kind === 'unreachable' && (
        <div style={{ marginTop: 8, fontSize: '11px', color: color.faint }}>
          The invitations service didn’t answer. Nothing was created.
        </div>
      )}
    </div>
  );
}
