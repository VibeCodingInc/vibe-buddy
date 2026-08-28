import { useState } from 'react';
import { buddyClient, normalizeGithub, type ThoughtInviteResult } from '../../lib/vibeClient';
import { copyText } from '../../lib/clipboard';
import { color } from '../../lib/tokens';

/**
 * The invitation ritual (#320 + #322): a thought, FOR one person. Both halves
 * are required here — this surface never falls through to a generic or
 * thoughtless invitation (the plain tracked link lives elsewhere). The
 * thought travels byte-for-byte as typed.
 *
 * Success is the SERVED truth: carries_thought, named_for matching the
 * person named, and expires_at — displayed as who it is for and when it
 * lapses. Anything less renders as an honest incompletion.
 *
 * principal_required completes the REAL round trip: the existing native
 * OAuth authority runs, the refreshed credential lands in the local store,
 * the principal claim is verified, and only then does the create retry.
 */
export function ThoughtInvite({ onClose }: { onClose: () => void }) {
  const [thought, setThought] = useState('');
  const [forGithub, setForGithub] = useState('');
  const [busy, setBusy] = useState<false | 'creating' | 'reauth'>(false);
  const [outcome, setOutcome] = useState<(ThoughtInviteResult & { copied?: boolean }) | null>(null);

  const ready = Boolean(thought.trim()) && Boolean(normalizeGithub(forGithub));

  const create = async () => {
    if (busy || !ready) return;
    setBusy('creating');
    setOutcome(null);
    let res = await buddyClient.createThoughtInvite(thought, forGithub);
    if (res.kind === 'principal_required') {
      // The real round trip — native OAuth, credential stored locally,
      // principal VERIFIED from the token's own claim — then one retry.
      setOutcome(res);
      setBusy('reauth');
      const proved = await buddyClient.reauthorizePrincipal();
      if (proved) {
        res = await buddyClient.createThoughtInvite(thought, forGithub);
      } else {
        setBusy(false);
        setOutcome({
          kind: 'refused',
          error: 'The refreshed session still does not prove your principal. Nothing was created.',
        });
        return;
      }
    }
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

  const expiresLine = (iso: string) => {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

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

      <div style={{ ...label, marginBottom: 2 }}>WHO IS THIS FOR — GitHub username, nontransferable</div>
      <input
        value={forGithub}
        onChange={(e) => setForGithub(e.target.value)}
        placeholder="their-github-login"
        style={{ ...field, marginBottom: 8 }}
      />

      <button
        type="button"
        onClick={create}
        disabled={!!busy || !ready}
        title={ready ? undefined : 'This invitation needs both the thought and the person it is for.'}
        style={{
          background: color.blue,
          color: color.ink,
          border: 'none',
          borderRadius: '6px',
          padding: '6px 14px',
          fontSize: '12px',
          fontWeight: 600,
          cursor: busy || !ready ? 'default' : 'pointer',
          opacity: busy || !ready ? 0.6 : 1,
        }}
      >
        {busy === 'creating' ? 'Creating…' : busy === 'reauth' ? 'Refreshing your session…' : 'Create invitation'}
      </button>

      {outcome?.kind === 'created' && (
        <div style={{ marginTop: 8, fontSize: '11px', color: color.dim }}>
          {outcome.copied ? 'Copied. ' : ''}
          For @{outcome.namedFor} — carries your thought, lapses {expiresLine(outcome.expiresAt)}.
          <div style={{ color: color.faint, wordBreak: 'break-all', marginTop: 2 }}>
            {outcome.shareUrl.replace(/^https?:\/\//, '')}
          </div>
        </div>
      )}

      {outcome?.kind === 'principal_required' && busy === 'reauth' && (
        <div style={{ marginTop: 8, fontSize: '10.5px', color: color.faint }}>
          {outcome.hint} Finish signing in — the invitation will retry itself.
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
