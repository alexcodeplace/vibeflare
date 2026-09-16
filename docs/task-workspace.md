# Audio uploads, shared task layout and file drops

## Regular/Pro task presentation (2026-09-14)

[The maintained VF-V02/VF-S05/VF-I02/04 matrix](design/VISIBLE-CONTROLS.md#vibeflare-screen-matrix)
is binding. Text/Image/Embeddings/Audio are task types, separate from Regular/Pro.
Regular uses clear explanations and common task inputs; Pro exposes supported
schema-backed request parameters from first onboarding onward. Both retain the
same drop validation, model capability/access rules, layout, results and failures.
Choosing Pro does not execute a request, broaden model access or change file data.
Inspect reveals safe request/result/artifact metadata, not credentials, whole
conversations or another user's files. Existing capability limits below still apply.

## User requirements — 2026-09-13

Fix the Audio tab's `@cf/deepgram/flux only supports websocket connections` failure; retain similar layout across Text, Image, Embeddings and Audio; provide a drag-and-drop zone rather than only Browse; explain embeddings in the tab. Complete this alongside the pending media-history fix, merge tested work and leave only `main` as a branch.

## Audio contract

File uploads and live voice streams are different capabilities, independent of paid/free access or personal model visibility. Deepgram Flux remains in the global catalog and Settings but is not selectable by the file-transcription picker. A stale/direct Flux upload receives an actionable 400 before model execution, storage or quota work. The picker prefers selected Whisper Turbo, Whisper and Nova-3 models in that order; it does not silently enable a deselected model.

Whisper/Tiny accept byte arrays. Turbo uses base64. Nova-3 receives the documented `{ audio: { body, contentType } }` binary stream. The server normalizes Nova's `results.channels[].alternatives[0].transcript` as well as Whisper's direct `text` response; it no longer misreports valid Nova output as missing. Empty, oversized (>25 MB) and non-audio input is rejected. Transport mismatch errors remain client errors, not model-health failures.

The browser displays the server's readable message, not serialized JSON or an unbounded HTML error page. Failed requests preserve the selected file for retry. Completed uploads retain the audio and transcript via the shared owned-history mechanism.

Primary references verified on 2026-09-13:

- Flux's explicit WebSocket-only contract: https://developers.cloudflare.com/changelog/post/2025-10-02-deepgram-flux/
- Nova-3 HTTP versus realtime capabilities and schema: https://developers.cloudflare.com/workers-ai/models/nova-3/
- Nova binding example: https://blog.cloudflare.com/workers-ai-partner-models/
- Whisper/Turbo schema: https://developers.cloudflare.com/workers-ai/models/whisper/ and https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/
- Generated official types also verified in the locked `@cloudflare/workers-types` dependency.

## Stable layout and actual file behavior

`TaskWorkspace` owns the shared landing geometry and non-conversation task entry. Before the first request, all four tasks use the centered task landing. After the first text message, image request or audio transcription creates a conversation, Text, Image and Audio must switch to Astryx's **AI Chat Conversation** composition (`ChatLayout` + `ChatMessageList`) instead of leaving the landing shell in place. Text and Image keep the message composer docked at the bottom; Image switches immediately on Generate, shows the submitted prompt plus a generating assistant turn above that composer, then replaces the pending state with durable image history. Audio docks the recording-file/transcribe composer in the same slot, renders the source audio as the user turn and the transcript as the assistant turn, and keeps newest turns nearest the composer. Long histories scroll inside the conversation. Reopening a saved Text, Image or Audio chat enters conversation layout directly. Starting a new chat or switching tasks returns to the landing/task layout. Reference: https://astryx.atmeta.com/templates?preview=ai-chat.

Embeddings retain the stable task input/results geometry. Image and Audio share that same landing geometry before their first request, then use the same Astryx conversation shell as Text. The toolbar and model selector remain stable across task switches. Narrow screens keep the same stacked toolbar and input geometry; reduced-motion, focus and forced-colors behavior remain supported. Club artwork and semantic brand tokens are reused.

`FileDropzone` is the shared keyboard-accessible drop/browse primitive. It validates both selection paths, rejects duplicate work and allows a task callback instead of automatically uploading every dropped file. Ordinary Files-page uploads retain their existing behavior.

- Text: import UTF-8 text/Markdown/CSV/JSON into the actual message, visibly editable before Send.
- Image: import a written .txt/.md prompt. The tab explicitly says reference-image editing is not implemented; it does not pretend to use an ignored image attachment.
- Embeddings: import UTF-8 text and feed that content to the embeddings endpoint.
- Audio: select/drop a recording, review its filename/size, remove it or transcribe it.

Text imports are limited to 64 KB and 16,000 combined characters, with errors instead of silent truncation. No inference starts on a drop. A text import is prompt content, not a file ID the model silently ignores. PDFs/binary images are not accepted as text input.

## Embeddings explanation

The tab is still named Embeddings for users who know it, while its heading reads **Text for smarter search**. It exposes two real workflows against `/v1/embeddings`: **Vector** preserves the existing single-text vector generation/download flow, while **Similarity test** embeds one query plus comparison texts in the same batch and ranks the candidates by cosine similarity. The UI must label the score as cosine similarity rather than probability, keep the complete embedding JSON downloadable, and save the comparison result in conversation history so reload/reopen is still testable. An example shows how a refund-policy query can match differently worded content. The tab does not claim to create a search index or run a vector database automatically.

Reference: https://developers.cloudflare.com/vectorize/

## Regression coverage

`audio_upload.test.ts` verifies transport rejection, model-specific request bodies, nested/direct response normalization, file validation and readable error classification. `media_history.test.ts` covers Nova's full uploaded-file contract and its durable transcript, as well as all earlier media persistence/privacy tests.

`FileDropzone.test.tsx` covers drop/browse parity, invalid input, duplicate operations, actual file delivery, legacy uploads and UTF-8 import. `UI-task-workspace.spec.ts` compares landing geometry across tasks at 1440, 390 and 320px in both themes, confirms displayed explanations, checks live-only exclusion, performs actual drop-to-model input flows, exercises the raw-vector and cosine-similarity embedding modes, verifies Whisper/Nova upload shapes through deterministic fixtures and retries readable failures without losing the recording. `UJ-004-browser-chat.spec.ts` verifies Text conversation behavior. Media-history coverage verifies that Image switches before generation completes, keeps the submitted prompt and generated media above the bottom composer, and reopens saved image chats directly in conversation mode. The same coverage verifies that Audio switches after its first completed transcription, keeps the audio source and transcript above the bottom composer, and reopens saved audio chats directly in conversation mode.

These regression tests use the isolated local Worker, database, bucket and mock model binding, not paid production inference.
