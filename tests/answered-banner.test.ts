// The banner says what a new message IS when that is known — their verified
// answer to what you asked from a piece of work — and stays the ordinary
// banner otherwise. Enrichment can never lose a banner.
import { describe, expect, it, beforeEach, vi } from 'vitest';

const sent: Array<{ title: string; body: string }> = [];
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => 'granted',
  sendNotification: (n: { title: string; body: string }) => { sent.push({ title: n.title, body: n.body }); },
  registerActionTypes: async () => {},
  onAction: async () => {},
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => {} }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ show: async () => {}, unminimize: async () => {}, setFocus: async () => {} }) }));

import { checkAndNotify, resetNotificationState, hasNotificationPermission } from '../src/lib/notifications';
import { answeredBanner, resetReturnBindings } from '../src/lib/returnBindings';

const thread = (unread: number) => [{ with: 'linus', unread, lastMessage: { from: 'linus', body: 'exponential, three tries.' } }];
const tick = () => new Promise((r) => setTimeout(r, 40));

beforeEach(async () => { sent.length = 0; await hasNotificationPermission(); resetNotificationState(); resetReturnBindings(); });

describe('checkAndNotify with a describe hook', () => {
  it('uses the description when the hook resolves one', async () => {
    checkAndNotify(thread(0));
    checkAndNotify(thread(1), async () => ({ title: '@linus', body: 'answered what you asked from payments: exponential, three tries.' }));
    await tick();
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatch(/^answered what you asked from payments: /);
  });
  it('falls back to the ordinary banner when the hook says null or throws', async () => {
    checkAndNotify(thread(0));
    checkAndNotify(thread(1), async () => null);
    await tick();
    checkAndNotify(thread(2), async () => { throw new Error('tail read failed'); });
    await tick();
    expect(sent).toHaveLength(2);
    for (const s of sent) expect(s.body).toBe('exponential, three tries.');
  });
});

describe('answeredBanner', () => {
  it('describes only a verified answer: linkage to the sent message id', async () => {
    // bindings come through the mocked bridge (read_return_bindings → undefined here), so
    // exercise the pure decision with an explicit loader and a binding via the cache path.
    const tail = async () => [{ from: 'linus', content: 'exponential, three tries.', replyTo: { id: 'msg_q', from: 'ada', text: 'q' } }];
    // No bindings readable → null (never "answered" without the binding)
    expect(await answeredBanner('ada', 'linus', tail)).toBeNull();
  });
});
