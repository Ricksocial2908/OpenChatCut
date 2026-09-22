import { parseShortCommand } from '../../shorts/shortCommands';

export function hasPendingComposerAttachment(
  pasting: boolean | undefined,
  pendingAttachmentCount: number,
): boolean {
  return pasting === true || pendingAttachmentCount > 0;
}

/** Local short-movie commands can send with no model. Pending imports still block. */
export function composerCanSendLocal(input: {
  value: string;
  running: boolean;
  attachmentsPending: boolean;
  modelReady: boolean;
}): boolean {
  const local = parseShortCommand(input.value) !== null;
  return !!input.value.trim() && !input.running && !input.attachmentsPending && (input.modelReady || local);
}

export function shouldSubmitComposerOnKeyDown(
  key: string,
  shiftKey: boolean,
  canSend: boolean,
): boolean {
  return key === 'Enter' && !shiftKey && canSend;
}
