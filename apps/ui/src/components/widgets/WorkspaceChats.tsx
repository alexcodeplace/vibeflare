import { useEffect, useState } from 'react';
import { useChats, CHAT_NAVIGATION_EVENT } from '../../lib/api/chats';
import { HydratedIsland, useIslandHydrated } from '../HydratedIsland';

function currentChatId(): string | null {
  return typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('chat_id');
}

function WorkspaceChatsInner() {
  const hydrated = useIslandHydrated();
  const { data: chats = [], isError, refetch } = useChats();
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    const update = () => setSelected(currentChatId());
    update();
    window.addEventListener('popstate', update);
    window.addEventListener(CHAT_NAVIGATION_EVENT, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(CHAT_NAVIGATION_EVENT, update);
    };
  }, []);

  if (!hydrated) return null;

  if (isError) {
    return <button type="button" onClick={() => void refetch()} className="px-3 py-2 text-left text-xs text-[var(--color-muted)]">Retry loading chats</button>;
  }
  // Keep the existing empty sidebar and all product menus intact.
  if (!chats.length) return null;

  return (
    <details data-testid="workspace-chats" className="vf-workspace-chats min-w-0 mb-2" open>
      <summary className="vf-chat-history-toggle"><span>Recent chats</span><span className="vf-chat-count" aria-hidden="true">{chats.length}</span></summary>
      <a href="/chat" data-astro-reload className="block rounded-lg px-3 py-2 text-xs text-[var(--color-muted)] hover:text-[var(--color-text)]">+ New chat</a>
      <ul aria-label="Workspace chats" className="m-0 max-h-[40vh] list-none space-y-0.5 overflow-y-auto overscroll-contain p-0">
        {chats.map((chat) => (
          <li key={chat.id}>
            <a
              href={`/chat?chat_id=${encodeURIComponent(chat.id)}`}
              data-astro-reload
              aria-current={selected === chat.id ? 'page' : undefined}
              title={chat.title || 'Untitled chat'}
              className={`block truncate rounded-lg py-2 pl-6 pr-3 text-xs transition-colors ${selected === chat.id
                ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                : 'text-[var(--color-muted)] hover:bg-[var(--color-border)]/40 hover:text-[var(--color-text)]'}`}
            >
              {chat.title || 'Untitled chat'}
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function WorkspaceChats() {
  return <HydratedIsland><WorkspaceChatsInner /></HydratedIsland>;
}
