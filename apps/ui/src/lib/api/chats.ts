import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listChats, renameChat, deleteChat, type ChatRecord } from '../api';
import { getBrowserQueryClient } from '../query/client';

export const CHATS_KEY = ['chats'] as const;
export const CHAT_NAVIGATION_EVENT = 'vibeflare:chat-navigation';

export function notifyChatNavigation(): void {
  window.dispatchEvent(new Event(CHAT_NAVIGATION_EVENT));
}

export async function cacheCreatedChat(chat: ChatRecord): Promise<void> {
  const qc = getBrowserQueryClient();
  await qc.cancelQueries({ queryKey: CHATS_KEY });
  qc.setQueryData<ChatRecord[]>(CHATS_KEY, (old = []) => [chat, ...old.filter((c) => c.id !== chat.id)].slice(0, 100));
}

/** Shared by Workspace and History. Called once per message, never per token. */
export function refreshChats(): void {
  void getBrowserQueryClient().invalidateQueries({ queryKey: CHATS_KEY });
}

export function useChats(enabled = true) {
  return useQuery({
    queryKey: CHATS_KEY,
    queryFn: listChats,
    enabled,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });
}

export function useRenameChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => renameChat(id, title),
    onSuccess: () => qc.invalidateQueries({ queryKey: CHATS_KEY }),
  });
}

export function useDeleteChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteChat(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: CHATS_KEY }),
  });
}

export type { ChatRecord };
