import { act } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceChats } from '../../src/components/widgets/WorkspaceChats';
import { ChatHistoryPage } from '../../src/components/widgets/ChatHistoryPage';
import { getBrowserQueryClient } from '../../src/lib/query/client';
import { CHATS_KEY } from '../../src/lib/api/chats';
import type { ChatRecord } from '../../src/lib/api';

vi.mock('../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api')>()),
  listChats: vi.fn(async () => []),
}));

const chat: ChatRecord = {
  id: 'hydration-race-chat',
  title: 'A chat loaded by the other island',
  model: '@cf/meta/e2e-chat',
  created_at: 1_789_200_000_000,
  updated_at: 1_789_200_000_000,
};

afterEach(() => getBrowserQueryClient().clear());

describe.each([
  ['Workspace sidebar', WorkspaceChats],
  ['History page', ChatHistoryPage],
] as const)('%s shared-cache hydration', (_label, Component) => {
  it.each([
    { state: 'empty', cachedChats: [] as ChatRecord[] },
    { state: 'populated', cachedChats: [chat] },
  ])('keeps the first client render consistent with a $state shared cache', async ({ cachedChats }) => {
    const client = getBrowserQueryClient();
    client.clear();
    const container = document.createElement('div');
    // SSG has no authenticated chat data. Another island can resolve this query
    // before this island's JavaScript reaches hydrateRoot in the browser.
    container.innerHTML = renderToString(<Component />);
    document.body.append(container);
    client.setQueryData(CHATS_KEY, cachedChats);
    const errors: string[] = [];
    let root: Root | undefined;
    try {
      await act(async () => {
        root = hydrateRoot(container, <Component />, {
          onRecoverableError: error => errors.push(String(error)),
        });
      });
      expect(errors).toEqual([]);
      if (cachedChats.length) expect(container.textContent).toContain(chat.title);
    } finally {
      await act(async () => root?.unmount());
      container.remove();
    }
  });
});
