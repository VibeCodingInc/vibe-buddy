// Dev-only screenshot harness for the REAL DMPanel — reached via ?dm=<state>.
// Renders the shipped component over synthetic messages so states can be
// captured at window size without a Tauri backend, network, or real
// identities. Tree-shaken from any production build (imported only by the
// DEV-gated Harness). Never ships.

import DMPanel from '../components/DMPanel';
import { buddyClient, type VibeMessage } from '../lib/vibeClient';
import { setCachedMessages } from '../lib/messageCache';
import { realtime } from '../lib/realtime';
import { color } from '../lib/tokens';

const ME = 'alice_demo';

const msg = (
  id: string, from: string, to: string, content: string, minsAgo: number,
  replyTo?: { id: string; from: string; text: string },
): VibeMessage => ({
  id, from, to, content,
  timestamp: new Date(Date.now() - minsAgo * 60_000).toISOString(),
  status: 'sent',
  ...(replyTo ? { replyTo } : {}),
});

const CHAT = 'vibetester1';

// The 3A shape: a focused INTENT question, then (later) a verbose unrelated
// question, then the answer. WITHOUT a needle the answer is ambiguous —
// which question did it answer? WITH the needle it names its thought.
const INTENT_Q = msg('m_intent', ME, CHAT,
  'DECISION: which story should lead once the four public surfaces pass?', 180);
const VERBOSE_Q = msg('m_verbose', ME, CHAT,
  'Separately — for the 0.8.18 launch note, should the version banner cite the signed build or the source head? Long one, no rush.', 20);
const ANSWER_BODY =
  'Lead with two doors, one conversation. "What we removed" already shipped as a public story, so leading with it again would make /vibe a confession brand. The sealed envelope is the soul; two doors is the headline.';

export const DM_FIXTURES: Record<string, VibeMessage[]> = {
  // BEFORE: the answer sits under the verbose question, no needle — the 3A
  // misattribution, live.
  'needle-before': [
    INTENT_Q,
    VERBOSE_Q,
    msg('m_answer', CHAT, ME, ANSWER_BODY, 8),
  ],
  // AFTER: the same answer carries the server-backed needle to the INTENT
  // question — it names the exact thought it belongs to.
  'needle-after': [
    INTENT_Q,
    VERBOSE_Q,
    msg('m_answer', CHAT, ME, ANSWER_BODY, 8, {
      id: 'm_intent', from: ME,
      text: 'DECISION: which story should lead once the four public surfaces pass?',
    }),
  ],
};

let stubbed = false;
function stub() {
  if (stubbed) return;
  stubbed = true;
  realtime.init = () => {};
  realtime.openDM = () => {};
  realtime.goBackground = () => {};
  realtime.setTypingCallback = () => {};
  realtime.setMessageEvidenceCallback = () => {};
  realtime.hasMessageEvidenceFrom = () => false;
  buddyClient.sendMessageResult = async () => ({ ok: true });
  buddyClient.sendTypingIndicator = async () => {};
}

export default function DMHarness({ state, width, height }: { state: string; width: number; height: number }) {
  const messages = DM_FIXTURES[state];
  if (!messages) {
    return (
      <div style={{ color: color.dim, fontFamily: 'monospace', padding: 24 }}>
        unknown dm state — one of: {Object.keys(DM_FIXTURES).join(' · ')}
      </div>
    );
  }
  stub();
  setCachedMessages(ME, CHAT, messages);
  return (
    <div
      id="frame"
      style={{
        width, height, display: 'flex', flexDirection: 'column',
        overflow: 'hidden', borderRadius: 10,
        border: `1px solid ${color.line}`, background: color.bg,
      }}
    >
      <DMPanel
        handle={ME}
        chatWith={CHAT}
        onBack={() => {}}
        users={[]}
        onOpenThread={() => {}}
        hasServerThread
      />
    </div>
  );
}
