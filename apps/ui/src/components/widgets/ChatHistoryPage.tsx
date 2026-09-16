import { useState } from 'react';
import { Card } from '../primitives/Card';
import { Button } from '../primitives/Button';
import { Badge } from '../primitives/Badge';
import { Dialog } from '../primitives/Dialog';
import { Spinner } from '../primitives/Spinner';
import { Toast, ToastProvider } from '../primitives/Toast';
import { Icon } from '../primitives/Icon';
import { HydratedIsland, useIslandHydrated } from '../HydratedIsland';
import { useChats, useRenameChat, useDeleteChat } from '../../lib/api/chats';

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function ChatHistoryPageInner() {
  const hydrated = useIslandHydrated();
  const { data: chats = [], isPending, isError } = useChats();
  const renameChat = useRenameChat();
  const deleteChat = useDeleteChat();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ open: boolean; title: string; variant: 'success' | 'danger' }>({
    open: false, title: '', variant: 'success',
  });

  function startRename(id: string, currentTitle: string) {
    setEditingId(id);
    setEditTitle(currentTitle || '');
  }

  async function saveRename(id: string) {
    const title = editTitle.trim();
    if (!title || title.length === 0) {
      setEditingId(null);
      return;
    }
    try {
      await renameChat.mutateAsync({ id, title });
      setEditingId(null);
    } catch (e) {
      setToast({ open: true, title: (e as Error).message, variant: 'danger' });
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteChat.mutateAsync(id);
      setDeleteId(null);
      setToast({ open: true, title: 'Chat deleted', variant: 'success' });
    } catch (e) {
      setToast({ open: true, title: (e as Error).message, variant: 'danger' });
    }
  }

  function handleKeyDown(e: React.KeyboardEvent, id: string) {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveRename(id);
    } else if (e.key === 'Escape') {
      setEditingId(null);
    }
  }

  return (
    <ToastProvider>
      <div data-testid="history-page" className="space-y-4 max-w-2xl">
        {!hydrated || isPending ? (
          <div className="flex justify-center py-8">
            <Spinner size="lg" />
          </div>
        ) : isError ? (
          <Badge variant="danger">Failed to load chats</Badge>
        ) : chats.length === 0 ? (
          <p data-testid="history-empty" className="text-sm text-[var(--color-muted)]">No chats yet. Start one from the workspace.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {chats.map((chat) => (
              <Card
                key={chat.id}
                variant="outlined"
                className="p-4 cursor-pointer hover:bg-[var(--color-surface)] transition-colors"
                onClick={() => {
                  if (editingId === chat.id) return;
                  window.location.href = `/chat?chat_id=${encodeURIComponent(chat.id)}`;
                }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant="muted" className="text-xs">{chat.model}</Badge>
                      {editingId === chat.id ? (
                        <input
                          className="text-sm font-medium text-[var(--color-text)] bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-0.5 flex-1 min-w-0 focus:outline-none focus:border-[var(--color-accent)]"
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          onKeyDown={(e) => handleKeyDown(e, chat.id)}
                          onBlur={() => saveRename(chat.id)}
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <span
                          className="text-sm font-medium text-[var(--color-text)] truncate cursor-pointer hover:text-[var(--color-accent)]"
                          onClick={(e) => {
                            e.stopPropagation();
                            startRename(chat.id, chat.title ?? '');
                          }}
                          title="Click to rename"
                        >
                          {chat.title || 'Untitled chat'}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-[var(--color-muted)]">
                      {relativeTime(chat.updated_at)}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteId(chat.id);
                    }}
                    leftIcon={<Icon name="Trash2" size="sm" />}
                  />
                </div>
              </Card>
            ))}
          </div>
        )}

        <Dialog
          open={deleteId !== null}
          onOpenChange={(open) => { if (!open) setDeleteId(null); }}
          title="Delete chat"
          description="This permanently deletes the chat and all its messages. This cannot be undone."
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setDeleteId(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                loading={deleteChat.isPending}
                onClick={() => deleteId && handleDelete(deleteId)}
              >
                Delete
              </Button>
            </>
          }
        />
      </div>

      <Toast
        open={toast.open}
        onOpenChange={o => setToast(t => ({ ...t, open: o }))}
        title={toast.title}
        variant={toast.variant}
      />
    </ToastProvider>
  );
}

export function ChatHistoryPage() {
  return (
    <HydratedIsland>
      <ChatHistoryPageInner />
    </HydratedIsland>
  );
}
