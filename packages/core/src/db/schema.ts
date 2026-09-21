import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Horodatages en ISO 8601 (texte) : lisibles directement dans SQLite et dans le dashboard.
const now = () => new Date().toISOString();

export const CONTENT_STATUSES = [
  'pending',
  'processing',
  'ready',
  'failed',
  'interrupted',
] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

export const JOB_KINDS = ['pipeline', 'feedback'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'interrupted'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const STEP_STATUSES = ['running', 'done', 'failed', 'skipped'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const PIPELINE_STEPS = [
  'ingest',
  'tag',
  'edl',
  'render',
  'thumbnail',
  'captions',
  'qc',
  'deliver',
  'notify',
] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

export const API_MODULES = ['tagging', 'edl', 'captions', 'image', 'judge'] as const;
export type ApiModule = (typeof API_MODULES)[number];

export const API_PROVIDERS = ['gemini', 'anthropic', 'kie', 'ideogram'] as const;
export type ApiProvider = (typeof API_PROVIDERS)[number];

export const FEEDBACK_TARGETS = ['video', 'thumbnail'] as const;
export type FeedbackTarget = (typeof FEEDBACK_TARGETS)[number];

/** Un contenu = un sous-dossier daté de /raw/<compte>/, du brut au livrable. */
export const contents = sqliteTable(
  'contents',
  {
    id: text('id').primaryKey(), // ex. tcg-2026-09-20-a3f9
    account: text('account').notNull(),
    sourceDir: text('source_dir').notNull(),
    status: text('status', { enum: CONTENT_STATUSES }).notNull().default('pending'),
    version: integer('version').notNull().default(1),
    createdAt: text('created_at').notNull().$defaultFn(now),
    updatedAt: text('updated_at').notNull().$defaultFn(now),
  },
  (t) => [index('contents_account_idx').on(t.account), index('contents_status_idx').on(t.status)],
);

/** Une exécution du pipeline (ou une relance sur feedback) pour un contenu. */
export const jobs = sqliteTable(
  'jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    contentId: text('content_id')
      .notNull()
      .references(() => contents.id),
    kind: text('kind', { enum: JOB_KINDS }).notNull().default('pipeline'),
    status: text('status', { enum: JOB_STATUSES }).notNull().default('queued'),
    currentStep: text('current_step', { enum: PIPELINE_STEPS }),
    attempt: integer('attempt').notNull().default(1),
    error: text('error'),
    createdAt: text('created_at').notNull().$defaultFn(now),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
  },
  (t) => [index('jobs_content_idx').on(t.contentId), index('jobs_status_idx').on(t.status)],
);

/** Journal d'exécution : une ligne par étape par tentative (cahier : horodatage, étape, statut, erreur). */
export const jobSteps = sqliteTable(
  'job_steps',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobId: integer('job_id')
      .notNull()
      .references(() => jobs.id),
    step: text('step', { enum: PIPELINE_STEPS }).notNull(),
    status: text('status', { enum: STEP_STATUSES }).notNull(),
    attempt: integer('attempt').notNull().default(1),
    startedAt: text('started_at').notNull().$defaultFn(now),
    finishedAt: text('finished_at'),
    durationMs: integer('duration_ms'),
    costUsd: real('cost_usd'),
    error: text('error'),
  },
  (t) => [index('job_steps_job_idx').on(t.jobId)],
);

/** Chaque appel API, pour l'historique de facturation par date, module et compte. */
export const apiCalls = sqliteTable(
  'api_calls',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: text('at').notNull().$defaultFn(now),
    module: text('module', { enum: API_MODULES }).notNull(),
    provider: text('provider', { enum: API_PROVIDERS }).notNull(),
    model: text('model').notNull(),
    account: text('account'),
    contentId: text('content_id'),
    jobId: integer('job_id'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    images: integer('images'),
    costUsd: real('cost_usd'), // null si le modèle n'est pas dans la grille tarifaire
    costEur: real('cost_eur'),
    durationMs: integer('duration_ms').notNull(),
    status: text('status', { enum: ['ok', 'error'] }).notNull(),
    error: text('error'),
  },
  (t) => [
    index('api_calls_at_idx').on(t.at),
    index('api_calls_account_idx').on(t.account),
    index('api_calls_module_idx').on(t.module),
  ],
);

/** Feedback texte libre de Markus, qui déclenche une relance corrigée. */
export const feedback = sqliteTable(
  'feedback',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    contentId: text('content_id')
      .notNull()
      .references(() => contents.id),
    target: text('target', { enum: FEEDBACK_TARGETS }).notNull(),
    text: text('text').notNull(),
    createdAt: text('created_at').notNull().$defaultFn(now),
    resultingJobId: integer('resulting_job_id').references(() => jobs.id),
  },
  (t) => [index('feedback_content_idx').on(t.contentId)],
);

export type Content = typeof contents.$inferSelect;
export type NewContent = typeof contents.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type JobStep = typeof jobSteps.$inferSelect;
export type NewJobStep = typeof jobSteps.$inferInsert;
export type ApiCall = typeof apiCalls.$inferSelect;
export type NewApiCall = typeof apiCalls.$inferInsert;
export type Feedback = typeof feedback.$inferSelect;
export type NewFeedback = typeof feedback.$inferInsert;
