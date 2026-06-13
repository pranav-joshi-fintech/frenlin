import * as vscode from 'vscode';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  emotion?: string;
  timestamp: number;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
}

function uid(): string {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

export class ConversationStore {
  private readonly STORE_KEY = 'mommyasmr.v2.conversations';
  private readonly CUR_KEY   = 'mommyasmr.v2.currentId';
  private _convos: Map<string, Conversation>;
  private _currentId: string;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    const saved = ctx.globalState.get<Record<string, Conversation>>(this.STORE_KEY, {});
    this._convos = new Map(Object.entries(saved));
    if (this._convos.size === 0) {
      this._currentId = this._create();
    } else {
      this._currentId = ctx.globalState.get<string>(this.CUR_KEY, [...this._convos.keys()][0]);
      if (!this._convos.has(this._currentId)) {
        this._currentId = [...this._convos.keys()][0];
      }
    }
  }

  private _create(): string {
    const id = uid();
    const now = Date.now();
    this._convos.set(id, { id, title: 'New session', createdAt: now, updatedAt: now, messages: [] });
    this._currentId = id;
    this._save();
    return id;
  }

  createConversation(): string { return this._create(); }

  deleteConversation(id: string): void {
    this._convos.delete(id);
    if (this._convos.size === 0) { this._create(); }
    else if (this._currentId === id) {
      this._currentId = [...this._convos.keys()].sort((a, b) =>
        (this._convos.get(b)!.updatedAt) - (this._convos.get(a)!.updatedAt))[0];
    }
    this._save();
  }

  renameConversation(id: string, title: string): void {
    const c = this._convos.get(id);
    if (c) { c.title = title.trim() || c.title; this._save(); }
  }

  addMessage(id: string, role: 'user' | 'assistant', content: string, emotion?: string): void {
    const c = this._convos.get(id);
    if (!c) { return; }
    // Auto-name from first user message
    if (role === 'user' && c.title === 'New session' && c.messages.length === 0) {
      c.title = content.slice(0, 45) + (content.length > 45 ? '…' : '');
    }
    c.messages.push({ id: uid(), role, content, emotion, timestamp: Date.now() });
    c.updatedAt = Date.now();
    this._save();
  }

  getMessages(id: string): Message[] {
    return this._convos.get(id)?.messages ?? [];
  }

  getAllConversations(): Conversation[] {
    return [...this._convos.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getCurrentId(): string { return this._currentId; }

  setCurrentId(id: string): void {
    this._currentId = id;
    this.ctx.globalState.update(this.CUR_KEY, id);
  }

  private _save(): void {
    const obj: Record<string, Conversation> = {};
    for (const [k, v] of this._convos) { obj[k] = v; }
    this.ctx.globalState.update(this.STORE_KEY, obj);
    this.ctx.globalState.update(this.CUR_KEY, this._currentId);
  }
}
