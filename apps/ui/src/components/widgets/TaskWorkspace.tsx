import type { ReactNode } from 'react';
import { BrandArtwork, type ArtworkName } from '../brand/BrandArtwork';

export const TASK_PRESENTATION: Record<string, { title: string; description: string; art: ArtworkName; help: string; prompt: string }> = {
  'text-generation': {
    title: 'What do you want to make?', art: 'lightning-glass',
    description: 'Ask a question, develop an idea or work on a draft. Type below or drop a text file into your message.',
    help: 'Text files are read into your message. Review their content before sending.', prompt: 'Ask anything',
  },
  'text-to-image': {
    title: 'Create an image', art: 'template-panels',
    description: 'Describe the image you have in mind. Your prompt and generated images will be saved together in History.',
    help: 'Import a written prompt from a text file. Reference-image editing is not supported in this tab.', prompt: 'Describe the image you want…',
  },
  'text-embeddings': {
    title: 'Text for smarter search', art: 'database-stack',
    description: 'Embeddings turn text into numbers that help apps find content by meaning. Get a downloadable search vector, not a chat reply.',
    help: 'For example, “refund policy” can match “How do I get my money back?” Use the downloaded vectors in semantic search or a retrieval system.', prompt: 'Enter the text you want to turn into an embedding…',
  },
  'automatic-speech-recognition': {
    title: 'Turn audio into text', art: 'workflow-panels',
    description: 'Drop a recording to transcribe it. Your original audio and transcript will be saved together in History.',
    help: 'This tab accepts recorded files. Live-streaming-only models such as Deepgram Flux are not shown; choose Whisper or Nova-3 for files.', prompt: '',
  },
};

/** Stable zero-state and non-chat task geometry. Active Text, Image and Audio conversations
 * switch to Astryx ChatLayout in ChatPage, where messages sit above the docked composer. */
export function TaskWorkspace({ task, input, children, extras }: { task: string; input: ReactNode; children?: ReactNode; extras?: ReactNode }) {
  const info = TASK_PRESENTATION[task] ?? TASK_PRESENTATION['text-generation']!;
  return <section className="vf-task-workspace" data-testid="task-workspace" data-task={task} aria-labelledby="task-heading">
    <header className="vf-task-heading" data-testid="task-heading">
      <div className="vf-welcome-emblem"><BrandArtwork name={info.art} size={56} /></div>
      <h1 id="task-heading">{info.title}</h1>
      <p>{info.description}</p>
    </header>
    <div className="vf-task-input" data-testid="task-input">{input}</div>
    <div className="vf-task-help" data-testid="task-explanation"><p>{info.help}</p></div>
    {extras}
    <div className="vf-task-results" data-testid="task-results">{children}</div>
  </section>;
}
