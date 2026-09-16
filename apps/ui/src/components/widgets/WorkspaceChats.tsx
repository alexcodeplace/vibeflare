import { useEffect, useId, useState } from 'react';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { HydratedIsland } from '../HydratedIsland';
import { CHAT_NAVIGATION_EVENT, useChats } from '../../lib/api/chats';

export const SIDEBAR_HISTORY_OPEN_KEY = 'vf-sidebar-history-open';
const VISIBLE_CHATS = 20;

function activeChatId(): string | null {
  if (typeof window === 'undefined' || !/^\/chat\/?$/.test(window.location.pathname)) return null;
  return new URLSearchParams(window.location.search).get('chat_id');
}

function WorkspaceChatsInner() {
  const regionId = useId();
  const [expanded, setExpanded] = useState(true);
  const [ready, setReady] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const { data: chats = [], isPending, isError, refetch } = useChats(ready && expanded);

  useEffect(() => {
    try { setExpanded(localStorage.getItem(SIDEBAR_HISTORY_OPEN_KEY) !== '0'); } catch { /* Storage is optional. */ }
    setReady(true);
    const updateSelection = () => setActiveId(activeChatId());
    updateSelection();
    window.addEventListener(CHAT_NAVIGATION_EVENT, updateSelection);
    window.addEventListener('popstate', updateSelection);
    document.addEventListener('astro:page-load', updateSelection);
    return () => {
      window.removeEventListener(CHAT_NAVIGATION_EVENT, updateSelection);
      window.removeEventListener('popstate', updateSelection);
      document.removeEventListener('astro:page-load', updateSelection);
    };
  }, []);

  function toggle() {
    const next = !expanded;
    setExpanded(next);
    try { localStorage.setItem(SIDEBAR_HISTORY_OPEN_KEY, next ? '1' : '0'); } catch { /* Storage is optional. */ }
  }

  return (
    <section data-testid="workspace-chats" className="min-w-0 mb-2 ml-3 border-l border-[var(--color-border)] pl-2">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={regionId}
        aria-label="Chat history"
        onClick={toggle}
        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs font-medium text-[var(--color-muted)] hover:text-[var(--color-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
      >
        {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        <span>Chats</span>
      </button>
      <div id={regionId} hidden={!expanded}>
        {/* Native navigation intentionally resets the persisted ChatPage island.
            Otherwise switching two /chat?chat_id= links can retain the old thread. */}
        <a href="/chat" data-astro-reload className="flex items-center gap-2 rounded-md px-2 py-2 text-xs text-[var(--color-text)] hover:bg-[var(--color-border)]/40">
          <Plus size={14} aria-hidden="true" /> New chat
        </a>
        {!ready || isPending ? (
          <p role="status" className="px-2 py-2 text-xs text-[var(--color-muted)]">Loading chats…</p>
        ) : isError ? (
          <div className="px-2 py-2 text-xs text-[var(--color-muted)]">
            <p>Could not load chats.</p>
            <button type="button" onClick={() => void refetch()} className="mt-1 underline">Retry history</button>
          </div>
        ) : chats.length === 0 ? (
          <p className="px-2 py-2 text-xs text-[var(--color-muted)]">No chats yet.</p>
        ) : (
          <ul aria-label="Recent chats" className="max-h-60 overflow-y-auto overscroll-contain space-y-0.5">
            {chats.slice(0, VISIBLE_CHATS).map((chat) => (
              <li key={chat.id} className="min-w-0">
                <a
                  href={`/chat?chat_id=${encodeURIComponent(chat.id)}`}
                  data-astro-reload
                  aria-current={activeId === chat.id ? 'page' : undefined}
                  title={chat.title || 'Untitled chat'}
                  className={`block truncate rounded-md px-2 py-2 text-xs transition-colors ${activeId === chat.id
                    ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                    : 'text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-border)]/40'}`}
                >
                  <bdi>{chat.title || 'Untitled chat'}</bdi>
                </a>
              </li>
            ))}
          </ul>
        )}
        {chats.length > 0 && (
          <a href="/history" className="block px-2 py-2 text-xs text-[var(--color-muted)] underline hover:text-[var(--color-text)]">View all history</a>
        )}
      </div>
    </section>
  );
}

export function WorkspaceChats() {
  return <HydratedIsland><WorkspaceChatsInner /></HydratedIsland>;
}
