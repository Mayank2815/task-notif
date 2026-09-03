export interface TeamworkUser {
  id: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  handle?: string;
}

export interface TeamworkTask {
  id: number;
  name: string;
  description?: string;
  status?: string;
  completed?: boolean;
  dueDate?: string | null;
  createdAt?: string;
  updatedAt?: string;
  projectId?: number;
  projectName?: string;
  assigneeIds: number[];
  followerIds: number[];
  url: string;
  workflowId?: number;
  stageId?: number;
  /** Subtasks carry no board column of their own — the parent holds it. */
  parentTaskId?: number;
  /** Board column, e.g. "Ready for QA". Resolved separately — tasks carry only the id. */
  stageName?: string;
}

export interface TeamworkComment {
  id: number;
  taskId: number;
  authorId: number | null;
  body: string;
  htmlBody: string;
  postedAt: string | null;
  url: string;
}

/** Raw v3 envelope: entities plus a sideloaded `included` map. */
export interface V3Envelope<T> {
  included?: Record<string, Record<string, unknown>>;
  meta?: { page?: { hasMore?: boolean; page?: number; pageSize?: number; count?: number } };
  [key: string]: unknown;
}

export interface TeamworkActivity {
  id: number;
  userId: number;
  activityType: string;
  dateTime: string;
  description: string;
  extraDescription?: string;
  itemId?: number;
  itemType?: string;
  projectId?: number;
  link?: string;
}
