import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { parseHistoryMetadata, type HistoryMetadata } from '@vibeflare/shared';
import { HistoryAttachments } from './HistoryAttachments';
import { createChat, getChatMessages, notifyModelsChanged, notifyQuotaChanged, redirectToLoginOnce } from '../../lib/api';
import {
  ChatComposer,
  ChatComposerInput,
  ChatLayout,
  ChatMessage as AstryxChatMessage,
  ChatMessageBubble,
  ChatMessageList,
} from '@astryxdesign/core/Chat';
import { BrandArtwork } from '../brand/BrandArtwork';
import { Markdown } from '@astryxdesign/core/Markdown';
import { TaskWorkspace, TASK_PRESENTATION } from './TaskWorkspace';
import { FileDropzone } from './FileDropzone';
import { readPromptFile, TEXT_FILE_ACCEPT, PROMPT_FILE_ACCEPT, MAX_TEXT_FILE_BYTES, MAX_IMPORTED_CHARACTERS, fileMatchesAccept } from '../../lib/file-input';
import { AudioTranscribePanel } from './AudioTranscribePanel';
import { EmbeddingSimilarityPanel } from './EmbeddingSimilarityPanel';
import { ModelPicker } from './ModelPicker';
import { Tabs } from '../primitives/Tabs';
import { Toast } from '../primitives/Toast';
import { HydratedIsland } from '../HydratedIsland';
import { Spinner } from '../primitives/Spinner';
import { cacheCreatedChat, notifyChatNavigation, refreshChats } from '../../lib/api/chats';

let msgCounter = 0;
function nextId() { return `msg-${++msgCounter}`; }

interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: HistoryMetadata | null;
}

const TASK_ITEMS = [
  { value: 'text-generation', label: 'Text' },
  { value: 'text-to-image', label: 'Image' },
  { value: 'text-embeddings', label: 'Embeddings' },
  { value: 'automatic-speech-recognition', label: 'Audio' },
];

const composerInputStyle: CSSProperties = { minHeight: 100, maxHeight: 100, overflowY: 'auto' };

const STARTERS = [
  { title: 'Think it through', detail: 'Turn a thought into a plan', art: 'lightbulb-glass' as const, prompt: 'Help me think through an idea. Ask me a few questions to understand what I am trying to achieve.' },
  { title: 'Build something', detail: 'Work through code together', art: 'workflow-panels' as const, prompt: 'Help me build a small project. First, ask what I want to make and which tools I use.' },
  { title: 'Make it clearer', detail: 'Find the words that fit', art: 'template-panels' as const, prompt: 'Help me make a piece of writing clearer. Ask me for the text and who it is for.' },
];

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
  const [readingFile, setReadingFile] = useState(false);
  const [importedFileName, setImportedFileName] = useState<string | null>(null);
  const fileReadVersion = useRef(0);
  const fileReading = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const composerRef = useRef<HTMLDivElement>(null);

  const [imagePrompt, setImagePrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [pendingImagePrompt, setPendingImagePrompt] = useState<string | null>(null);
  const latestDraft = useRef({ input, imagePrompt, activeTask });
  latestDraft.current = { input, imagePrompt, activeTask };

  const [toast, setToast] = useState<{ open: boolean; title: string; variant: 'default' | 'danger' }>({
    open: false,
    title: '',
    variant: 'default',
  });
  const notify = (title: string, variant: 'default' | 'danger' = 'default') => {
    setToast({ open: true, title, variant });
  };

  const [loadingHistory, setLoadingHistory] = useState(true);
  const [conversationStarted, setConversationStarted] = useState(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('chat_id'));
  const chatIdRef = useRef<string | null>(null);
  const operationRef = useRef(false);
  const [audioBusy, setAudioBusy] = useState(false);
  const [embeddingBusy, setEmbeddingBusy] = useState(false);
  const busy = sending || generating || audioBusy || embeddingBusy || loadingHistory;

  useEffect(() => () => abortRef.current?.abort(), []);

  const isImageMode = activeTask === 'text-to-image';
  const isAudioMode = activeTask === 'automatic-speech-recognition';
  const isEmbeddingMode = activeTask === 'text-embeddings';

  async function loadHistory(id: string, signal: AbortSignal) {
    const detail = await getChatMessages(id, signal);
    if (signal.aborted || chatIdRef.current !== id) return;
    const history: UiMessage[] = detail.messages
      .filter(message => message.role === 'user' || message.role === 'assistant')
      .map(message => ({ id: message.id, role: message.role as 'user' | 'assistant', content: message.content, attachments: parseHistoryMetadata(message.attachments) }));
    const task = [...history].reverse().find(message => message.attachments)?.attachments?.task ?? detail.chat.task ?? 'text-generation';
    setActiveTask(task);
    setModel(detail.chat.model);
    setMessages(history);
    refreshChats();
  }

  useEffect(() => {
    const cid = new URLSearchParams(window.location.search).get('chat_id');
    if (!cid) { setConversationStarted(false); setLoadingHistory(false); return; }
    const controller = new AbortController();
    chatIdRef.current = cid;
    setConversationStarted(true);
    void loadHistory(cid, controller.signal)
      .catch(() => {
        if (controller.signal.aborted) return;
        chatIdRef.current = null;
        setConversationStarted(false);
        notify('This chat could not be loaded.', 'danger');
      })
      .finally(() => { if (!controller.signal.aborted) setLoadingHistory(false); });
    return () => controller.abort();
  }, []);

  async function ensureConversation(title: string, signal: AbortSignal): Promise<string> {
    if (chatIdRef.current) return chatIdRef.current;
    const chat = await createChat(title, model, signal);
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    chatIdRef.current = chat.id;
    const location = new URL(window.location.href);
    location.searchParams.set('chat_id', chat.id);
    window.history.replaceState(null, '', location.toString());
    await cacheCreatedChat(chat);
    notifyChatNavigation();
    return chat.id;
  }

  function handleTaskChange(task: string) {
    if (operationRef.current || audioBusy || loadingHistory || fileReading.current) return;
    setActiveTask(task);
    setModel('');
    setMessages([]);
    setConversationStarted(false);
    chatIdRef.current = null;
    setImageError(null);
    setImportedFileName(null);
    fileReadVersion.current++;
    setInput('');
    setImagePrompt('');
    const url = new URL(window.location.href);
    url.searchParams.delete('chat_id');
    window.history.replaceState(null, '', url.toString());
    notifyChatNavigation();
  }

  const handleModelChange = useCallback((name: string, task: string) => {
    setModel(name);
    if (task) setActiveTask(task);
  }, []);

  async function importTextFile(files: File[]) {
    if (files.length !== 1) throw new Error('Choose one text file at a time.');
    if (fileReading.current || operationRef.current) return;
    const file = files[0]!;
    const task = activeTask;
    const version = ++fileReadVersion.current;
    if (task === 'text-to-image' && !fileMatchesAccept(file, PROMPT_FILE_ACCEPT)) throw new Error('Import a written prompt as .txt or .md. Reference images are not supported by this tab.');
    fileReading.current = true; setReadingFile(true);
    try {
      const text = await readPromptFile(file);
      if (version !== fileReadVersion.current || task !== latestDraft.current.activeTask) return;
      const previous = task === 'text-to-image' ? latestDraft.current.imagePrompt : latestDraft.current.input;
      const combined = previous.trim() ? `${previous.trim()}\n\n${text}` : text;
      if (combined.length > MAX_IMPORTED_CHARACTERS) throw new Error('The combined input exceeds 16,000 characters. Shorten it before importing more text.');
      if (task === 'text-to-image') setImagePrompt(combined); else setInput(combined);
      setImportedFileName(file.name);
    } finally { fileReading.current = false; setReadingFile(false); }
  }

  async function sendMessage(value = input) {
    const text = value.trim();
    if (!text || operationRef.current || busy || fileReading.current) return;
    if (!model) {
      notify('Choose a model first.');
      return;
    }

    operationRef.current = true;
    if (activeTask === 'text-generation') setConversationStarted(true);
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
      const activeChatId = await ensureConversation(text, abortRef.current.signal);
      if (isEmbeddingMode) {
        const response = await fetch(`/v1/embeddings?chat_id=${encodeURIComponent(activeChatId)}`, {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'x-vf-browser': '1' },
          body: JSON.stringify({ model, input: text }), signal: abortRef.current.signal,
        });
        if (response.status === 401) { redirectToLoginOnce(); return; }
        if (!response.ok) {
          const error = await response.json().catch(() => ({})) as { error?: { type?: string; message?: string } };
          if (error.error?.type === 'paid_plan_required' || error.error?.type === 'paid_model_excluded') notifyModelsChanged();
          throw new Error(error.error?.message ?? `Request failed (${response.status})`);
        }
        await loadHistory(activeChatId, abortRef.current.signal);
        notifyQuotaChanged();
        return;
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
      operationRef.current = false;
      setSending(false);
      setImportedFileName(null);
      abortRef.current = null;
    }
  }

  async function generateImage(value = imagePrompt) {
    const prompt = value.trim();
    if (!prompt || operationRef.current || busy || fileReading.current) return;
    if (!model) { notify('Choose an image model first.'); return; }
    operationRef.current = true;
    setConversationStarted(true);
    setPendingImagePrompt(prompt);
    setImagePrompt('');
    setGenerating(true);
    setImageError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const id = await ensureConversation(prompt, controller.signal);
      const response = await fetch(`/v1/images/generations?chat_id=${encodeURIComponent(id)}`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-vf-browser': '1' },
        body: JSON.stringify({ model, prompt, n: 1, response_format: 'url' }), signal: controller.signal,
      });
      if (response.status === 401) { redirectToLoginOnce(); return; }
      if (!response.ok) {
        const error = await response.json().catch(() => ({})) as { error?: { type?: string; message?: string } };
        if (error.error?.type === 'paid_plan_required' || error.error?.type === 'paid_model_excluded') notifyModelsChanged();
        throw new Error(error.error?.message ?? `Request failed (${response.status})`);
      }
      await loadHistory(id, controller.signal);
      if (controller.signal.aborted) return;
      setPendingImagePrompt(null);
      setImportedFileName(null);
      notifyQuotaChanged();
    } catch (error) {
      if (!controller.signal.aborted) {
        // The composer clears on submit; restore failed input without replacing
        // a different prompt the user started typing while the request ran.
        setPendingImagePrompt(null);
        setImagePrompt(current => current.trim() ? current : prompt);
        setImageError(error instanceof Error ? error.message : 'Image generation failed');
      }
    } finally {
      operationRef.current = false;
      // A user cancellation remains usable without switching to another task.
      setPendingImagePrompt(null);
      setGenerating(false);
      abortRef.current = null;
    }
  }

  const info = TASK_PRESENTATION[activeTask] ?? TASK_PRESENTATION['text-generation']!;
  const prompt = isImageMode ? imagePrompt : input;
  const setPrompt = isImageMode ? setImagePrompt : setInput;
  const submit = isImageMode ? generateImage : sendMessage;
  const isRunning = sending || generating;
  const promptComposer = (
    <div className="vf-composer-wrap" ref={composerRef}>
      <ChatComposer value={prompt} onChange={setPrompt} onSubmit={submit}
        onStop={() => abortRef.current?.abort()} isStopShown={isRunning}
        isDisabled={loadingHistory} placeholder={info.prompt}
        input={<ChatComposerInput value={prompt} onChange={setPrompt} onSubmit={submit}
          isDisabled={!model || isRunning || readingFile} aria-disabled={!model || isRunning || readingFile}
          onFiles={files => { void importTextFile(files).catch(error => notify(error instanceof Error ? error.message : 'File import failed.', 'danger')); }}
          pasteAsToken={false} style={composerInputStyle} />}
        headerActions={<FileDropzone key={activeTask} compact onFiles={importTextFile}
          label={isImageMode ? 'Import a written prompt' : isEmbeddingMode ? 'Import text to embed' : 'Import text into your message'}
          hint={isImageMode ? 'Drop a .txt or .md file, or browse · up to 64 KB' : 'Drop .txt, .md, .csv or .json, or browse · up to 64 KB'}
          accept={isImageMode ? PROMPT_FILE_ACCEPT : TEXT_FILE_ACCEPT} maxBytes={MAX_TEXT_FILE_BYTES}
          disabled={busy || readingFile} selectedName={importedFileName} />}
        footerActions={<span className="vf-composer-operation">{isRunning ? (isImageMode ? 'Creating image…' : isEmbeddingMode ? 'Creating embeddings…' : 'Replying…') : isImageMode ? 'Generate an image' : isEmbeddingMode ? 'Create embeddings' : 'Send a message'}</span>} />
    </div>
  );

  const audioComposer = (
    <AudioTranscribePanel
      model={model}
      inputOnly
      history={messages}
      ensureChat={ensureConversation}
      onSaved={loadHistory}
      onCompleted={() => setConversationStarted(true)}
      onBusyChange={value => { operationRef.current = value; setAudioBusy(value); }}
    />
  );
  const embeddingTester = (
    <EmbeddingSimilarityPanel
      model={model}
      ensureChat={ensureConversation}
      onSaved={loadHistory}
      onBusyChange={value => { operationRef.current = value; setEmbeddingBusy(value); }}
    />
  );

  const renderConversationMessage = (message: UiMessage, index: number) => (
    <AstryxChatMessage key={message.id} sender={message.role} avatar={message.role === 'assistant' ? <img src="/assets/brand/vibeflare-mark.webp" width={32} height={32} alt="VibeFlare" style={{ objectFit: 'contain' }} /> : undefined}>
      <ChatMessageBubble variant={message.role === 'assistant' ? 'ghost' : 'filled'}>
        {message.role === 'assistant' ? <Markdown density="compact" isStreaming={sending && message.id === messages.at(-1)?.id}>{message.content || (isEmbeddingMode ? 'Creating embeddings…' : 'Thinking…')}</Markdown> : message.content}
        <HistoryAttachments metadata={message.attachments} prompt={isImageMode && message.role === 'assistant' ? messages[index - 1]?.content ?? message.content : message.content} />
      </ChatMessageBubble>
    </AstryxChatMessage>
  );
  const results = messages.map(renderConversationMessage);
  const pendingImageTurns = isImageMode && generating && pendingImagePrompt ? [
    <AstryxChatMessage key="pending-image-user" sender="user">
      <ChatMessageBubble variant="filled">{pendingImagePrompt}</ChatMessageBubble>
    </AstryxChatMessage>,
    <AstryxChatMessage key="pending-image-assistant" sender="assistant" avatar={<img src="/assets/brand/vibeflare-mark.webp" width={32} height={32} alt="VibeFlare" style={{ objectFit: 'contain' }} />}>
      <ChatMessageBubble variant="ghost"><Markdown density="compact" isStreaming>Creating image…</Markdown></ChatMessageBubble>
    </AstryxChatMessage>,
  ] : [];
  const starters = activeTask === 'text-generation' && messages.length === 0 ? <div className="vf-starters" aria-label="Conversation starters">
    {STARTERS.map(starter => <button type="button" key={starter.title} className="vf-starter" data-vf-spotlight data-testid="vf-prompt-starter"
      onClick={() => { setInput(starter.prompt); requestAnimationFrame(() => composerRef.current?.querySelector<HTMLElement>('[contenteditable="true"], textarea')?.focus()); }}>
      <BrandArtwork name={starter.art} size={44} /><span><strong>{starter.title}</strong><small>{starter.detail}</small></span>
    </button>)}
  </div> : undefined;

  const activeConversation = conversationStarted && (activeTask === 'text-generation' || isImageMode || isAudioMode);
  const activeConversationView = activeConversation ? (
    <div className="vf-chat-conversation" data-testid="chat-conversation">
      <ChatLayout
        density="balanced"
        composer={isAudioMode ? audioComposer : promptComposer}
        emptyState={loadingHistory ? <div role="status" className="flex items-center justify-center p-8"><Spinner size="lg" /></div> : undefined}
      >
        {loadingHistory && messages.length === 0 ? null : (
          <ChatMessageList align="bottom" isStreaming={sending || generating || audioBusy}>
            {results}
            {pendingImageTurns}
            {isImageMode && imageError ? (
              <AstryxChatMessage sender="assistant" avatar={<img src="/assets/brand/vibeflare-mark.webp" width={32} height={32} alt="VibeFlare" style={{ objectFit: 'contain' }} />}>
                <ChatMessageBubble variant="ghost"><p role="alert" className="vf-inline-notice vf-inline-notice--error">{imageError}</p></ChatMessageBubble>
              </AstryxChatMessage>
            ) : null}
          </ChatMessageList>
        )}
      </ChatLayout>
    </div>
  ) : null;

  return (
    <div className={`vf-chat flex min-w-0 flex-col${activeConversation ? ' vf-chat--conversation' : ''}`} data-testid="vibeflare-chat">
      <Toast
        open={toast.open}
        onOpenChange={(open) => setToast((previous) => ({ ...previous, open }))}
        title={toast.title}
        variant={toast.variant}
      />
      <div className="vf-chat-toolbar">
        <Tabs
          className="vf-task-tabs"
          items={TASK_ITEMS.map((task) => ({ value: task.value, label: task.label, content: null, disabled: busy || readingFile }))}
          value={activeTask}
          onValueChange={handleTaskChange}
          variant="segmented"
        />
        <div className="vf-model-control" inert={busy ? true : undefined}>{loadingHistory ? <span role="status">Loading saved conversation…</span> : <ModelPicker task={activeTask} value={model} onChange={handleModelChange} />}</div>
      </div>
      <div className="vf-chat-content">
        {activeConversationView ?? (
          <TaskWorkspace task={activeTask} extras={isEmbeddingMode ? embeddingTester : starters}
            input={isAudioMode ? audioComposer : promptComposer}>
            {loadingHistory && <div role="status" className="flex items-center justify-center p-8"><Spinner size="lg" /></div>}
            {imageError && <p role="alert" className="vf-inline-notice vf-inline-notice--error">{imageError}</p>}
            {messages.length > 0 ? <ChatMessageList align="top" isStreaming={sending || embeddingBusy}>{results}</ChatMessageList> : null}
          </TaskWorkspace>
        )}
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
