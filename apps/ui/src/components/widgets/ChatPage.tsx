import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createChat, getChatMessages, notifyModelsChanged, notifyQuotaChanged, redirectToLoginOnce, uploadFile } from '../../lib/api';
import {
  ChatComposer,
  ChatComposerDrawer,
  ChatComposerInput,
  ChatLayout,
  ChatMessage as AstryxChatMessage,
  ChatMessageBubble,
  ChatMessageList,
} from '@astryxdesign/core/Chat';
import { Avatar } from '@astryxdesign/core/Avatar';
import { Icon as AstryxIcon } from '@astryxdesign/core/Icon';
import { Layout, LayoutContent, HStack, VStack } from '@astryxdesign/core/Layout';
import { Markdown } from '@astryxdesign/core/Markdown';
import { Heading, Text } from '@astryxdesign/core/Text';
import { Token } from '@astryxdesign/core/Token';
import { PaperClipIcon, SparklesIcon } from '@heroicons/react/24/outline';
import { AudioTranscribePanel } from './AudioTranscribePanel';
import { ModelPicker } from './ModelPicker';
import { Card } from '../primitives/Card';
import { Badge } from '../primitives/Badge';
import { Tabs } from '../primitives/Tabs';
import { Toast } from '../primitives/Toast';
import { HydratedIsland } from '../HydratedIsland';
import { Spinner } from '../primitives/Spinner';
import { cacheCreatedChat, notifyChatNavigation, refreshChats } from '../../lib/api/chats';

let msgCounter = 0;
function nextId() { return `msg-${++msgCounter}`; }

interface GeneratedImage {
  blobUrl: string;
  prompt: string;
}

interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

const TASK_ITEMS = [
  { value: 'text-generation', label: 'Text' },
  { value: 'text-to-image', label: 'Image' },
  { value: 'text-embeddings', label: 'Embeddings' },
  { value: 'automatic-speech-recognition', label: 'Audio' },
];

const pageFill: CSSProperties = { minHeight: '100%' };
const chatFill: CSSProperties = { minHeight: 0, flex: 1 };
const composerInputStyle: CSSProperties = { minHeight: 84 };

/**
 * VibeFlare's chat follows Astryx's AI Chat Landing for the zero state and
 * AI Chat Conversation for active threads. Product-specific controls (model,
 * task, files and provider calls) stay thin around those templates.
 */
function ChatPageInner() {
  const [activeTask, setActiveTask] = useState('text-generation');
  const [model, setModel] = useState('');
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<Array<{ id: string; name: string }>>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const [imagePrompt, setImagePrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generatedImages, setGeneratedImages] = useState<GeneratedImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);

  const [toast, setToast] = useState<{ open: boolean; title: string; variant: 'default' | 'danger' }>({
    open: false,
    title: '',
    variant: 'default',
  });
  const notify = (title: string, variant: 'default' | 'danger' = 'default') => {
    setToast({ open: true, title, variant });
  };

  const [chatId, setChatId] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);

  useEffect(() => () => abortRef.current?.abort(), []);

  const isImageMode = activeTask === 'text-to-image';
  const isAudioMode = activeTask === 'automatic-speech-recognition';

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const cid = params.get('chat_id');
    if (!cid) return;
    setChatId(cid);
    setLoadingHistory(true);
    getChatMessages(cid)
      .then(({ chat, messages: history }) => {
        setModel(chat.model);
        setMessages(history.map((message) => ({
          id: message.id,
          role: message.role as 'user' | 'assistant',
          content: message.content,
        })));
      })
      .catch(() => {
        setChatId(null);
        notify('This chat could not be loaded.', 'danger');
      })
      .finally(() => setLoadingHistory(false));
  }, []);

  function handleTaskChange(task: string) {
    setActiveTask(task);
    setModel('');
    setMessages([]);
    setChatId(null);
    setGeneratedImages([]);
    setImageError(null);
    setAttachedFiles([]);
    setInput('');
    setImagePrompt('');
    const url = new URL(window.location.href);
    url.searchParams.delete('chat_id');
    window.history.replaceState(null, '', url.toString());
    notifyChatNavigation();
  }

  function handleModelChange(name: string, task: string) {
    setModel(name);
    if (task && task !== activeTask) setActiveTask(task);
  }

  async function addFiles(files: File[]) {
    if (files.length === 0) return;
    setUploadingFiles(true);
    try {
      const records = await Promise.all(files.map(uploadFile));
      setAttachedFiles((previous) => [
        ...previous,
        ...records.map((record) => ({ id: record.id, name: record.name })),
      ]);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'File upload failed', 'danger');
    } finally {
      setUploadingFiles(false);
    }
  }

  async function sendMessage(value = input) {
    const text = value.trim();
    if (!text || sending) return;
    if (!model) {
      notify('Choose a model first.');
      return;
    }

    const userMessage: UiMessage = { id: nextId(), role: 'user', content: text };
    const assistantId = nextId();
    setMessages((previous) => [
      ...previous,
      userMessage,
      { id: assistantId, role: 'assistant', content: '' },
    ]);
    setInput('');
    setSending(true);
    abortRef.current = new AbortController();

    try {
      let activeChatId = chatId;
      if (!activeChatId) {
        const chat = await createChat(text, model, abortRef.current.signal);
        activeChatId = chat.id;
        setChatId(chat.id);
        const location = new URL(window.location.href);
        location.searchParams.set('chat_id', chat.id);
        window.history.replaceState(null, '', location.toString());
        await cacheCreatedChat(chat);
        notifyChatNavigation();
      }
      const url = new URL('/v1/chat/completions', window.location.origin);
      url.searchParams.set('chat_id', activeChatId);
      const response = await fetch(url.toString(), {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'x-vf-browser': '1',
        },
        body: JSON.stringify({
          model,
          stream: true,
          messages: [...messages, userMessage].map((message) => ({ role: message.role, content: message.content })),
          ...(attachedFiles.length > 0 ? { file_ids: attachedFiles.map((file) => file.id) } : {}),
        }),
        signal: abortRef.current.signal,
      });

      if (response.status === 401) {
        redirectToLoginOnce();
        return;
      }
      if (!response.ok) {
        const error = await response.json().catch(() => ({})) as { error?: { type?: string; message?: string } };
        if (error.error?.type === 'paid_plan_required' || error.error?.type === 'paid_model_excluded') notifyModelsChanged();
        throw new Error(error.error?.message ?? `Request failed (${response.status})`);
      }
      if (!response.body) throw new Error('The model returned an empty response.');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let doneEvent = false;
      while (!doneEvent) {
        const { done, value: chunkValue } = await reader.read();
        if (done) break;
        buffer += decoder.decode(chunkValue, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            doneEvent = true;
            break;
          }
          try {
            const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
            const delta = chunk.choices?.[0]?.delta?.content ?? '';
            if (delta) {
              setMessages((previous) => previous.map((message) =>
                message.id === assistantId ? { ...message, content: message.content + delta } : message
              ));
            }
          } catch {
            // Ignore SSE comments/non-JSON protocol lines.
          }
        }
      }
      notifyQuotaChanged();
      refreshChats();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        setMessages((previous) => previous.map((message) =>
          message.id === assistantId && !message.content ? { ...message, content: 'Stopped.' } : message
        ));
      } else {
        const message = error instanceof Error ? error.message : 'Request failed';
        setMessages((previous) => previous.map((item) =>
          item.id === assistantId ? { ...item, content: `Error: ${message}` } : item
        ));
      }
    } finally {
      setSending(false);
      setAttachedFiles([]);
      abortRef.current = null;
    }
  }

  async function generateImage(value = imagePrompt) {
    const prompt = value.trim();
    if (!prompt || generating) return;
    if (!model) {
      notify('Choose an image model first.');
      return;
    }

    setGenerating(true);
    setImageError(null);
    abortRef.current = new AbortController();
    try {
      const response = await fetch('/v1/images/generations', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-vf-browser': '1' },
        body: JSON.stringify({ model, prompt, n: 1 }),
        signal: abortRef.current.signal,
      });
      if (response.status === 401) {
        redirectToLoginOnce();
        return;
      }
      if (!response.ok) {
        const error = await response.json().catch(() => ({})) as { error?: { type?: string; message?: string } };
        if (error.error?.type === 'paid_plan_required' || error.error?.type === 'paid_model_excluded') notifyModelsChanged();
        throw new Error(error.error?.message ?? `Request failed (${response.status})`);
      }
      const data = await response.json() as { data: Array<{ url?: string; b64_json?: string }> };
      const newImages: GeneratedImage[] = [];
      for (const item of data.data) {
        if (item.b64_json) {
          newImages.push({ blobUrl: `data:image/png;base64,${item.b64_json}`, prompt });
        } else if (item.url) {
          const imageResponse = await fetch(item.url, { headers: { 'x-vf-browser': '1' }, credentials: 'same-origin' });
          if (!imageResponse.ok) throw new Error('Generated image could not be loaded.');
          newImages.push({ blobUrl: URL.createObjectURL(await imageResponse.blob()), prompt });
        }
      }
      setGeneratedImages((previous) => [...previous, ...newImages]);
      setImagePrompt('');
      notifyQuotaChanged();
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) {
        setImageError(error instanceof Error ? error.message : 'Image generation failed');
      }
    } finally {
      setGenerating(false);
      abortRef.current = null;
    }
  }

  const attachmentDrawer = attachedFiles.length > 0 ? (
    <ChatComposerDrawer count={attachedFiles.length}>
      {attachedFiles.map((file) => (
        <Token
          key={file.id}
          label={file.name}
          onRemove={() => setAttachedFiles((previous) => previous.filter((candidate) => candidate.id !== file.id))}
        />
      ))}
    </ChatComposerDrawer>
  ) : undefined;

  const textComposer = (
    <ChatComposer
      value={input}
      onChange={setInput}
      onSubmit={sendMessage}
      onStop={() => abortRef.current?.abort()}
      isStopShown={sending}
      isDisabled={uploadingFiles || !model || loadingHistory}
      placeholder="Ask anything"
      drawer={attachmentDrawer}
      input={
        <ChatComposerInput
          value={input}
          isDisabled={!model || loadingHistory}
          aria-disabled={!model || loadingHistory}
          onChange={setInput}
          onSubmit={sendMessage}
          onFiles={(files) => void addFiles(files)}
          pasteAsToken={false}
          style={composerInputStyle}
        />
      }
      headerActions={
        <HStack gap={1} vAlign="center">
          <AstryxIcon icon={PaperClipIcon} size="sm" color="secondary" />
          <Text type="supporting" color="secondary">
            {uploadingFiles ? 'Uploading…' : 'Drop or paste files here'}
          </Text>
        </HStack>
      }
    />
  );

  const textSurface = loadingHistory ? (
    <div className="flex min-h-[360px] items-center justify-center"><Spinner size="lg" /></div>
  ) : messages.length === 0 ? (
    <Layout
      height="fill"
      contentWidth={720}
      padding={6}
      content={
        <LayoutContent>
          <VStack gap={8} vAlign="center" style={pageFill}>
            <VStack gap={1}>
              <HStack gap={2} vAlign="center">
                <AstryxIcon icon={SparklesIcon} size="md" color="accent" />
                <Text type="large" as="h2">VibeFlare</Text>
              </HStack>
              <Text type="display-2" as="h1">What do you want to make?</Text>
              <Text type="body" color="secondary">Pick a model, ask anything, and keep the whole conversation here.</Text>
            </VStack>
            {textComposer}
          </VStack>
        </LayoutContent>
      }
    />
  ) : (
    <ChatLayout density="spacious" style={chatFill} composer={textComposer}>
      <ChatMessageList align="top" isStreaming={sending}>
        {messages.map((message) => (
          <AstryxChatMessage
            key={message.id}
            sender={message.role}
            avatar={message.role === 'assistant' ? <Avatar name="VibeFlare" size="md" /> : undefined}
          >
            <ChatMessageBubble variant={message.role === 'assistant' ? 'ghost' : 'filled'}>
              {message.role === 'assistant' ? (
                <Markdown density="compact" isStreaming={sending && message.id === messages.at(-1)?.id}>
                  {message.content || 'Thinking…'}
                </Markdown>
              ) : message.content}
            </ChatMessageBubble>
          </AstryxChatMessage>
        ))}
      </ChatMessageList>
    </ChatLayout>
  );

  const imageSurface = (
    <VStack gap={4} height="100%">
      {imageError && <Badge variant="danger">{imageError}</Badge>}
      {generatedImages.length === 0 ? (
        <VStack gap={2} vAlign="center" style={pageFill}>
          <Heading level={1}>Create an image</Heading>
          <Text color="secondary">Describe what you want and VibeFlare will generate it with the selected model.</Text>
          <div className="w-full max-w-[720px]">
            <ChatComposer
              value={imagePrompt}
              onChange={setImagePrompt}
              onSubmit={generateImage}
              onStop={() => abortRef.current?.abort()}
              isStopShown={generating}
              placeholder="Describe the image you want…"
              input={<ChatComposerInput value={imagePrompt} onChange={setImagePrompt} onSubmit={generateImage} pasteAsToken={false} />}
            />
          </div>
        </VStack>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {generatedImages.map((image, index) => (
              <Card key={`${image.prompt}-${index}`} variant="outlined" className="overflow-hidden">
                <img src={image.blobUrl} alt={image.prompt} width={1} height={1} className="h-auto w-full" style={{ aspectRatio: '1/1' }} />
                <p className="truncate px-3 py-2 text-xs text-[var(--color-muted)]">{image.prompt}</p>
              </Card>
            ))}
          </div>
          <ChatComposer
            value={imagePrompt}
            onChange={setImagePrompt}
            onSubmit={generateImage}
            onStop={() => abortRef.current?.abort()}
            isStopShown={generating}
            placeholder="Create another image…"
          />
        </>
      )}
    </VStack>
  );

  return (
    <div className="flex h-full min-w-0 flex-col gap-3" data-testid="vibeflare-chat">
      <Toast
        open={toast.open}
        onOpenChange={(open) => setToast((previous) => ({ ...previous, open }))}
        title={toast.title}
        variant={toast.variant}
      />
      <div className="shrink-0 space-y-3">
        <Tabs
          items={TASK_ITEMS.map((task) => ({ value: task.value, label: task.label, content: null }))}
          value={activeTask}
          onValueChange={handleTaskChange}
          variant="segmented"
        />
        <ModelPicker task={activeTask} value={model} onChange={handleModelChange} />
      </div>
      <div className="min-h-0 flex-1">
        {isAudioMode ? <AudioTranscribePanel model={model} /> : isImageMode ? imageSurface : textSurface}
      </div>
    </div>
  );
}

export function ChatPage() {
  return (
    <HydratedIsland>
      <ChatPageInner />
    </HydratedIsland>
  );
}
