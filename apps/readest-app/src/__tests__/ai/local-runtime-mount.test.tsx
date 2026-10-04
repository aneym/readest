import { describe, expect, it } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  useThreadRuntime,
  type ChatModelAdapter,
} from '@assistant-ui/react';

// The notebook's AI tab mounts useLocalRuntime. @assistant-ui/react 0.11.58
// calls __internal_setGetInitializePromise unbound on mount, which threw
// "Cannot set properties of undefined" and crashed the reader on Android
// (patches/@assistant-ui__react@0.11.58.patch). Mount it and run one turn.
const echo: ChatModelAdapter = {
  async *run({ messages }) {
    const last = messages[messages.length - 1];
    const text = last?.content.find((part) => part.type === 'text');
    yield { content: [{ type: 'text', text: `echo: ${text && 'text' in text ? text.text : ''}` }] };
  },
};

let thread: ReturnType<typeof useThreadRuntime> | null = null;
const Capture = () => {
  const runtime = useThreadRuntime();
  useEffect(() => {
    thread = runtime;
  }, [runtime]);
  return null;
};
const Chat = () => {
  const runtime = useLocalRuntime(echo);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Capture />
    </AssistantRuntimeProvider>
  );
};

describe('assistant local runtime', () => {
  it('mounts and answers a turn', async () => {
    render(<Chat />);
    await waitFor(() => expect(thread).not.toBeNull());
    await act(async () => {
      thread!.append({ role: 'user', content: [{ type: 'text', text: 'hello' }] });
    });
    await waitFor(() => {
      const messages = thread!.getState().messages;
      const reply = messages[messages.length - 1];
      expect(reply?.role).toBe('assistant');
      expect(reply?.content).toEqual([{ type: 'text', text: 'echo: hello' }]);
    });
  });
});
