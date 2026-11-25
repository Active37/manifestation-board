export type NewPostInput = {
  displayName: string;
  body: string;
  category: string | null;
};

export const progressStatuses = [
  "not_started",
  "in_progress",
  "achieved",
] as const;
export type ProgressStatus = (typeof progressStatuses)[number];

export const badgeTypes = ["goal_achieved"] as const;
export type BadgeType = (typeof badgeTypes)[number];

export type ProgressUpdate = {
  progressStatus: ProgressStatus;
  badges: BadgeType[];
};

export type CreatedPost = {
  id: string;
  displayName: string;
  body: string;
  category: string | null;
  progressStatus: ProgressStatus;
  editKey: string;
};

export type EditedPost = Omit<CreatedPost, "editKey">;

export type PatchPostInput = Partial<NewPostInput>;

export const feedSorts = [
  "shuffle",
  "newest",
  "most-liked-today",
  "most-liked-all-time",
] as const;

export type FeedSort = (typeof feedSorts)[number];

export type FeedQuery = {
  sort?: FeedSort;
  search?: string;
  category?: string;
  cursor?: string;
};

export type FeedPost = {
  id: string;
  displayName: string;
  body: string;
  category: string | null;
  progressStatus: ProgressStatus;
  badges: BadgeType[];
  likeCount: number;
  createdAt: string;
};

export type FeedPage = {
  posts: FeedPost[];
  nextCursor: string | null;
};

export type ArchivedSemester = {
  id: string;
  name: string;
  endsOn: string;
};

export const reportReasons = [
  "offensive",
  "sexual",
  "harassment",
  "spam",
  "other",
] as const;

export type ReportReason = (typeof reportReasons)[number];

export type PostsApi = {
  verifyCaptcha: (token: string) => Promise<boolean>;
  checkPostRateLimit: (deviceId: string, ip: string) => Promise<void>;
  checkNameRateLimit: (ip: string) => Promise<void>;
  createPost: (
    post: NewPostInput,
    captchaTokenHash: string,
  ) => Promise<CreatedPost>;
  patchPost: (
    id: string,
    editKey: string,
    patch: PatchPostInput,
  ) => Promise<EditedPost>;
  updateProgress: (
    id: string,
    editKey: string,
    progressStatus: ProgressStatus,
  ) => Promise<ProgressUpdate>;
  deletePost: (id: string, editKey: string) => Promise<void>;
  addLike: (id: string, deviceId: string, ip: string) => Promise<void>;
  removeLike: (id: string, deviceId: string, ip: string) => Promise<void>;
  reportPost: (
    id: string,
    deviceId: string,
    ip: string,
    reason: ReportReason,
    detail: string | null,
  ) => Promise<void>;
  listPosts: (query: FeedQuery) => Promise<FeedPage>;
  listAchievedPosts: () => Promise<FeedPost[]>;
  listFeaturedPosts: () => Promise<FeedPost[]>;
  getRandomPost: () => Promise<FeedPost | null>;
  listCategories: () => Promise<string[]>;
  listArchivedSemesters: () => Promise<ArchivedSemester[]>;
  listArchivedSemesterPosts: (
    semesterId: string,
    cursor?: string,
  ) => Promise<FeedPage>;
};
