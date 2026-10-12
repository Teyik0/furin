export interface Todo {
  completed: boolean;
  createdAt: string;
  id: string;
  title: string;
}

export type TodoFilter = "all" | "active" | "completed";
export type TodoSyncStatus = "connecting" | "reconnecting" | "connected";
