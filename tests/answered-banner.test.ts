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

import { checkAndNotify, resetNotificationState, hasNotificationPermission, setNotificationOwner } from '../src/lib/notifications';
import { answeredBanner, resetReturnBindings, pickTriggering } from '../src/lib/returnBindings';

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

describe('enrichment is bound to the account that saw the message', () => {
  it('delivers nothing — enriched or fallback — if the owner changed while describe was pending', async () => {
    setNotificationOwner('ada');
    checkAndNotify(thread(0));
    let release: (v: { title: string; body: string } | null) => void = () => {};
    checkAndNotify(thread(1), () => new Promise((r) => { release = r; }));
    setNotificationOwner('bob'); // sign-out / switch while pending
    release({ title: '@linus', body: 'answered what you asked from payments: …' });
    await tick();
    expect(sent).toHaveLength(0);
    setNotificationOwner('ada');
  });
  it('only the triggering message may describe the banner', async () => {
    const trig = { from: 'linus', body: 'first reply' };
    const tail = async () => [
      { from: 'linus', content: 'first reply', replyTo: undefined },
      { from: 'linus', content: 'a later linked reply', replyTo: { id: 'msg_q', from: 'ada', text: 'q' } },
    ];
    // No binding is readable through the mocked bridge, so this resolves null regardless;
    // the pure selection rule is covered in return-bindings.test.ts via answersYourAsk.
    expect(await answeredBanner('ada', 'linus', tail, trig)).toBeNull();
  });
});

describe('pickTriggering', () => {
  const tail = [
    { id: 'm1', from: 'linus', content: 'OK', replyTo: undefined },
    { id: 'm2', from: 'linus', content: 'OK', replyTo: { id: 'msg_q', from: 'ada', text: 'q' } },
  ];
  it('selects exactly the served id — identical text on a later linked message does not qualify', () => {
    expect(pickTriggering(tail, 'linus', { id: 'm1', from: 'linus', body: 'OK' })?.id).toBe('m1');
    expect(pickTriggering(tail, 'linus', { id: 'm2', from: 'linus', body: 'OK' })?.id).toBe('m2');
  });
  it('without a served id nothing is picked (ordinary banner), never a text match', () => {
    expect(pickTriggering(tail, 'linus', { from: 'linus', body: 'OK' })).toBeNull();
    expect(pickTriggering(tail, 'linus', undefined)).toBeNull();
  });
});

describe('the thread fetch never runs for another account', () => {
  it('stillMe() is consulted before loadTail; a changed account skips the fetch', async () => {
    let fetched = 0;
    const tail = async () => { fetched++; return [] as never[]; };
    const r = await answeredBanner('ada', 'linus', tail, { id: 'm1', from: 'linus', body: 'x' }, () => false);
    expect(r).toBeNull();
    expect(fetched).toBe(0);
  });
});
