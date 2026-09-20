CREATE TABLE `api_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`module` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`account` text,
	`content_id` text,
	`job_id` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`images` integer,
	`cost_usd` real,
	`cost_eur` real,
	`duration_ms` integer NOT NULL,
	`status` text NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `api_calls_at_idx` ON `api_calls` (`at`);--> statement-breakpoint
CREATE INDEX `api_calls_account_idx` ON `api_calls` (`account`);--> statement-breakpoint
CREATE INDEX `api_calls_module_idx` ON `api_calls` (`module`);--> statement-breakpoint
CREATE TABLE `contents` (
	`id` text PRIMARY KEY NOT NULL,
	`account` text NOT NULL,
	`source_dir` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `contents_account_idx` ON `contents` (`account`);--> statement-breakpoint
CREATE INDEX `contents_status_idx` ON `contents` (`status`);--> statement-breakpoint
CREATE TABLE `feedback` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content_id` text NOT NULL,
	`target` text NOT NULL,
	`text` text NOT NULL,
	`created_at` text NOT NULL,
	`resulting_job_id` integer,
	FOREIGN KEY (`content_id`) REFERENCES `contents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resulting_job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `feedback_content_idx` ON `feedback` (`content_id`);--> statement-breakpoint
CREATE TABLE `job_steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`step` text NOT NULL,
	`status` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`duration_ms` integer,
	`cost_usd` real,
	`error` text,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `job_steps_job_idx` ON `job_steps` (`job_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content_id` text NOT NULL,
	`kind` text DEFAULT 'pipeline' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`current_step` text,
	`attempt` integer DEFAULT 1 NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`content_id`) REFERENCES `contents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `jobs_content_idx` ON `jobs` (`content_id`);--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`);