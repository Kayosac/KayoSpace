/** Чат с ИИ на доске (решение 0019): переписка лежит на хабе — продолжается с любого устройства. */

import { hubCall, type Hub } from './devices';

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  at: number;
  changes?: number;
  error?: boolean;
}

export async function chatMessages(hub: Hub, board: string): Promise<ChatMessage[]> {
  const r = await hubCall<{ messages: ChatMessage[] }>(
    fetch,
    hub.url,
    `/api/ai/chat/${encodeURIComponent(board)}`,
    { token: hub.token },
  );
  return r.messages ?? [];
}

export async function clearChat(hub: Hub, board: string): Promise<void> {
  await hubCall(fetch, hub.url, `/api/ai/chat/${encodeURIComponent(board)}`, {
    method: 'DELETE',
    token: hub.token,
  });
}
