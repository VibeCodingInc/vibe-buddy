// A reply says what it answers, and offers one honest way back to the work.
import { describe, expect, it, beforeEach, vi } from 'vitest';

let invokeResult: unknown = [];
let invokeCalls: Array<{ cmd: string; args: unknown }> = [];
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args: unknown) => { invokeCalls.push({ cmd, args }); if (invokeResult instanceof Error) throw invokeResult; return invokeResult; },
}));

import { loadReturnBindings, resetReturnBindings, bindingFor, answersYourAsk, answersLine, returnAction, type ReturnBinding } from '../src/lib/returnBindings';
import type { TerminalSession } from '../src/lib/terminal';

const binding: ReturnBinding = { handle: 'linus', from: 'ada', project: 'payments', messageId: 'msg_q', firstLine: 're: payments — which curve?', cwd: '/Users/ada/Projects/payments', sentAt: 1 };
const tab = (over: Partial<TerminalSession>): TerminalSession => ({ window_id: '1', tty: '/dev/ttys004', name: 'claude', app: 'iTerm2', cwd: '/Users/ada/Projects/payments', claude_foreground: true, ...over } as TerminalSession);

beforeEach(() => { resetReturnBindings(); invokeCalls = []; invokeResult = []; });

describe('loading', () => {
  it('reads the bindings for the signed-in account through Rust and normalizes them', async () => {
    invokeResult = [{ handle: 'Linus', from: 'ada', project: 'payments', messageId: 'msg_q', firstLine: 'x', cwd: '/Users/ada/Projects/payments', sentAt: 1 }, { junk: true }, null];
    const list = await loadReturnBindings('ada');
    expect(invokeCalls[0]).toEqual({ cmd: 'read_return_bindings', args: { me: 'ada' } });
    expect(list).toHaveLength(1);
    expect(list[0].handle).toBe('linus');
  });
  it('a failed read is an empty list, never an error a thread has to survive', async () => {
    invokeResult = new Error('no bridge');
    expect(await loadReturnBindings('ada')).toEqual([]);
  });
});

describe('what a reply answers', () => {
  it('is claimed only when their message carries reply_to = the sent id', () => {
    expect(answersYourAsk({ from: 'linus', replyTo: { id: 'msg_q', from: 'ada', text: 'q' } }, binding, 'linus')).toBe(true);
    expect(answersYourAsk({ from: 'linus', replyTo: { id: 'msg_other', from: 'ada', text: 'q' } }, binding, 'linus')).toBe(false);
    expect(answersYourAsk({ from: 'linus' }, binding, 'linus')).toBe(false);
    expect(answersYourAsk({ from: 'ada', replyTo: { id: 'msg_q', from: 'ada', text: 'q' } }, binding, 'linus')).toBe(false);
    expect(answersYourAsk({ from: 'linus', replyTo: { id: 'msg_q', from: 'ada', text: 'q' } }, null, 'linus')).toBe(false);
  });
  it('the line names the work and carries no ids', () => {
    expect(answersLine(binding)).toBe('answers what you asked from payments');
    expect(answersLine({ ...binding, project: null })).toBe('answers what you asked');
    expect(answersLine(binding)).not.toMatch(/msg_|rev|draft/);
  });
});

describe('the way back is honest', () => {
  it('fronts the exact tab when one live session is in that directory', () => {
    const a = returnAction(binding, [tab({})]);
    expect(a).toMatchObject({ kind: 'session', label: 'Back to the session', tty: '/dev/ttys004' });
  });
  it('two tabs in that directory is an ambiguity we do not guess — show the folder instead', () => {
    const a = returnAction(binding, [tab({ tty: '/dev/ttys004' }), tab({ tty: '/dev/ttys005' })]);
    expect(a).toMatchObject({ kind: 'folder', label: 'Show the folder', cwd: binding.cwd });
  });
  it('no live tab → show the folder; no cwd → nothing; never "resume"', () => {
    expect(returnAction(binding, [tab({ cwd: '/Users/ada/elsewhere' })])).toMatchObject({ kind: 'folder' });
    expect(returnAction({ ...binding, cwd: null }, [tab({})])).toEqual({ kind: 'none' });
    for (const a of [returnAction(binding, [tab({})]), returnAction(binding, [])]) expect(JSON.stringify(a)).not.toMatch(/resum/i);
  });
  it('bindingFor is case- and @-insensitive', () => {
    expect(bindingFor('@Linus', [binding])).toBe(binding);
    expect(bindingFor('grace', [binding])).toBeNull();
  });
});
