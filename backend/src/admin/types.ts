export const adminRoles = ["admin", "moderator"] as const;
export type AdminRole = (typeof adminRoles)[number];

export type AdminSession = {
  id: string;
  role: AdminRole;
  csrfHash: string;
};

export type Moderator = {
  id: string;
  email: string;
  role: AdminRole;
  active: boolean;
};

export type ModerationPost = {
  id: string;
  displayName: string;
  body: string;
  category: string | null;
  createdAt: Date;
  rejectedAt?: Date | null;
};

export type BannedTerm = {
  term: string;
  type: string;
};

export type AdminAnalytics = {
  semesterId: string | null;
  totals: {
    posts: number;
    likes: number;
    reports: number;
    achievedGoals: number;
  };
  moderation: {
    live: number;
    held: number;
    hidden: number;
    rejected: number;
    removed: number;
  };
};

export type AdminApi = {
  login: (
    email: string,
    password: string,
    ip: string,
  ) => Promise<{ sessionToken: string; csrfToken: string }>;
  getSession: (token: string) => Promise<AdminSession | null>;
  logout: (token: string) => Promise<void>;
  recordAuthorizationFailure: (actorId: string) => Promise<void>;
  listModerators: () => Promise<Moderator[]>;
  createModerator: (
    email: string,
    password: string,
    role: AdminRole,
    actorId: string,
  ) => Promise<Moderator>;
  deleteModerator: (id: string, actorId: string) => Promise<void>;
  getModerationQueue: () => Promise<ModerationPost[]>;
  getRejectedPosts: () => Promise<ModerationPost[]>;
  approvePost: (id: string, moderatorId: string) => Promise<void>;
  rejectPost: (id: string, moderatorId: string) => Promise<void>;
  undoModeration: (id: string, moderatorId: string) => Promise<void>;
  restoreRejectedPost: (id: string, moderatorId: string) => Promise<void>;
  purgeRejectedPosts: () => Promise<number>;
  purgeExpiredAuthData: () => Promise<number>;
  getBannedTerms: () => Promise<BannedTerm[]>;
  replaceBannedTerms: (terms: BannedTerm[], actorId: string) => Promise<void>;
  getCategories: () => Promise<string[]>;
  replaceCategories: (categories: string[], actorId: string) => Promise<void>;
  featurePost: (id: string, actorId: string) => Promise<void>;
  unfeaturePost: (id: string, actorId: string) => Promise<void>;
  getAnalytics: (semesterId: string | null) => Promise<AdminAnalytics>;
  archiveSemester: (id: string, actorId: string) => Promise<void>;
};
