import * as vscode from 'vscode';

export type TodoStatus = 'todo' | 'in-progress' | 'done';

export interface Todo {
  id: string;
  text: string;
  status: TodoStatus;
  createdAt: number;
  updatedAt: number;
}

/** One AI-issued (or UI-issued) operation on the todo list. */
export interface TodoAction {
  action: 'add' | 'move' | 'delete' | 'complete';
  id?: string;
  text?: string;
  status?: TodoStatus;
}

const STATUSES: TodoStatus[] = ['todo', 'in-progress', 'done'];

function uid(): string {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

/**
 * Persistent todo store backed by globalState (mirrors ConversationStore's pattern).
 * Insertion order is preserved across sessions because we persist a plain array.
 */
export class TodoManager {
  private readonly KEY = 'frenlin.todos.v1';
  private _todos: Todo[];

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this._todos = ctx.globalState.get<Todo[]>(this.KEY, []) ?? [];
  }

  list(): Todo[] {
    return this._todos;
  }

  add(text: string): Todo | undefined {
    const clean = (text || '').trim();
    if (!clean) { return undefined; }
    const now = Date.now();
    const todo: Todo = { id: uid(), text: clean, status: 'todo', createdAt: now, updatedAt: now };
    this._todos.push(todo);
    this._save();
    return todo;
  }

  move(id: string, status: TodoStatus): boolean {
    const todo = this._todos.find(t => t.id === id);
    if (!todo || !STATUSES.includes(status)) { return false; }
    todo.status = status;
    todo.updatedAt = Date.now();
    this._save();
    return true;
  }

  complete(id: string): boolean {
    return this.move(id, 'done');
  }

  remove(id: string): boolean {
    const i = this._todos.findIndex(t => t.id === id);
    if (i === -1) { return false; }
    this._todos.splice(i, 1);
    this._save();
    return true;
  }

  /** Resolve a reference that may be an exact id OR a fragment of the task text. */
  resolveId(ref: string): string | undefined {
    const r = (ref || '').trim();
    if (!r) { return undefined; }
    if (this._todos.some(t => t.id === r)) { return r; }
    const lower = r.toLowerCase();
    const match =
      this._todos.find(t => t.text.toLowerCase() === lower) ||
      this._todos.find(t => t.text.toLowerCase().includes(lower)) ||
      this._todos.find(t => lower.includes(t.text.toLowerCase()));
    return match?.id;
  }

  /** Apply a batch of AI-issued operations; returns true if anything changed. */
  applyActions(actions: TodoAction[] | undefined): boolean {
    if (!Array.isArray(actions) || actions.length === 0) { return false; }
    let changed = false;
    for (const a of actions) {
      if (!a || typeof a.action !== 'string') { continue; }
      if (a.action === 'add') {
        if (this.add(a.text ?? '')) { changed = true; }
        continue;
      }
      const id = this.resolveId(a.id ?? a.text ?? '');
      if (!id) { continue; }
      if (a.action === 'delete') { changed = this.remove(id) || changed; }
      else if (a.action === 'complete') { changed = this.complete(id) || changed; }
      else if (a.action === 'move') { changed = this.move(id, (a.status as TodoStatus) || 'in-progress') || changed; }
    }
    return changed;
  }

  private _save(): void {
    this.ctx.globalState.update(this.KEY, this._todos);
  }
}
